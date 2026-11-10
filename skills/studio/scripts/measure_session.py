#!/usr/bin/env python3
"""Measure what a session cost and append one line to the studio ledger.

Reads a Claude Code transcript (~/.claude/projects/<project>/<session>.jsonl) or a Codex rollout
($CODEX_HOME/sessions/**/rollout-*.jsonl, where CODEX_HOME defaults to ~/.codex). Prints at most 12 lines and appends one CSV row.

  measure_session.py --latest --job my-remix --unit 01-intro --type remix --plan ~/Music/Remixes/plan.md
  measure_session.py --transcript <file.jsonl> --since "2026-11-10 09:00" --no-ledger

--latest picks the newest session for the current folder, from Claude Code or Codex, else the newest overall.
--plan splits the cost by the plan's Log lines written as "- YYYY-MM-DD HH:MM <stage>: <note>", in local time:
each stage runs from the previous timestamped line to its own.

Cost is counted two ways. tokens: every input, cache read, cache write and output token, as the usage records
report them. input_equiv: cache reads x0.1, cache writes x1.25, plain input x1, output x5, which is closer to
billed cost and to plan usage. The total is a floor: compaction requests carry no usage record.
"""
import argparse
import csv
import glob
import json
import os
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
WAIT_TOOLS = ("ui_wait_for",)
LEDGER_FIELDS = ["date", "job", "unit", "type", "source", "requests", "tokens", "input_equiv", "start_ctx", "avg_ctx",
                 "peak_ctx", "output", "compactions", "ui_calls", "tool_errors", "wait_requests", "top_stage",
                 "top_stage_tokens", "transcript"]


def parse_time(s):
    """ISO time from a transcript (UTC, 'Z') or a local 'YYYY-MM-DD HH:MM' from plan.md, as an aware datetime."""
    if not s:
        return None
    s = str(s).strip()
    try:
        if s.endswith("Z"):
            return datetime.fromisoformat(s[:-1]).replace(tzinfo=timezone.utc)
        t = datetime.fromisoformat(s.replace(" ", "T"))
        return t if t.tzinfo else t.astimezone()  # naive means local time
    except ValueError:
        return None


def read_jsonl(path):
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def claude_requests(recs):
    """One entry per API request: Claude Code splits a response over several lines with the same message id."""
    reqs, order, errors = {}, [], {}
    for n, r in enumerate(recs):
        m = r.get("message") or {}
        if r.get("type") == "assistant" and isinstance(m, dict):
            mid = m.get("id") or f"line{n}"
            if mid not in reqs:
                reqs[mid] = {"ts": parse_time(r.get("timestamp")), "usage": None, "tools": [], "ids": []}
                order.append(mid)
            q = reqs[mid]
            if m.get("usage"):
                q["usage"] = m["usage"]
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    q["tools"].append((b.get("name") or "", json.dumps(b.get("input") or {})[:400]))
                    q["ids"].append(b.get("id"))
        elif r.get("type") == "user" and isinstance(m, dict) and isinstance(m.get("content"), list):
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                    errors[b.get("tool_use_id")] = True
    out = []
    for mid in order:
        q = reqs[mid]
        u = q["usage"]
        if not u:
            continue
        out.append({
            "ts": q["ts"], "tools": q["tools"],
            "input": u.get("input_tokens", 0), "read": u.get("cache_read_input_tokens", 0),
            "write": u.get("cache_creation_input_tokens", 0), "output": u.get("output_tokens", 0),
            "errors": sum(1 for i in q["ids"] if errors.get(i)),
        })
    return out


def codex_requests(recs):
    """Best effort for Codex rollouts: one token_count event per request, last_token_usage holds that request."""
    out, last_total, pending = [], None, []
    for r in recs:
        p = r.get("payload") or {}
        if r.get("type") == "response_item" and p.get("type") in ("function_call", "custom_tool_call", "local_shell_call"):
            pending.append((p.get("name") or p.get("type"), json.dumps(p.get("arguments") or p.get("input") or "")[:400]))
        if r.get("type") == "event_msg" and p.get("type") == "token_count":
            info = p.get("info") or {}
            total = (info.get("total_token_usage") or {}).get("total_tokens")
            u = info.get("last_token_usage") or {}
            if not u or total == last_total:
                continue
            last_total = total
            cached = u.get("cached_input_tokens", 0)
            out.append({
                "ts": parse_time(r.get("timestamp")), "tools": pending,
                "input": max(0, u.get("input_tokens", 0) - cached), "read": cached, "write": 0,
                "output": u.get("output_tokens", 0) + u.get("reasoning_output_tokens", 0), "errors": 0,
            })
            pending = []
    return out


def ctx(q):
    return q["input"] + q["read"] + q["write"]


def tokens(q):
    return ctx(q) + q["output"]


def equiv(q):
    return q["read"] * 0.1 + q["write"] * 1.25 + q["input"] + q["output"] * 5


def is_wait(q):
    if not q["tools"]:
        return False
    for name, inp in q["tools"]:
        if name.endswith(WAIT_TOOLS):
            continue
        if name in ("Bash", "local_shell_call", "shell") or name.endswith("device_bash"):
            if re.search(r"\bsleep\b|wait_status", inp):
                continue
        return False
    return True


def codex_cwd(path):
    """The working folder a Codex rollout recorded in its session_meta line, or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for _ in range(5):
                line = f.readline()
                if not line:
                    break
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("type") == "session_meta":
                    return (rec.get("payload") or {}).get("cwd")
    except OSError:
        pass
    return None


def find_latest():
    cwd = os.getcwd()
    cwd_key = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    claude_all = glob.glob(str(HOME / ".claude/projects/*/*.jsonl"))
    codex_home = Path(os.environ.get("CODEX_HOME") or HOME / ".codex")
    codex_all = glob.glob(str(codex_home / "sessions/**/rollout-*.jsonl"), recursive=True)
    folders = {cwd, os.path.realpath(cwd)}
    here = glob.glob(str(HOME / ".claude/projects" / cwd_key / "*.jsonl"))
    here += [p for p in codex_all if codex_cwd(p) in folders]
    if here:
        return max(here, key=os.path.getmtime)
    pool = claude_all + codex_all
    return max(pool, key=os.path.getmtime) if pool else None


def stage_marks(plan):
    """[(time, stage name)] from timestamped Log lines in plan.md."""
    marks = []
    for line in Path(plan).expanduser().read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^\s*-\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})\s+([^:]{1,60}):", line)
        if m and parse_time(m.group(1)):
            marks.append((parse_time(m.group(1)), m.group(2).strip()))
    return sorted(marks)


def ledger_path(explicit):
    if explicit:
        return Path(explicit).expanduser()
    return Path(os.environ.get("STUDIO_LEARNING_DIR") or HOME / ".studio" / "learning") / "ledger.csv"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--transcript")
    src.add_argument("--latest", action="store_true")
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--plan")
    ap.add_argument("--job", default="")
    ap.add_argument("--unit", default="")
    ap.add_argument("--type", default="")
    ap.add_argument("--ledger", help="CSV to append to (default: ~/.studio/learning/ledger.csv, or ledger.csv in $STUDIO_LEARNING_DIR)")
    ap.add_argument("--no-ledger", action="store_true")
    a = ap.parse_args()

    path = a.transcript and str(Path(a.transcript).expanduser()) or find_latest()
    if not path or not os.path.exists(path):
        print("FAIL no transcript found. Pass --transcript <file.jsonl>.")
        return 1
    recs = read_jsonl(path)
    source = "codex" if any(r.get("type") == "event_msg" for r in recs[:200]) else "claude"
    R = codex_requests(recs) if source == "codex" else claude_requests(recs)
    since, until = parse_time(a.since), parse_time(a.until)
    R = [q for q in R if (not since or (q["ts"] and q["ts"] >= since)) and (not until or (q["ts"] and q["ts"] <= until))]
    if not R:
        print(f"FAIL no usage records in {path} for that window. The format may have changed.")
        return 1

    cs = [ctx(q) for q in R]
    total, eq = sum(map(tokens, R)), sum(map(equiv, R))
    compactions = sum(1 for i in range(1, len(cs)) if cs[i] < cs[i - 1] - 40000)
    ui_calls = sum(1 for q in R for name, _ in q["tools"] if "ui_" in name or "creator-studio" in name)
    tool_errors = sum(q["errors"] for q in R)
    waits = [q for q in R if is_wait(q)]
    reads = sum(q["read"] for q in R)

    stages = []
    if a.plan and Path(a.plan).expanduser().exists():
        prev = None
        for t, name in stage_marks(a.plan):
            part = [q for q in R if q["ts"] and (prev is None or q["ts"] > prev) and q["ts"] <= t]
            if part:
                stages.append((name, len(part), sum(map(tokens, part))))
            prev = t
        tail = [q for q in R if q["ts"] and prev and q["ts"] > prev]
        if stages and tail:
            stages.append(("after last log line", len(tail), sum(map(tokens, tail))))
    top = max(stages, key=lambda s: s[2]) if stages else ("", 0, 0)

    m = lambda x: f"{x / 1e6:.2f}M"
    k = lambda x: f"{x / 1e3:.0f}k"
    print(f"{source} session: {len(R)} requests, {m(total)} tokens ({100 * reads / max(total, 1):.0f}% cache reads), "
          f"{m(eq)} input-equivalent")
    print(f"context: start {k(cs[0])}, average {k(statistics.mean(cs))}, peak {k(max(cs))}, {compactions} compactions")
    print(f"tools: {ui_calls} UI calls, {tool_errors} tool errors, {len(waits)} requests that only waited "
          f"({m(sum(map(tokens, waits)))})")
    for name, n, t in sorted(stages, key=lambda s: -s[2])[:4]:
        print(f"stage {name}: {n} requests, {m(t)}")
    if a.plan and not stages:
        print("no stage split: plan.md has no '- YYYY-MM-DD HH:MM <stage>: ...' log lines in this window")

    if not a.no_ledger:
        lp = ledger_path(a.ledger)
        lp.parent.mkdir(parents=True, exist_ok=True)
        new = not lp.exists()
        with open(lp, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=LEDGER_FIELDS)
            if new:
                w.writeheader()
            w.writerow({"date": datetime.now().strftime("%Y-%m-%d %H:%M"), "job": a.job, "unit": a.unit, "type": a.type,
                        "source": source, "requests": len(R), "tokens": total, "input_equiv": round(eq),
                        "start_ctx": cs[0], "avg_ctx": round(statistics.mean(cs)), "peak_ctx": max(cs),
                        "output": sum(q["output"] for q in R), "compactions": compactions, "ui_calls": ui_calls,
                        "tool_errors": tool_errors, "wait_requests": len(waits), "top_stage": top[0],
                        "top_stage_tokens": top[2], "transcript": path})
        print(f"ledger: {lp}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
