#!/usr/bin/env bash
# Score this repository against its release checklist.
#
#   scripts/verify.sh [--skip N[,N...]]
#
# Prints one line per check (PASS, FAIL or SKIP, with a short reason), then "SCORE n/N".
# A SKIP is left out of the score when CI=true; in a local run it counts as a failure.
# Full output of each check goes to .verify/logs/.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

LOGS="$ROOT/.verify/logs"
mkdir -p "$LOGS"
export npm_config_cache="$ROOT/.verify/npm-cache"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
export DISABLE_TELEMETRY=1 DO_NOT_TRACK=1

SKILL=skills/studio
REFERENCES="apple-apps blender craft godot handoffs logic remix rive ui setup"
SKIP=","
while [ $# -gt 0 ]; do
  case "$1" in
    --skip) SKIP=",${2:-},"; shift 2 ;;
    *) echo "usage: scripts/verify.sh [--skip N[,N...]]"; exit 2 ;;
  esac
done

pkg_field() { node -p "require('./package.json').$1"; }
first_error() { grep -iE 'error|fail' "$LOG" | head -n 1 | cut -c1-80; }

# 1. Every file and folder in the target layout exists.
c1() {
  local missing="" p
  local want="package.json src dist test tsconfig.json package-lock.json LICENSE README.md CONTRIBUTING.md
    .gitignore .github/workflows/ci.yml scripts/verify.sh scripts/package_skill.sh $SKILL/SKILL.md
    $SKILL/recipes/logic_render.recipe.json $SKILL/scripts/wait_status.sh $SKILL/scripts/measure_session.py
    $SKILL/learning-template/inbox.md"
  for p in $REFERENCES; do want="$want $SKILL/references/$p.md"; done
  for p in $want; do [ -e "$p" ] || missing="$missing $p"; done
  for p in "$SKILL/README.md" "$SKILL/package.json" "$SKILL/src" "$SKILL/dist"; do
    [ ! -e "$p" ] || missing="$missing forbidden:$p"
  done
  for p in node_modules .DS_Store dist-skill/ '*.ledger.csv'; do
    grep -qF -- "$p" .gitignore 2>/dev/null || missing="$missing gitignore:$p"
  done
  if [ -f LICENSE ]; then
    grep -q 'MIT License' LICENSE && grep -q 'Copyright (c) 2026 ' LICENSE || missing="$missing license-text"
  fi
  if [ -f package.json ]; then
    node -e '
      const p = require("./package.json");
      const ok = p.name === "creator-studio-mcp" && p.version === "0.7.1" && p.bin && p.files.includes("dist") && p.files.includes("README.md");
      process.exit(ok ? 0 : 1)' || missing="$missing package-fields"
  fi
  echo "missing:$missing"
  if [ -n "$missing" ]; then
    REASON="$(echo "$missing" | wc -w | tr -d ' ') missing:$(echo "$missing" | cut -c1-70)"
    return 1
  fi
  REASON="all present"
}

# 2. Clean install, build and tests pass, and the build reproduces the committed dist/.
c2() {
  npm ci || { REASON="npm ci failed: $(first_error)"; return 1; }
  npm run build || { REASON="build failed: $(first_error)"; return 1; }
  npm test || { REASON="tests failed: $(grep -E 'fail [0-9]+' "$LOG" | tail -n 1)"; return 1; }
  git diff --exit-code -- dist/ || { REASON="dist/ differs from a fresh build"; return 1; }
  REASON="$(grep -E 'pass [0-9]+' "$LOG" | tail -n 1 | sed -E 's/.*pass ([0-9]+).*/\1 tests pass/'), dist reproducible"
  return 0
}

# 3. An MCP stdio handshake returns the expected tools.
c3() {
  local out
  out="$(node --input-type=commonjs -e '
    const { spawn } = require("child_process");
    const p = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
    const finish = (code, msg) => { console.log(msg); p.kill(); process.exit(code); };
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    setTimeout(() => finish(1, "no tools/list response in 30 s"), 30000);
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (m.id === 2) {
          const tools = m.result.tools;
          const by = Object.fromEntries(tools.map((t) => [t.name, t]));
          if (tools.length < 38) finish(1, "only " + tools.length + " tools");
          if (!by.godot_cli) finish(1, "godot_cli missing");
          if (!by.ui_batch) finish(1, "ui_batch missing");
          if (!String(by.ui_batch.description).includes("requireAbsent")) finish(1, "ui_batch description lacks requireAbsent");
          finish(0, tools.length + " tools");
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } } });
  ')"
  local rc=$?
  echo "$out"
  REASON="$out"
  return $rc
}

# 4. npm pack contents.
c4() {
  local j="$LOG.json" out rc
  npm pack --dry-run --json >"$j" || { REASON="npm pack failed: $(first_error)"; return 1; }
  out="$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const r = Array.isArray(j) ? j[0] : Object.values(j)[0];
    const v = require("./package.json").version;
    const files = r.files.map((f) => f.path);
    const lack = ["dist/index.js", "README.md", "LICENSE"].filter((f) => !files.includes(f));
    if (r.name !== "creator-studio-mcp") { console.log("name is " + r.name); process.exit(1); }
    if (r.version !== v) { console.log("version " + r.version + " != " + v); process.exit(1); }
    if (lack.length) { console.log("pack lacks " + lack.join(", ")); process.exit(1); }
    console.log(r.name + "@" + r.version + ", " + files.length + " files");
  ' "$j")"
  rc=$?
  REASON="$out"
  return $rc
}

# 5. Skill frontmatter.
c5() {
  [ -f "$SKILL/SKILL.md" ] || { REASON="SKILL.md missing"; return 1; }
  local out rc
  out="$(python3 - "$SKILL/SKILL.md" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r"---\n(.*?)\n---\n", text, re.S)
if not m:
    print("no frontmatter"); sys.exit(1)
fm = m.group(1)
name = re.search(r"^name:\s*(.+?)\s*$", fm, re.M)
desc = re.search(r"^description:\s*(.+?)\s*$", fm, re.M)
if not name or not desc:
    print("name or description missing"); sys.exit(1)
if name.group(1) != "studio" or not re.fullmatch(r"[a-z0-9-]{1,64}", name.group(1)):
    print("name is " + name.group(1)); sys.exit(1)
if len(desc.group(1)) > 1024:
    print(f"description is {len(desc.group(1))} chars"); sys.exit(1)
if "<" in fm or ">" in fm:
    print("angle bracket in frontmatter"); sys.exit(1)
print(f"name studio, description {len(desc.group(1))} chars")
PY
)"
  rc=$?
  REASON="$out"
  return $rc
}

# 6. SKILL.md size.
c6() {
  [ -f "$SKILL/SKILL.md" ] || { REASON="SKILL.md missing"; return 1; }
  local n; n=$(wc -c <"$SKILL/SKILL.md" | tr -d ' ')
  REASON="$n bytes"
  [ "$n" -le 20000 ]
}

# 7. Every in-skill path mentioned by SKILL.md and the reference files exists.
c7() {
  [ -d "$SKILL/references" ] || { REASON="references/ missing"; return 1; }
  local out rc
  out="$(python3 - "$SKILL" <<'PY'
import glob, os, re, sys
skill = sys.argv[1]
tail = r"((?:references|recipes|scripts|learning-template)/[\w.-]+(?:/[\w.-]+)*)"
patterns = [
    re.compile(r"(?<![\w./>-])(?:\.\./)?" + tail),
    re.compile(r"(?:\$\{CLAUDE_SKILL_DIR\}|<skill folder>)/" + tail),
]
files = [os.path.join(skill, "SKILL.md")] + sorted(glob.glob(os.path.join(skill, "references", "*.md")))
seen, bad = set(), set()
for path in files:
    text = open(path, encoding="utf-8").read()
    for pat in patterns:
        for m in pat.finditer(text):
            p = m.group(1).rstrip(".")
            seen.add(p)
            if not os.path.exists(os.path.join(skill, p)):
                bad.add(f"{os.path.basename(path)}:{p}")
for b in sorted(bad):
    print("BAD", b, file=sys.stderr)
if not seen:
    print("no paths found"); sys.exit(1)
if bad:
    print(f"{len(bad)} broken: {sorted(bad)[0]}"); sys.exit(1)
print(f"{len(seen)} paths exist")
PY
)"
  rc=$?
  REASON="$out"
  return $rc
}

# 8. No personal data in the public files.
c8() {
  local pat='teemu|kinos|/Users/[a-z]|Personal/|Reworks|skene|@gmail|hot stuff|bad girls|love street|gimme shelter'
  # The public repository slug is required by the install instructions. Only that exact slug is exempt.
  local slug='teemukinos/creator-studio-mcp'
  local t hits
  for t in skills craft README.md CONTRIBUTING.md src test; do
    [ -e "$t" ] || { REASON="$t missing"; return 1; }
  done
  hits="$(grep -riE "$pat" skills craft README.md CONTRIBUTING.md src test | sed "s#$slug##g" | grep -iE "$pat")"
  if [ -n "$hits" ]; then
    echo "$hits"
    REASON="$(echo "$hits" | cut -d: -f1 | sort -u | wc -l | tr -d ' ') file(s) with personal data"
    return 1
  fi
  REASON="none found"
}

# 9. No secrets in files about to be published, or in git history.
c9() {
  local tmp f
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-secrets.XXXXXX")"
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    mkdir -p "$tmp/$(dirname "$f")"
    cp "$f" "$tmp/$f"
  done < <(git ls-files -z -co --exclude-standard)
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks detect --no-banner --redact --no-git --source "$tmp" --exit-code 1 \
      || { REASON="gitleaks found secrets in files"; return 1; }
    if git rev-parse -q --verify HEAD >/dev/null; then
      gitleaks detect --no-banner --redact --source . --exit-code 1 \
        || { REASON="gitleaks found secrets in history"; return 1; }
    fi
    REASON="gitleaks clean"
  else
    if grep -rIlE 'AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{36}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$tmp"; then
      REASON="regex scan found secrets"
      return 1
    fi
    REASON="regex scan clean (gitleaks not installed)"
  fi
}

# 10. The skills CLI finds and installs the skill. HOME is a temporary folder.
c10() {
  [ -f "$SKILL/SKILL.md" ] || { REASON="SKILL.md missing"; return 1; }
  local h d
  h="$(mktemp -d "${TMPDIR:-/tmp}/verify-home.XXXXXX")"
  local e="env -u CODEX_HOME -u CLAUDE_CONFIG_DIR -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME HOME=$h"
  $e npx -y skills add . --list >"$LOG.list" 2>&1 || { REASON="skills --list failed"; return 1; }
  cat "$LOG.list"
  grep -q studio "$LOG.list" || { REASON="--list does not show studio"; return 1; }
  $e npx -y skills add . -g -a codex -y || { REASON="skills install failed: $(first_error)"; return 1; }
  [ -e .agents ] && { REASON="install wrote into the repository"; return 1; }
  d="$h/.agents/skills/studio"
  for p in references recipes scripts; do
    [ -d "$d/$p" ] || { REASON="installed skill lacks $p/"; return 1; }
  done
  [ -f "$d/SKILL.md" ] || { REASON="installed skill lacks SKILL.md"; return 1; }
  REASON="listed and installed under a temp HOME"
}

# 11. The claude.ai zip.
c11() {
  [ -f scripts/package_skill.sh ] || { REASON="scripts/package_skill.sh missing"; return 1; }
  sh scripts/package_skill.sh || { REASON="package_skill.sh failed: $(first_error)"; return 1; }
  local z=dist-skill/studio.zip size bad
  [ -f "$z" ] || { REASON="$z not written"; return 1; }
  zipinfo -1 "$z" >"$LOG.list" || { REASON="zip unreadable"; return 1; }
  bad=$(grep -vc '^studio/' "$LOG.list")
  [ "$bad" -eq 0 ] || { REASON="$bad entries outside studio/"; return 1; }
  grep -qx 'studio/SKILL.md' "$LOG.list" || { REASON="no studio/SKILL.md"; return 1; }
  size=$(wc -c <"$z" | tr -d ' ')
  [ "$size" -lt 31457280 ] || { REASON="$size bytes, over 30 MB"; return 1; }
  REASON="$(wc -l <"$LOG.list" | tr -d ' ') entries, $size bytes"
}

# 12. Learning data lives outside the skill.
c12() {
  local m="$SKILL/scripts/measure_session.py" stale
  [ -f "$m" ] || { REASON="measure_session.py missing"; return 1; }
  python3 "$m" --help | grep -qF '~/.studio/learning' || grep -qF '.studio' "$m" \
    || { REASON="default is not ~/.studio/learning"; return 1; }
  # The occurrence ~/.studio/learning/ledger.csv is the required location, not a path inside the skill.
  stale=$(grep -rhoE '.{0,8}learning/ledger' "$SKILL" | grep -cvE '\.studio/learning/ledger$')
  [ "$stale" -eq 0 ] || { REASON="$stale learning/ledger path(s) inside the skill"; return 1; }
  [ ! -e "$SKILL/learning" ] || { REASON="skill still has a learning/ folder"; return 1; }
  REASON="ledger defaults to ~/.studio/learning"
}

# 13. Every install command (setup.md, AGENTS.md, README.md), AGENTS.md's stated version and the server's own
# version match package.json. Placeholders such as creator-studio-mcp@<version> are skipped.
c13() {
  local v f vs bad="" n=0
  v="$(pkg_field version)"
  for f in "$SKILL/references/setup.md" AGENTS.md README.md; do
    [ -f "$f" ] || { REASON="$(basename "$f") missing"; return 1; }
    vs="$(grep -oE 'creator-studio-mcp@[^ "`)]+' "$f" | sed 's/.*@//' | grep -v '^<' | sort -u)"
    [ -n "$vs" ] || { REASON="no creator-studio-mcp@<version> in $(basename "$f")"; return 1; }
    [ "$vs" = "$v" ] || bad="$bad $(basename "$f"):$(echo "$vs" | xargs | tr ' ' ',')"
    n=$((n + 1))
  done
  vs="$(grep -oE 'The version is `[^`]+`' AGENTS.md | sed 's/.*`\(.*\)`/\1/' | sort -u)"
  [ "$vs" = "$v" ] || bad="$bad AGENTS.md-stated:${vs:-none}"
  vs="$(grep -oE 'name: "creator-studio", version: "[^"]+"' src/index.ts | sed 's/.*version: "\(.*\)"/\1/')"
  [ "$vs" = "$v" ] || bad="$bad src/index.ts:${vs:-none}"
  [ -z "$bad" ] || { REASON="package.json has $v;$bad"; return 1; }
  REASON="$v in $n install guides, AGENTS.md and the server"
}

# 14. README content.
c14() {
  local f=README.md
  [ -f "$f" ] || { REASON="README.md missing"; return 1; }
  grep -qF 'not affiliated with Apple' "$f" || { REASON="no 'not affiliated with Apple'"; return 1; }
  local h
  for h in Security Rights Privacy; do
    grep -qE "^#+ .*$h" "$f" || { REASON="no $h heading"; return 1; }
  done
  grep -qF 'npx skills add' "$f" || { REASON="no 'npx skills add'"; return 1; }
  REASON="required content present"
}

# 15. measure_session.py and wait_status.sh behave on fixtures.
c15() {
  local fx=test/fixtures m="$SKILL/scripts/measure_session.py" w="$SKILL/scripts/wait_status.sh"
  local tmp rc out
  [ -f "$fx/claude-session.jsonl" ] && [ -f "$fx/codex-session.jsonl" ] || { REASON="fixtures missing"; return 1; }
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-scripts.XXXXXX")"

  row() { python3 -c 'import csv,sys; r=list(csv.DictReader(open(sys.argv[1])))[-1]; print(r["source"], r["requests"], r["tokens"])' "$1"; }

  python3 "$m" --transcript "$fx/claude-session.jsonl" --ledger "$tmp/a.csv" || { REASON="claude fixture run failed"; return 1; }
  out="$(row "$tmp/a.csv")"
  [ "$out" = "claude 2 3390" ] || { REASON="claude fixture gave: $out"; return 1; }
  python3 "$m" --transcript "$fx/codex-session.jsonl" --ledger "$tmp/b.csv" || { REASON="codex fixture run failed"; return 1; }
  out="$(row "$tmp/b.csv")"
  [ "$out" = "codex 2 1500" ] || { REASON="codex fixture gave: $out"; return 1; }

  env HOME="$tmp/home" python3 "$m" --transcript "$fx/claude-session.jsonl" || { REASON="default ledger run failed"; return 1; }
  [ -f "$tmp/home/.studio/learning/ledger.csv" ] || { REASON="default ledger not in ~/.studio/learning"; return 1; }
  env STUDIO_LEARNING_DIR="$tmp/custom" python3 "$m" --transcript "$fx/claude-session.jsonl" || { REASON="env ledger run failed"; return 1; }
  [ -f "$tmp/custom/ledger.csv" ] || { REASON="STUDIO_LEARNING_DIR not honoured"; return 1; }

  out="$(sh "$w" "$fx/status-done.json" 0)"; rc=$?
  [ "$rc" -eq 0 ] && case "$out" in state=done*) ;; *) false ;; esac || { REASON="wait_status done: rc=$rc $out"; return 1; }
  out="$(sh "$w" "$fx/status-failed.json" 0)"; rc=$?
  [ "$rc" -eq 1 ] && case "$out" in state=failed*) ;; *) false ;; esac || { REASON="wait_status failed: rc=$rc $out"; return 1; }
  out="$(sh "$w" "$fx/status-running.json" 0)"; rc=$?
  [ "$rc" -eq 3 ] && case "$out" in state=running*) ;; *) false ;; esac || { REASON="wait_status running: rc=$rc $out"; return 1; }
  REASON="request and token counts match, wait_status states match"
}

# 16. The CI workflow.
c16() {
  local f=.github/workflows/ci.yml j="$LOG.json" out rc
  [ -f "$f" ] || { REASON="ci.yml missing"; return 1; }
  if python3 -c 'import yaml' 2>/dev/null; then
    python3 -c 'import json,sys,yaml; json.dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2],"w"))' "$f" "$j" \
      || { REASON="ci.yml does not parse"; return 1; }
  elif command -v ruby >/dev/null 2>&1; then
    ruby -ryaml -rjson -e 'File.write(ARGV[1], JSON.generate(YAML.load_file(ARGV[0])))' "$f" "$j" \
      || { REASON="ci.yml does not parse"; return 1; }
  else
    REASON="no YAML parser available"; return 1
  fi
  if command -v actionlint >/dev/null 2>&1; then
    actionlint "$f" || { REASON="actionlint failed"; return 1; }
  fi
  out="$(python3 - "$j" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
on = d.get("on") or d.get("true") or {}
tags = ((on.get("push") or {}).get("tags") or []) if isinstance(on, dict) else []
if "v*" not in tags:
    print("does not run on tags v*"); sys.exit(1)
jobs = d.get("jobs") or {}
if not any(j.get("runs-on") == "macos-latest" for j in jobs.values()):
    print("no macos-latest job"); sys.exit(1)
runs = [str(s.get("run") or "") for j in jobs.values() for s in j.get("steps") or []]
ver = [r for r in runs if "scripts/verify.sh" in r]
if not ver:
    print("does not run scripts/verify.sh"); sys.exit(1)
if not any(re.search(r"--skip\s+\S*\b10\b", r) for r in ver):
    print("verify.sh does not skip check 10"); sys.exit(1)
if not any("dist-skill/studio.zip" in r and "gh release" in r for r in runs):
    print("does not upload dist-skill/studio.zip to the release"); sys.exit(1)
print("macos-latest, verify without check 10, zip on tags")
PY
)"
  rc=$?
  REASON="$out"
  return $rc
}

# 17. Nothing that must stay local would be published.
c17() {
  local bad
  bad="$(git ls-files -co --exclude-standard | grep -E '(^|/)node_modules/|(^|/)\.DS_Store$|ledger|^\.verify/')"
  if [ -n "$bad" ]; then
    echo "$bad"
    REASON="$(echo "$bad" | wc -l | tr -d ' ') local file(s) tracked: $(echo "$bad" | head -n 1)"
    return 1
  fi
  REASON="clean"
}

# 18. The maintainer's own install keeps learning data outside the skill.
c18() {
  [ -f "$HOME/.studio/learning/inbox.md" ] || { REASON="~/.studio/learning/inbox.md missing"; return 1; }
  [ ! -e "$HOME/.agents/skills/studio/learning" ] || { REASON="personal skill still has learning/"; return 1; }
  grep -qF '.studio/learning' "$HOME/.agents/skills/studio/SKILL.md" \
    || { REASON="personal SKILL.md does not mention ~/.studio/learning"; return 1; }
  REASON="inbox moved, personal skill updated"
}

# --- Release checks 19-25 -----------------------------------------------------------------
# A check returns 2 to SKIP. With CI=true a SKIP is left out of the score; locally it counts as a failure.
PROBE="$ROOT/scripts/mcp_probe.mjs"
TGZ=""
tmpdir() { mktemp -d "${TMPDIR:-/tmp}/verify-$1.XXXXXX"; }
clean_env() { env -u CODEX_HOME -u CLAUDE_CONFIG_DIR -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME "$@"; }
local_only() {
  [ "${CI:-}" = "true" ] && { REASON="local only (CI=true)"; return 0; }
  return 1
}
# Pack the repository once per run, into a fresh temp folder. Sets TGZ.
ensure_tgz() {
  [ -n "$TGZ" ] && [ -f "$TGZ" ] && return 0
  local d; d="$(tmpdir pack)"
  npm pack --pack-destination "$d" >/dev/null || return 1
  TGZ="$(ls "$d"/*.tgz 2>/dev/null | head -n 1)"
  [ -n "$TGZ" ]
}
# probe_eval <probe output> <function body over r, the probe report>: prints what it returns, exits 1 when it throws.
probe_eval() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    try { console.log((0, eval)("(r) => {" + process.argv[2] + "}")(r)); }
    catch (e) { console.log(e.message); process.exit(1); }' "$1" "$2"
}
HANDSHAKE_38='if (!r.ok) throw new Error("no handshake: " + (r.error || "") + " " + r.stderr.slice(-120));
  if (r.tools.length < 38) throw new Error("only " + r.tools.length + " tools");'

# 19. The packed tarball installs and runs the way a user gets it from npm.
c19() {
  ensure_tgz || { REASON="npm pack failed"; return 1; }
  local t out
  t="$(tmpdir tarball)"
  mkdir -p "$t/home" "$t/cache"
  echo '[{"name": "creator_studio_status", "timeout": 60000}]' >"$t/calls.json"
  ( cd "$t" && clean_env HOME="$t/home" npm_config_cache="$t/cache" \
      node "$PROBE" "$t/calls.json" -- npx -y --package "$TGZ" creator-studio-mcp ) >"$t/out.json"
  cat "$t/out.json"
  out="$(probe_eval "$t/out.json" "$HANDSHAKE_38
    const c = r.calls[0];
    if (!c || c.status !== 'OK') throw new Error('creator_studio_status: ' + (c ? c.status + ' ' + c.text.slice(0, 60) : r.error));
    return r.tools.length + ' tools from the tarball, creator_studio_status OK';")" || { REASON="$out"; return 1; }
  REASON="$out"
}

# 20. The setup paths in references/setup.md work, with the tarball in place of the npm version.
c20() {
  local f="$SKILL/references/setup.md" t npxp nodedir nodebin out cmdline parts=""
  [ -f "$f" ] || { REASON="setup.md missing"; return 1; }
  ensure_tgz || { REASON="npm pack failed"; return 1; }
  t="$(tmpdir setup)"
  mkdir -p "$t/home" "$t/codex" "$t/cache" "$t/src"
  npxp="$(command -v npx)"; nodebin="$(command -v node)"; nodedir="$(dirname "$nodebin")"
  ln -s "$ROOT" "$t/src/creator-studio-mcp"
  python3 - "$f" "$t" "$TGZ" "$npxp" "$nodedir" "$t/src/creator-studio-mcp" <<'PY' || { REASON="setup.md: $(tail -n 1 "$LOG")"; return 1; }
import json, re, sys
src, t, tgz, npx, nodedir, clone_src = sys.argv[1:]
text = open(src, encoding="utf-8").read()
blocks = re.findall(r"```(\w*)\n(.*?)```", text, re.S)
def one(lang, needle):
    hits = [b for l, b in blocks if l == lang and needle in b]
    if len(hits) != 1:
        sys.exit(f"expected one {lang} block with {needle!r}, found {len(hits)}")
    return hits[0]
def sub_args(s):
    s, n = re.subn(r'"creator-studio-mcp@[^"]+"', f'"--package", "{tgz}", "creator-studio-mcp"', s)
    if n != 1:
        sys.exit("no creator-studio-mcp@<version> argument")
    return s.replace("<npx path>", npx)
claude = one("sh", "claude mcp add --scope user creator-studio -- npx")
claude, n = re.subn(r"creator-studio-mcp@\S+", f"--package '{tgz}' creator-studio-mcp", claude.strip())
if n != 1:
    sys.exit("claude command has no creator-studio-mcp@<version>")
open(f"{t}/claude.sh", "w").write(claude + "\n")
open(f"{t}/codex/config.toml", "w").write(sub_args(one("toml", "[mcp_servers.creator-studio]")))
open(f"{t}/desktop.json", "w").write(sub_args(one("json", '"mcpServers"')))
m = re.search(r'`("env":\s*\{[^`]*\})`', text)
if not m:
    sys.exit("no JSON env PATH fix")
fix = json.loads("{" + m.group(1) + "}")["env"]
json.dump({k: v.replace("<node folder>", nodedir) for k, v in fix.items()}, open(f"{t}/envfix.json", "w"))
clone = one("sh", "git clone")
clone, n = re.subn(r"https://github\.com/\S+", clone_src, clone)
if n != 1:
    sys.exit("clone block has no repository URL")
open(f"{t}/clone.sh", "w").write("set -e\n" + clone)
PY
  local E="clean_env HOME=$t/home CODEX_HOME=$t/codex npm_config_cache=$t/cache"

  # (a) Claude Code
  if command -v claude >/dev/null 2>&1; then
    ( cd "$t" && $E sh "$t/claude.sh" && $E claude mcp list ) >"$t/claude.out" 2>&1
    cat "$t/claude.out"
    grep -E '^creator-studio:.*Connected' "$t/claude.out" >/dev/null || { REASON="(a) claude mcp list does not show Connected"; return 1; }
    parts="${parts}a"
  else parts="${parts} (a skipped)"; fi

  # (b) Codex
  if command -v codex >/dev/null 2>&1; then
    ( cd "$t" && $E codex mcp list ) >"$t/codex.out" 2>&1
    cat "$t/codex.out"
    grep -E '^creator-studio .*enabled' "$t/codex.out" >/dev/null || { REASON="(b) codex mcp list does not show it enabled"; return 1; }
    parts="${parts}b"
  else parts="${parts} (b skipped)"; fi

  # (c) Claude desktop JSON
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const e = j.mcpServers["creator-studio"];
    if (!e || !e.command || !Array.isArray(e.args)) process.exit(1);' "$t/desktop.json" \
    || { REASON="(c) desktop JSON does not parse or lacks creator-studio"; return 1; }
  parts="${parts}c"

  # (d) Without node on PATH the entry fails the way setup.md says; with its env fix it boots.
  cmdline="$(node -e 'const e = require(process.argv[1]).mcpServers["creator-studio"]; console.log([e.command, ...e.args].map((a) => JSON.stringify(a)).join(" "))' "$t/desktop.json")"
  ( cd "$t" && eval "$E PATH=/usr/bin:/bin \"$nodebin\" \"$PROBE\" - -- $cmdline" ) >"$t/nopath.json"
  cat "$t/nopath.json"
  grep -qF 'env: node: No such file or directory' "$t/nopath.json" || { REASON="(d) no 'env: node' error without node on PATH"; return 1; }
  ( cd "$t" && eval "$E PATH=\"$(node -p 'require(process.argv[1]).PATH' "$t/envfix.json")\" \"$nodebin\" \"$PROBE\" - -- $cmdline" ) >"$t/fixed.json"
  cat "$t/fixed.json"
  out="$(probe_eval "$t/fixed.json" "$HANDSHAKE_38 return 'ok';")" || { REASON="(d) with the env fix: $out"; return 1; }
  parts="${parts}d"

  # (e) The clone fallback, from this repository's committed state.
  ( cd "$t" && $E sh "$t/clone.sh" ) || { REASON="(e) clone block failed: $(first_error)"; return 1; }
  $E node "$PROBE" - -- node "$t/creator-studio-mcp/dist/index.js" >"$t/clone.json"
  cat "$t/clone.json"
  out="$(probe_eval "$t/clone.json" "$HANDSHAKE_38 return 'ok';")" || { REASON="(e) clone: $out"; return 1; }
  parts="${parts}e"
  REASON="setup.md paths work: $parts"
  case "$parts" in *skipped*) [ "${CI:-}" = "true" ] || return 2 ;; esac
}

# 21. Real apps, driven over stdio through the tarball's server; results checked from files in a temp folder.
# CSMCP_SMOKE_FULL=1 runs every other tool too (see scripts/smoke.mjs for what that needs and changes).
c21() {
  local_only && return 2
  [ -f scripts/smoke.mjs ] || { REASON="scripts/smoke.mjs missing"; return 1; }
  ensure_tgz || { REASON="npm pack failed"; return 1; }
  local t out rc
  t="$(tmpdir apps)"
  mkdir -p "$t/cache"
  out="$(cd "$t" && npm_config_cache="$t/cache" node "$ROOT/scripts/smoke.mjs" "$t" -- npx -y --package "$TGZ" creator-studio-mcp)"
  rc=$?
  echo "$out"
  REASON="$(echo "$out" | tail -n 1)"
  [ "$rc" -eq 0 ]
}

# 22. SOURCE_DIR plus the pending patches builds, passes its tests and matches this repository's src/ and dist/.
c22() {
  local_only && return 2
  local s="${CSMCP_SOURCE_DIR:-}" t p n=0
  [ -n "$s" ] || { REASON="CSMCP_SOURCE_DIR not set"; return 2; }
  [ -d "$s/src" ] || { REASON="CSMCP_SOURCE_DIR has no src/"; return 1; }
  t="$(tmpdir source)/src"
  mkdir -p "$t"
  ( cd "$s" && tar --exclude ./node_modules -cf - . ) | ( cd "$t" && tar -xf - ) || { REASON="copy failed"; return 1; }
  ln -s "$s/node_modules" "$t/node_modules"
  for p in "$ROOT"/.verify/source-patches/pending/*.patch; do
    [ -f "$p" ] || continue
    ( cd "$t" && patch -p1 --batch --forward <"$p" ) || { REASON="$(basename "$p") does not apply"; return 1; }
    n=$((n + 1))
  done
  ( cd "$t" && npm run build ) || { REASON="build failed after $n patch(es)"; return 1; }
  ( cd "$t" && npm test ) || { REASON="npm test failed after $n patch(es)"; return 1; }
  diff -r "$t/src" "$ROOT/src" && diff -r "$t/dist" "$ROOT/dist" \
    || { REASON="src/ or dist/ differs after $n patch(es)"; return 1; }
  REASON="$n pending patch(es) apply; build and tests pass; src/ and dist/ identical"
}

# 23. README.md documents exactly the tools the server lists.
c23() {
  local t out rc
  t="$(tmpdir docs)"
  node "$PROBE" - -- node dist/index.js >"$t/tools.json"
  out="$(node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!r.ok) { console.log("no handshake"); process.exit(1); }
    const doc = new Set();
    for (const line of fs.readFileSync("README.md", "utf8").split("\n")) {
      if (!line.startsWith("|")) continue;
      for (const m of line.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) doc.add(m[1]);
    }
    const tools = new Set(r.tools);
    const undoc = r.tools.filter((n) => !doc.has(n));
    const extra = [...doc].filter((n) => !tools.has(n));
    console.error("undocumented:", undoc.join(" ") || "-", "| documented but not a tool:", extra.join(" ") || "-");
    if (undoc.length || extra.length) {
      console.log((undoc.length ? "undocumented: " + undoc.join(" ") + " " : "") + (extra.length ? "not a tool: " + extra.join(" ") : ""));
      process.exit(1);
    }
    console.log(tools.size + " tools, all documented, no extras");' "$t/tools.json")"
  rc=$?
  REASON="$out"
  [ "$rc" -eq 0 ]
}

# 24. A committed list maps every tool, once, to how it is verified: check 21, check 21 with CSMCP_SMOKE_FULL=1,
# a named unit test, or not exercised with a reason.
c24() {
  local t out rc
  [ -f scripts/smoke.mjs ] || { REASON="scripts/smoke.mjs missing"; return 1; }
  t="$(tmpdir coverage)"
  node "$PROBE" - -- node dist/index.js >"$t/tools.json"
  out="$(SMOKE_MJS="$ROOT/scripts/smoke.mjs" TOOLS_JSON="$t/tools.json" node --input-type=module -e '
    import { readFileSync, readdirSync } from "node:fs";
    const { COVERAGE, SMOKE_TOOLS, FULL_TOOLS = [] } = await import(process.env.SMOKE_MJS);
    const r = JSON.parse(readFileSync(process.env.TOOLS_JSON, "utf8"));
    if (!r.ok) { console.log("no handshake"); process.exit(1); }
    const titles = readdirSync("test").filter((f) => f.endsWith(".test.ts"))
      .flatMap((f) => [...readFileSync("test/" + f, "utf8").matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]));
    const bad = [];
    const count = {};
    for (const c of COVERAGE) {
      count[c.tool] = (count[c.tool] || 0) + 1;
      if (c.how === "unit test") { if (!titles.includes(c.detail)) bad.push(c.tool + ": no test titled " + JSON.stringify(c.detail)); }
      else if (c.how === "check 21") { if (!SMOKE_TOOLS.includes(c.tool)) bad.push(c.tool + ": not called by the smoke run"); }
      else if (c.how === "check 21 full") { if (!FULL_TOOLS.includes(c.tool)) bad.push(c.tool + ": not called by the full smoke run"); }
      else if (c.how === "not exercised") { if (!c.detail || !c.detail.trim()) bad.push(c.tool + ": no reason"); }
      else bad.push(c.tool + ": unknown kind " + c.how);
    }
    for (const n of r.tools) if (count[n] !== 1) bad.push(n + " listed " + (count[n] || 0) + " times");
    for (const n of Object.keys(count)) if (!r.tools.includes(n)) bad.push(n + " is not a tool");
    for (const n of SMOKE_TOOLS) if (!COVERAGE.some((c) => c.tool === n && c.how === "check 21")) bad.push(n + " is smoke-called but not mapped to check 21");
    for (const n of FULL_TOOLS) if (!COVERAGE.some((c) => c.tool === n && c.how === "check 21 full")) bad.push(n + " is called by the full run but not mapped to check 21 full");
    bad.forEach((b) => console.error(b));
    if (bad.length) { console.log(bad.length + " problem(s): " + bad[0]); process.exit(1); }
    const by = {};
    for (const c of COVERAGE) by[c.how] = (by[c.how] || 0) + 1;
    console.log(Object.entries(by).map(([k, v]) => v + " " + k).join(", "));')"
  rc=$?
  REASON="$out"
  [ "$rc" -eq 0 ]
}

# 25. Files in the npm tarball have clean modes: 644, and 755 for the bin.
c25() {
  ensure_tgz || { REASON="npm pack failed"; return 1; }
  local bin bad
  bin="package/$(node -p 'Object.values(require("./package.json").bin)[0].replace(/^\.\//, "")')"
  tar -tvzf "$TGZ" >"$LOG.list" || { REASON="tarball unreadable"; return 1; }
  cat "$LOG.list"
  bad="$(awk -v bin="$bin" '{ want = ($NF == bin) ? "-rwxr-xr-x" : "-rw-r--r--"; if ($1 != want) print $1, $NF }' "$LOG.list")"
  if [ -n "$bad" ]; then
    echo "BAD: $bad"
    REASON="$(echo "$bad" | wc -l | tr -d ' ') file(s) with the wrong mode: $(echo "$bad" | head -n 1)"
    return 1
  fi
  REASON="$(wc -l <"$LOG.list" | tr -d ' ') files, modes clean"
}

# 26. One minimum Node version: package.json engines, README.md and setup.md state it, and CI tests it.
c26() {
  local eng ci rd st
  eng="$(node -p 'require("./package.json").engines.node' | sed -nE 's/^>=([0-9]+)(\.0)*$/\1/p')"
  ci="$(grep -E '^[[:space:]]*node-version:' .github/workflows/ci.yml | sed -E 's/.*node-version:[[:space:]]*["'\'']?([0-9]+).*/\1/' | sort -u)"
  rd="$(grep -oE 'Node(\.js)? [0-9]+ or later' README.md | grep -oE '[0-9]+' | sort -u)"
  st="$(grep -oE 'Node(\.js)? [0-9]+ or later' "$SKILL/references/setup.md" | grep -oE '[0-9]+' | sort -u)"
  echo "engines=$eng ci=$ci readme=$rd setup=$st"
  [ -n "$eng" ] || { REASON="engines.node is not a plain >=N"; return 1; }
  [ -n "$st" ] || { REASON="setup.md does not say which Node it needs"; return 1; }
  [ "$rd" = "$eng" ] && [ "$st" = "$eng" ] && [ "$ci" = "$eng" ] \
    || { REASON="engines >=$eng, README $(echo $rd), setup.md $(echo $st), CI tests $(echo $ci)"; return 1; }
  REASON="Node $eng or later, stated everywhere and tested in CI"
}

# 27. The check command CONTRIBUTING.md gives contributors passes in a fresh copy, without the maintainer's setup.
# It runs last, after every other check: a contributor-run failure that the main run shares is counted by that
# check, so this one fails only on failures the contributor's setup adds, and on any non-zero exit when all else passes.
c27() {
  [ -n "${VERIFY_NESTED:-}" ] && { REASON="nested run"; return 2; }
  local t cmd rc probs="" n extra=""
  cmd="$(python3 - <<'PY'
import re
blocks = re.findall(r"```sh\n(.*?)```", open("CONTRIBUTING.md", encoding="utf-8").read(), re.S)
hits = [l.strip() for b in blocks for l in b.splitlines() if "scripts/verify.sh" in l]
print(hits[0] if hits else "")
PY
)"
  [ -n "$cmd" ] || { REASON="CONTRIBUTING.md gives no scripts/verify.sh command"; return 1; }
  # If CONTRIBUTING.md says the command is what CI runs, it must skip what ci.yml skips.
  if grep -qiE 'what CI runs|same as CI' CONTRIBUTING.md; then
    local cis
    cis="$(grep -oE 'scripts/verify.sh --skip [0-9,]+' .github/workflows/ci.yml | head -n 1)"
    case "$cmd" in "CI=true $cis") ;; *) REASON="CONTRIBUTING.md says '$cmd' is what CI runs; CI runs '$cis'"; return 1 ;; esac
  fi
  t="$(tmpdir contrib)"
  # A clone of HEAD, with the working tree's tracked and new files on top: the state about to be committed.
  git clone -q "$ROOT" "$t/repo" || { REASON="clone failed"; return 1; }
  ( cd "$t/repo" && git ls-files -z | xargs -0 rm -f )
  git ls-files -z -co --exclude-standard | while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    mkdir -p "$t/repo/$(dirname "$f")"; cp -p "$f" "$t/repo/$f"
  done
  ( cd "$t/repo" && git add -A )
  ( cd "$t/repo" && clean_env -u CSMCP_SOURCE_DIR -u CI VERIFY_NESTED=1 sh -c "$cmd" ) >"$t/out" 2>&1
  rc=$?
  cat "$t/out"
  [ "$rc" -eq 0 ] && { REASON="'$cmd' passes in a fresh copy"; return 0; }
  probs="$(grep -oE '^FAIL +[0-9]+' "$t/out" | awk '{print $2}')"
  case "$cmd" in *CI=true*) ;; *) probs="$probs $(grep -E '^SKIP +[0-9]+ [a-z-]+:' "$t/out" | awk '{print $2}')" ;; esac
  # A check this run skipped by --skip (CI skips 10) has no result to compare with, so it counts as shared.
  for n in $probs; do case "$OUTER_FAILED$SKIP" in *",$n,"*) ;; *) extra="$extra $n" ;; esac; done
  if [ -z "$(echo $probs)" ] || [ -n "$extra" ]; then
    REASON="'$cmd' exit $rc; contributor-only failures:${extra:- none listed}"; return 1
  fi
  REASON="'$cmd': no contributor-only failures (shares$(echo " $probs" | tr '\n' ' ' | tr -s ' '))"
}

# 28. The skill, which ships on its own, carries the licence and the unofficial notice.
# skills/ must not name the licence holder (check 8), so the skill folder's LICENSE points to the repository's
# LICENSE, and studio.zip carries that exact file.
c28() {
  local slug
  slug="$(node -p 'require("./package.json").repository.url.replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "")')"
  [ -f "$SKILL/LICENSE" ] || { REASON="no LICENSE in $SKILL"; return 1; }
  grep -qF 'MIT License' "$SKILL/LICENSE" && grep -qF "github.com/$slug/blob/main/LICENSE" "$SKILL/LICENSE" \
    || { REASON="$SKILL/LICENSE does not name MIT and link the repository LICENSE"; return 1; }
  grep -qF 'not affiliated with Apple' "$SKILL/SKILL.md" || { REASON="SKILL.md lacks 'not affiliated with Apple'"; return 1; }
  sh scripts/package_skill.sh || { REASON="package_skill.sh failed"; return 1; }
  unzip -p dist-skill/studio.zip studio/LICENSE | cmp -s - LICENSE || { REASON="studio.zip lacks the repository LICENSE as studio/LICENSE"; return 1; }
  REASON="LICENSE and the unofficial notice ship with the skill"
}

# 29. What the skill's docs promise about the scripts and tools matches the code.
c29() {
  local m="$SKILL/scripts/measure_session.py" fx=test/fixtures t w key got
  t="$(tmpdir promises)"; w="$t/work"; mkdir -p "$w" "$t/home/.codex/sessions/2026/01/01"
  # (a) --latest measures the newest session for the current folder, from Claude Code or Codex.
  key="$(cd "$w" && python3 -c 'import os, re; print(re.sub(r"[^A-Za-z0-9]", "-", os.getcwd()))')"
  mkdir -p "$t/home/.claude/projects/$key"
  cp "$fx/claude-session.jsonl" "$t/home/.claude/projects/$key/s.jsonl"
  { printf '{"type": "session_meta", "timestamp": "2026-01-01T11:00:00.000Z", "payload": {"cwd": "%s"}}\n' "$(cd "$w" && pwd -P)"
    cat "$fx/codex-session.jsonl"; } >"$t/home/.codex/sessions/2026/01/01/rollout-x.jsonl"
  latest() { ( cd "$w" && env -u CODEX_HOME HOME="$t/home" python3 "$ROOT/$m" --latest --ledger "$t/l.csv" >/dev/null ) && tail -n 1 "$t/l.csv" | cut -d, -f5; }
  touch -t 202601011200 "$t/home/.claude/projects/$key/s.jsonl"; touch -t 202601011300 "$t/home/.codex/sessions/2026/01/01/rollout-x.jsonl"
  got="$(latest)"; [ "$got" = "codex" ] || { REASON="(a) --latest took $got when the Codex session is newer"; return 1; }
  touch -t 202601011400 "$t/home/.claude/projects/$key/s.jsonl"
  got="$(latest)"; [ "$got" = "claude" ] || { REASON="(a) --latest took $got when the Claude Code session is newer"; return 1; }
  # (b) The docstring names only the session folders the script searches.
  grep -qF '.codex*' "$m" && { REASON="(b) docstring promises ~/.codex*, the script reads \$CODEX_HOME or ~/.codex"; return 1; }
  # (c) pixelmator_batch_process takes one resize for the whole batch and makes no contact sheet.
  grep -rhi 'pixelmator_batch_process' "$SKILL" | grep -qiE 'contact sheet|list of sizes' && ! grep -rqi 'contact' src \
    && { REASON="(c) docs promise a contact sheet or a list of sizes from pixelmator_batch_process"; return 1; }
  # (d) ui_batch dryRun checks steps and vars without touching the app: it writes no status and reads no ids.
  grep -q 'if (a.dryRun) return ok' src/tools/ui.ts || { REASON="(d) dryRun no longer returns before the app is touched"; return 1; }
  grep -rqiE 'dryRun`? status|dryRun: true` first and expect to re-read ids' "$SKILL" CONTRIBUTING.md \
    && { REASON="(d) docs promise a dryRun status or id check"; return 1; }
  # (e) "every ui_* call refuses while locked" holds only if ui_screenshot checks the lock without an app too.
  if grep -qF 'every `ui_*` call' "$SKILL/references/ui.md"; then
    awk '/"ui_screenshot"/,/registerTool\(|^}/' src/tools/ui.ts | grep -qF 'screenLocked()' \
      || { REASON="(e) ui.md says every ui_* call refuses while locked; ui_screenshot without app doesn't check"; return 1; }
  fi
  REASON="--latest, docstring, batch, dryRun and lock claims match the code"
}

PASSED=0
TOTAL=0
OUT=""
OUTER_FAILED=","
run() {
  local n=$1 name=$2 status
  case "$SKIP" in *",$n,"*) OUT="$OUT$(printf 'SKIP %2d %s' "$n" "$name")
"; return ;; esac
  LOG="$LOGS/$(printf '%02d' "$n")-$name.log"
  REASON=""
  TOTAL=$((TOTAL + 1))
  "c$n" >"$LOG" 2>&1
  case $? in
    0) PASSED=$((PASSED + 1)); status=PASS ;;
    2) status=SKIP; [ "${CI:-}" = "true" ] && TOTAL=$((TOTAL - 1)) ;;
    *) status=FAIL ;;
  esac
  [ "$status" = PASS ] || OUTER_FAILED="$OUTER_FAILED$n,"
  OUT="$OUT$(printf '%s %2d %s: %s' "$status" "$n" "$name" "${REASON:-see ${LOG#"$ROOT"/}}" | cut -c1-120)
"
}

run 1 layout
run 2 build
run 3 server-boots
run 4 npm-pack
run 5 frontmatter
run 6 skill-size
run 7 references
run 8 personal-data
run 9 secrets
run 10 skills-discovery
run 11 claude-zip
run 12 learning-outside
run 13 setup-version
run 14 readme
run 15 script-tests
run 16 ci
run 17 git-hygiene
run 18 local-fixes
run 19 tarball-install
run 20 setup-paths
run 21 real-apps
run 22 source-sync
run 23 docs-tools
run 24 tool-coverage
run 25 package-modes
run 26 node-version
run 28 skill-license
run 29 skill-promises
run 27 contributor-checks   # last: it compares with every other check's result

printf '%s' "$OUT" | sort -s -k2,2n

echo "SCORE $PASSED/$TOTAL"
[ "$PASSED" -eq "$TOTAL" ]
