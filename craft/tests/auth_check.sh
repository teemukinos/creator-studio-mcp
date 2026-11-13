#!/usr/bin/env bash
# Every gateway route must refuse a wrong token with 401; /health alone is open.
# (/healthz is open too on local Docker, but some platforms answer it themselves, so it isn't checked.)
# Usage: tests/auth_check.sh [base URL]   (default http://127.0.0.1:8080)
B="${1:-http://127.0.0.1:8080}"
fail=0
check() {  # method path expected [extra curl args...]
  local m="$1" p="$2" want="$3"; shift 3
  local got
  got=$(curl -s -o /dev/null -w "%{http_code}" -X "$m" "$@" "$B$p")
  if [ "$got" = "$want" ]; then echo "PASS $m $p -> $got"; else echo "FAIL $m $p -> $got (want $want)"; fail=1; fi
}
for route in "GET /status" "GET /files/" "PUT /files/x" "DELETE /files/x" "POST /mcp/filmcraft" \
             "DELETE /mcp/filmcraft" "GET /mcp/filmcraft" "POST /nope"; do
  read -r m p <<<"$route"
  check "$m" "$p" 401 -H "Authorization: Bearer wrong" --data "{}"
done
check GET /status 401
check GET /health 200
if curl -s "$B/health" | grep -q '"service": "craft-mcp-gateway"'; then echo "PASS GET /health is the gateway's"
else echo "FAIL GET /health did not come from the gateway"; fail=1; fi
exit $fail
