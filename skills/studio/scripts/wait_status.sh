#!/bin/sh
# wait_status.sh <statusFile> [maxSeconds]
# Block until a ui_batch (or any job) status file says done or failed, or maxSeconds pass.
# Prints one line. Keep maxSeconds at 270 or less so the prompt cache stays warm.
f="$1"; max="${2:-270}"; t=0
[ -n "$f" ] || { echo "usage: wait_status.sh <statusFile> [maxSeconds]"; exit 2; }
while :; do
  if [ -f "$f" ]; then
    s=$(sed -n 's/^  "state": "\([a-z]*\)".*/\1/p' "$f" | head -n 1)
    case "$s" in
      done) echo "state=done file=$f"; exit 0 ;;
      failed)
        step=$(sed -n '/^  "failed": {/,/^  }/p' "$f" | sed -n 's/^ *"label": "\(.*\)",*$/\1/p; s/^ *"error": "\(.*\)",*$/error: \1/p' | head -n 2 | tr '\n' ' ')
        echo "state=failed file=$f $step"; exit 1 ;;
    esac
  fi
  [ "$t" -ge "$max" ] && break
  sleep 5; t=$((t+5))
done
echo "state=${s:-missing} after ${max}s file=$f"
exit 3
