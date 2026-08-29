#!/usr/bin/env bash
# Ask the Manager a question against the running real PoC.
#
#   tools/ask.sh "Nobody in the Tel Aviv office can sign in"
#
# The token is minted per call from the PoC's own Keycloak, so nothing here
# holds a credential and nothing is echoed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ $# -ge 1 ] || { echo "usage: tools/ask.sh \"<question>\"" >&2; exit 2; }

set -a; . ./.env.real-poc; set +a
token="$(curl -sS --max-time 10 -X POST \
  "http://127.0.0.1:8080/realms/${KEYCLOAK_REALM:-sre-test}/protocol/openid-connect/token" \
  -d grant_type=password -d "client_id=${KEYCLOAK_CLIENT_ID:-sre-portal}" \
  -d "client_secret=$KEYCLOAK_CLIENT_SECRET" -d "username=${KEYCLOAK_TEST_USER:-sre-test-user}" \
  -d "password=$KEYCLOAK_TEST_PASSWORD" -d scope=openid \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')"
[ ${#token} -gt 32 ] || { echo "could not obtain a token from Keycloak" >&2; exit 1; }

python3 -c 'import json,sys; print(json.dumps({"question": sys.argv[1]}))' "$1" \
  | curl -sS --max-time "${ASK_TIMEOUT:-300}" -X POST \
      -H "authorization: Bearer $token" -H 'content-type: application/json' \
      --data @- http://127.0.0.1:3000/v1/query \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("routed to :", ", ".join(d.get("metadata", {}).get("routedAgents", [])) or "(nobody)")
if d.get("error"): print("outcome   :", d["error"]["code"], "-", d["error"]["message"])
print("degraded  :", d.get("degraded"))
print()
print(d.get("answer", "(no answer)"))
for c in d.get("citations", [])[:8]: print("  cite:", c)
for g in d.get("evidenceGaps", []): print("  gap :", g.get("source"), "-", g.get("reason"))
'
