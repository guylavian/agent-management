#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
env_file="${REAL_POC_ENV_FILE:-$root/.env.real-poc}"
state="$root/.real-poc"
bin="$state/bin"
logs="$state/logs"
pids="$state/pids"
mkdir -p "$logs" "$pids"

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file; copy .env.real-poc.example and set local secrets." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

required=(KEYCLOAK_ADMIN_PASSWORD KEYCLOAK_CLIENT_SECRET KEYCLOAK_TEST_PASSWORD KEYCLOAK_MCP_CLIENT_SECRET SRE_WORKLOAD_CLIENT_SECRET SRE_LLM_BASE_URL SRE_MODEL_MANAGER SRE_MODEL_TOOL_CALLER SRE_MODEL_SYNTHESIS LLM_WIKI_MCP_ENDPOINT)
for name in "${required[@]}"; do
  test -n "${!name:-}" || { echo "$name is required" >&2; exit 1; }
done

docker info >/dev/null
test -x "$bin/thv" && test -x "$bin/prometheus-mcp" || "$root/scripts/prepare-real-poc.sh"
"$root/scripts/gen-keycloak-cert.sh"
chmod +x "$root/scripts/gen-manager-cert.sh"; "$root/scripts/gen-manager-cert.sh"
docker compose --env-file "$env_file" -f "$root/deploy/local/compose.yaml" -f "$root/deploy/local/keycloak/tls.override.yml" up -d

wait_http() {
  local url="$1" label="$2"
  for _ in $(seq 1 90); do
    code="$(curl -ksS -o /dev/null -w '%{http_code}' --max-time 2 "$url" || true)"
    if [ "$code" != "000" ]; then return 0; fi
    sleep 1
  done
  echo "$label did not become reachable at $url" >&2
  return 1
}

wait_http "http://127.0.0.1:${KEYCLOAK_MGMT_PORT:-9000}/health/ready" Keycloak
"$root/scripts/bootstrap-keycloak-real-poc.sh"
wait_http "http://127.0.0.1:${PROMETHEUS_PORT:-9090}/-/healthy" Prometheus
wait_http "$LLM_WIKI_MCP_ENDPOINT" "LLM Wiki MCP"
llm_probe="${SRE_LLM_BASE_URL%/}"
if [[ "$llm_probe" == */v1 ]]; then llm_probe="$llm_probe/models"; else llm_probe="$llm_probe/v1/models"; fi
wait_http "$llm_probe" "real LLM"

if [ ! -f "$state/delegation-private.pem" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$state/delegation-private.pem"
  openssl pkey -in "$state/delegation-private.pem" -pubout -out "$state/delegation-public.pem"
  chmod 600 "$state/delegation-private.pem"
fi

start_background() {
  local name="$1"; shift
  if [ -f "$pids/$name.pid" ] && kill -0 "$(cat "$pids/$name.pid")" 2>/dev/null; then return 0; fi
  nohup "$@" >"$logs/$name.log" 2>&1 &
  echo "$!" >"$pids/$name.pid"
}

keycloak_mcp_project="${KEYCLOAK_MCP_PROJECT:-/Users/guylavian/Projects/Active/mcp/keycloak-mcp-server}"
test -f "$keycloak_mcp_project/pyproject.toml" || { echo "Keycloak MCP project not found: $keycloak_mcp_project" >&2; exit 1; }
start_background keycloak-mcp env \
  KEYCLOAK_URL="https://127.0.0.1:${KEYCLOAK_HTTPS_PORT:-8443}" \
  KEYCLOAK_REALM="${KEYCLOAK_REALM:-sre-test}" \
  KEYCLOAK_CLIENT_ID="${KEYCLOAK_MCP_CLIENT_ID:-sre-mcp-reader}" \
  KEYCLOAK_CLIENT_SECRET="$KEYCLOAK_MCP_CLIENT_SECRET" \
  KEYCLOAK_VERIFY_TLS=false KEYCLOAK_ALLOW_SECRET_READS=false MCP_ENABLE_WRITES=false \
  MCP_TRANSPORT=streamable-http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=8201 MCP_HTTP_PATH=/mcp \
  uv run --project "$keycloak_mcp_project" keycloak-mcp-server

start_background prometheus-mcp env \
  PROMETHEUS_MCP_SERVER_PROMETHEUS_URL="http://127.0.0.1:${PROMETHEUS_PORT:-9090}" \
  "$bin/prometheus-mcp" --mcp.transport=http --web.listen-address=127.0.0.1:8202 \
  --mcp.tools=query --mcp.tools=range_query --mcp.tools=metric_metadata --mcp.tools=label_names \
  --mcp.tools=label_values --mcp.tools=series --mcp.tools=list_targets --mcp.tools=healthy \
  --mcp.tools=ready --mcp.tools=runtime_info --mcp.tools=build_info

wait_http http://127.0.0.1:8201/mcp "Keycloak MCP"
wait_http http://127.0.0.1:8202/mcp "Prometheus MCP"

common_env=(
  SRE_ENV=real-poc SRE_CLIENT_OIDC=real SRE_CLIENT_LLM=real SRE_CLIENT_TOOLHIVE=real
  SRE_CLIENT_POSTGRES=disabled SRE_CLIENT_AGENT=real SRE_CLIENT_DELEGATION=real
  SRE_OIDC_ISSUER="http://localhost:${KEYCLOAK_HTTP_PORT:-8080}/realms/${KEYCLOAK_REALM:-sre-test}"
  SRE_OIDC_AUDIENCE=sre-assistant
  SRE_OIDC_JWKS_URI="http://127.0.0.1:${KEYCLOAK_HTTP_PORT:-8080}/realms/${KEYCLOAK_REALM:-sre-test}/protocol/openid-connect/certs"
  SRE_INTERNAL_OIDC_ISSUER="http://localhost:${KEYCLOAK_HTTP_PORT:-8080}/realms/${KEYCLOAK_REALM:-sre-test}"
  SRE_INTERNAL_OIDC_AUDIENCE=sre-agent-runtime
  SRE_INTERNAL_OIDC_JWKS_URI="http://127.0.0.1:${KEYCLOAK_HTTP_PORT:-8080}/realms/${KEYCLOAK_REALM:-sre-test}/protocol/openid-connect/certs"
  SRE_LLM_BASE_URL="$SRE_LLM_BASE_URL" SRE_MODEL_MANAGER="$SRE_MODEL_MANAGER"
  SRE_MODEL_TOOL_CALLER="$SRE_MODEL_TOOL_CALLER" SRE_MODEL_SYNTHESIS="$SRE_MODEL_SYNTHESIS"
  SRE_TOOLHIVE_ENDPOINTS_JSON='{"keycloak":"http://127.0.0.1:8301/mcp","prometheus":"http://127.0.0.1:8302/mcp","wiki":"http://127.0.0.1:8303/mcp"}'
  SRE_TOOL_CREDENTIAL_STRATEGY=signed-jwt SRE_TOOL_CREDENTIAL_ISSUER=http://127.0.0.1:3000
  SRE_TOOL_CREDENTIAL_PRIVATE_KEY_FILE="$state/delegation-private.pem"
  SRE_DELEGATION_ISSUER=http://127.0.0.1:3000 SRE_DELEGATION_PRIVATE_KEY_FILE="$state/delegation-private.pem"
  SRE_DELEGATION_PUBLIC_KEY_FILE="$state/delegation-public.pem"
  SRE_WORKLOAD_TOKEN_ENDPOINT="http://127.0.0.1:${KEYCLOAK_HTTP_PORT:-8080}/realms/${KEYCLOAK_REALM:-sre-test}/protocol/openid-connect/token"
  SRE_WORKLOAD_CLIENT_ID="${SRE_WORKLOAD_CLIENT_ID:-sre-manager-workload}" SRE_WORKLOAD_CLIENT_SECRET="$SRE_WORKLOAD_CLIENT_SECRET"
  SRE_REQUEST_DEADLINE_MS=120000 SRE_DEFAULT_ENVIRONMENT=lab SRE_OTEL_EXPORTER=console
)
if [ -n "${SRE_LLM_API_KEY:-}" ]; then common_env+=(SRE_LLM_API_KEY="$SRE_LLM_API_KEY"); fi

start_runtime() {
  local name="$1" port="$2" config="$3"; shift 3
  start_background "$name" env "${common_env[@]}" "$@" SRE_PORT="$port" AGENT_CONFIG="$config" SRE_DEPLOYMENT_ENVIRONMENT_DIR=deploy/environments/poc \
    node --import tsx "$root/runtime/app/src/server.ts"
  wait_http "http://127.0.0.1:$port/health/ready" "$name"
}

# The Manager runs the CANONICAL manager Agent. Its effective catalog is bounded to
# keycloak+observability by deploy/environments/poc, not by a second manager document:
# the other three agents are canonical but not enabled in this environment.
#
# Manager also serves its internal JWKS over loopback HTTPS (:3443) because ToolHive's
# JWKS-fetch client requires an https scheme. The mkcert-signed cert is trusted by the
# system store (scripts/gen-manager-cert.sh -> mkcert -install), so ToolHive verifies it.
start_runtime manager 3000 config/agents/manager.yaml \
  SRE_INTERNAL_TLS_CERT_FILE="$state/manager-tls.crt" SRE_INTERNAL_TLS_KEY_FILE="$state/manager-tls.key" SRE_INTERNAL_TLS_PORT=3443
start_runtime keycloak-agent 3101 config/agents/keycloak.yaml
start_runtime observability-agent 3102 config/agents/observability.yaml

# the gateway policy is derived from the canonical Agent config, so it is
# re-rendered here rather than trusted to be current on disk
(cd "$root" && npm run --silent render:toolhive >/dev/null)

thv="$bin/thv"
"$thv" group create sre-real-poc >/dev/null 2>&1 || true
for workload in sre-poc-keycloak sre-poc-prometheus sre-poc-wiki; do "$thv" rm "$workload" >/dev/null 2>&1 || true; done

# Two independent gateway-side bounds, deliberately not one:
#   --tools        the proxy exposes only approved tools at all (server-wide)
#   --authz-config Cedar, per-Agent: which workload may call which of them
# The runtime enforces its own allowlist regardless; none of the three is
# permitted to be the only thing standing between an Agent and a tool.
run_proxy() {
  local endpoint="$1" name="$2" port="$3" audience="$4" tools="$5" mcp="$6"
  # --tools is a StringArray (no comma splitting): pass each tool as its own flag
  # so the allow-list is an exact-match set, not one bogus comma-joined entry.
  local tool_args=() t
  IFS=',' read -ra _tarr <<< "$tools"
  for t in "${_tarr[@]}"; do tool_args+=(--tools "$t"); done
  local authz="$root/deploy/environments/poc/rendered/toolhive/$mcp.authz.yaml"
  test -f "$authz" || { echo "missing rendered ToolHive policy for $mcp; run npm run render:toolhive" >&2; exit 1; }
  "$thv" run "$endpoint" --name "$name" --group sre-real-poc --proxy-port "$port" "${tool_args[@]}" \
    --transport streamable-http \
    --authz-config "$authz" \
    --oidc-issuer http://127.0.0.1:3000 \
    --oidc-jwks-url https://127.0.0.1:3443/internal/.well-known/jwks.json \
    --oidc-audience "$audience" --oidc-insecure-allow-http --jwks-allow-private-ip --enable-audit
}

run_proxy http://127.0.0.1:8201/mcp sre-poc-keycloak 8301 sre-toolhive:keycloak \
  keycloak_read,keycloak_health,list_realms,list_clients,get_client,find_user,resolve_client_uuid keycloak
run_proxy http://127.0.0.1:8202/mcp sre-poc-prometheus 8302 sre-toolhive:prometheus \
  query,range_query,metric_metadata,label_names,label_values,series,list_targets,healthy,ready,runtime_info,build_info prometheus
run_proxy "$LLM_WIKI_MCP_ENDPOINT" sre-poc-wiki 8303 sre-toolhive:wiki wiki_search,wiki_read_page,wiki_route wiki

echo "Real PoC started. Run: $root/scripts/verify-real-poc.sh"
