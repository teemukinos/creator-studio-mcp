#!/usr/bin/env python3
"""Drive a Craft `*-cli mcp` server over stdio JSON-RPC and run one tool call.

Usage:
  mcp_stdio_check.py --tool command_run --args '{"id": "...", "params": {...}}' -- <server command...>

Prints PASS or FAIL lines and a JSON summary. The server command is run as given,
for example: docker exec -i crafttest /opt/filmcraft/bin/filmcraft-cli mcp --demo
"""
import argparse
import json
import subprocess
import sys
import threading
import time
import queue


def reader(stream, q):
    for line in stream:
        q.put(line)
    q.put(None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tool", required=True)
    ap.add_argument("--args", default="{}")
    ap.add_argument("--timeout", type=float, default=900)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd

    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=sys.stderr, text=True, bufsize=1)
    q = queue.Queue()
    threading.Thread(target=reader, args=(p.stdout, q), daemon=True).start()

    def send(msg):
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()

    progress = []

    def wait_for(req_id, timeout):
        end = time.time() + timeout
        while time.time() < end:
            try:
                line = q.get(timeout=1)
            except queue.Empty:
                continue
            if line is None:
                raise RuntimeError("server closed stdout")
            msg = json.loads(line)
            if msg.get("method") == "notifications/progress":
                progress.append(msg["params"])
                continue
            if msg.get("id") == req_id:
                return msg
        raise TimeoutError(f"no reply to request {req_id}")

    t0 = time.time()
    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "studio-craft-check", "version": "0.1"}}})
    init = wait_for(1, 60)
    info = init.get("result", {}).get("serverInfo")
    print(("PASS" if "result" in init else "FAIL"), "initialize", json.dumps(info))
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tl = wait_for(2, 60)
    names = [t["name"] for t in tl.get("result", {}).get("tools", [])]
    print(("PASS" if names else "FAIL"), "tools/list", len(names), "tools:", ", ".join(names))

    t1 = time.time()
    send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
        "name": a.tool, "arguments": json.loads(a.args), "_meta": {"progressToken": "chk"}}})
    res = wait_for(3, a.timeout)
    t2 = time.time()
    r = res.get("result", {})
    ok = "result" in res and not r.get("isError")
    text = " ".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
    print(("PASS" if ok else "FAIL"), "tools/call", a.tool, f"{t2 - t1:.1f}s",
          f"progress notifications: {len(progress)}")
    print(text[:2000] if text else json.dumps(res)[:2000])
    p.stdin.close()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
    print(json.dumps({"ok": ok, "tools": len(names), "call_seconds": round(t2 - t1, 1),
                      "total_seconds": round(time.time() - t0, 1),
                      "last_progress": progress[-1] if progress else None}))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
