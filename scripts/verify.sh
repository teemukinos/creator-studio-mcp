#!/usr/bin/env bash
# Score this repository against its release checklist.
#
#   scripts/verify.sh [--skip N[,N...]]
#
# Prints one line per check (PASS, FAIL or SKIP, with a short reason), then "SCORE n/N".
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
REFERENCES="apple-apps blender godot handoffs logic remix rive ui setup"
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
  for t in skills README.md CONTRIBUTING.md src test; do
    [ -e "$t" ] || { REASON="$t missing"; return 1; }
  done
  hits="$(grep -riE "$pat" skills README.md CONTRIBUTING.md src test | sed "s#$slug##g" | grep -iE "$pat")"
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

# 13. setup.md names the same version as package.json.
c13() {
  local f="$SKILL/references/setup.md" v vs
  [ -f "$f" ] || { REASON="setup.md missing"; return 1; }
  v="$(pkg_field version)"
  vs="$(grep -oE 'creator-studio-mcp@[^ "]+' "$f" | sed 's/.*@//' | sort -u)"
  [ -n "$vs" ] || { REASON="no creator-studio-mcp@<version> in setup.md"; return 1; }
  [ "$vs" = "$v" ] || { REASON="setup.md has $(echo "$vs" | xargs), package.json has $v"; return 1; }
  REASON="$v"
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

PASSED=0
TOTAL=0
run() {
  local n=$1 name=$2 status
  case "$SKIP" in *",$n,"*) printf 'SKIP %2d %s\n' "$n" "$name"; return ;; esac
  LOG="$LOGS/$(printf '%02d' "$n")-$name.log"
  REASON=""
  TOTAL=$((TOTAL + 1))
  if "c$n" >"$LOG" 2>&1; then
    PASSED=$((PASSED + 1))
    status=PASS
  else
    status=FAIL
  fi
  printf '%s %2d %s: %s\n' "$status" "$n" "$name" "${REASON:-see ${LOG#"$ROOT"/}}" | cut -c1-120
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

echo "SCORE $PASSED/$TOTAL"
[ "$PASSED" -eq "$TOTAL" ]
