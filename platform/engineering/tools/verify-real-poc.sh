#!/usr/bin/env bash
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
env_file="${REAL_POC_ENV_FILE:-$root/.env.real-poc}"
state="$root/.real-poc"
results="$state/results"
mkdir -p "$results"
if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

pass=0; fail=0; blocked=0
ok() { echo "[PASS] $1"; pass=$((pass+1)); }
no() { echo "[FAIL] $1"; fail=$((fail+1)); }
block() { echo "[BLOCKED] $1"; blocked=$((blocked+1)); }
http_code() { curl -ksS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true; }
reachable() { local code; code="$(http_code "$1")"; [ -n "$code" ] && [ "$code" != "000" ]; }

realm="${KEYCLOAK_REALM:-sre-test}"
kc="http://127.0.0.1:${KEYCLOAK_HTTP_PORT:-8080}"
prom="http://127.0.0.1:${PROMETHEUS_PORT:-9090}"

reachable "$kc/realms/$realm/.well-known/openid-configuration" && ok "Keycloak reachable and realm $realm exists" || block "Keycloak or realm $realm is unreachable"
reachable "http://127.0.0.1:${KEYCLOAK_MGMT_PORT:-9000}/metrics" && ok "Keycloak management metrics reachable" || block "Keycloak metrics unreachable"
reachable "$prom/-/healthy" && ok "Prometheus reachable" || block "Prometheus unreachable"

target_up="$(curl -sS --max-time 5 "$prom/api/v1/query?query=up%7Bjob%3D%22keycloak%22%7D" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("data",{}).get("result",[]); print(r[0]["value"][1] if r else "")' 2>/dev/null || true)"
[ "$target_up" = "1" ] && ok "Prometheus reports up{job=keycloak}=1" || block "Prometheus does not report the Keycloak target UP"

login_json="$(curl -sS --max-time 10 -X POST "$kc/realms/$realm/protocol/openid-connect/token" \
  -d grant_type=password -d "client_id=${KEYCLOAK_CLIENT_ID:-sre-test-client}" \
  -d "client_secret=${KEYCLOAK_CLIENT_SECRET:-}" -d "username=${KEYCLOAK_TEST_USER:-sre-test-user}" \
  -d "password=${KEYCLOAK_TEST_PASSWORD:-}" 2>/dev/null || true)"
user_token="$(printf '%s' "$login_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true)"
[ ${#user_token} -gt 32 ] && ok "real Keycloak login succeeds for ${KEYCLOAK_TEST_USER:-sre-test-user}" || block "real Keycloak test-user login failed"
if [ ${#user_token} -gt 32 ] && python3 - "$user_token" <<'PY'
import base64,json,sys
part=sys.argv[1].split('.')[1]
payload=json.loads(base64.urlsafe_b64decode(part+'='*(-len(part)%4)))
roles=set(payload.get('roles',[])) | set(payload.get('realm_access',{}).get('roles',[]))
assert 'infra-read' in roles
PY
then ok "test user carries the infra-read entitlement"; else block "test-user role assignment could not be proven"; fi

for port_name in "3000:Manager" "3101:Keycloak specialist" "3102:Observability specialist"; do
  port="${port_name%%:*}"; name="${port_name#*:}"
  reachable "http://127.0.0.1:$port/health/ready" && ok "$name reachable" || block "$name unreachable"
done

readiness_ok=true
for port in 3000 3101 3102; do
  body="$(curl -sS --max-time 5 "http://127.0.0.1:$port/health/ready" 2>/dev/null || true)"
  printf '%s' "$body" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d.get("environmentMode")=="real-poc"
bad={"mock","direct","inprocess","http-local"}
assert not bad.intersection(d.get("dependencyModes",{}).values())
' >/dev/null 2>&1 || readiness_ok=false
done
$readiness_ok && ok "all runtimes are real-poc with no mock/direct/in-process dependency" || block "runtime mode proof unavailable or a mock-like dependency is configured"

thv="$state/bin/thv"
if [ -x "$thv" ]; then
  toolhive_ok=true
  for workload in sre-poc-keycloak sre-poc-prometheus sre-poc-wiki; do "$thv" status "$workload" >/dev/null 2>&1 || toolhive_ok=false; done
  $toolhive_ok && ok "ToolHive has Keycloak, Prometheus and Wiki workloads" || block "one or more ToolHive workloads are unavailable"
else
  block "ToolHive binary is not built"
fi
for endpoint_name in "8301:Keycloak MCP through ToolHive" "8302:Prometheus MCP through ToolHive" "8303:Wiki MCP through ToolHive"; do
  port="${endpoint_name%%:*}"; name="${endpoint_name#*:}"
  reachable "http://127.0.0.1:$port/mcp" && ok "$name reachable" || block "$name unreachable"
done

query() {
  local id="$1" question="$2" expected_agents="$3" expected_sources="$4" file
  file="$results/$id.json"
  if [ ${#user_token} -le 32 ]; then block "smoke $id cannot run without a real user token"; return; fi
  code="$(curl -sS --max-time 130 -o "$file" -w '%{http_code}' -X POST http://127.0.0.1:3000/v1/query \
    -H "authorization: Bearer $user_token" -H 'content-type: application/json' \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"question":sys.argv[1],"environment":"lab"}))' "$question")" 2>/dev/null || true)"
  if [ "$code" != "200" ]; then no "smoke $id returned HTTP ${code:-none}"; return; fi
  if python3 - "$file" "$expected_agents" "$expected_sources" <<'PY'
import json,sys
path, agent_csv, source_csv = sys.argv[1:]
d=json.load(open(path, encoding="utf-8"))
agents=set(d.get("metadata",{}).get("routedAgents",[]))
expected_agents=set(filter(None,agent_csv.split(',')))
labels=[c.get("label","") for c in d.get("citations",[])]
expected_sources=set(filter(None,source_csv.split(',')))
assert expected_agents.issubset(agents), (agents,expected_agents)
assert all(any(label.startswith(f"mcp://{source}/") for label in labels) for source in expected_sources), labels
assert not d.get("error"), d.get("error")
PY
  then ok "smoke $id real route/evidence contract"; else no "smoke $id missing expected routes or real MCP citations (see $file)"; fi
}

query A "What clients exist in the sre-test realm?" keycloak keycloak
query B "What does our documentation say about Keycloak authentication, and does the current Keycloak configuration match it?" keycloak wiki,keycloak
if ! reachable "$kc/realms/$realm/.well-known/openid-configuration"; then
  block "failed-login generation cannot run while Keycloak is unavailable"
elif "$root/scripts/generate-keycloak-login-failures.sh" 5 >"$results/login-failures.log" 2>&1; then
  ok "generated real failed Keycloak logins"
else
  no "failed to generate Keycloak login signals"
fi
query C "Is Keycloak healthy over the last 15 minutes?" observability prometheus
query D "Users are failing to log in to Keycloak. Is this caused by Keycloak configuration or runtime/service health?" keycloak,observability keycloak,prometheus

echo
echo "Summary: $pass PASS, $fail FAIL, $blocked BLOCKED"
echo "Machine-readable smoke responses: $results"
[ "$fail" -eq 0 ] && [ "$blocked" -eq 0 ]
