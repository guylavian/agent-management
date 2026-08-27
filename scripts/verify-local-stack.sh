#!/usr/bin/env bash
# Verify the local PoC stack without a browser. Reports PASS / FAIL / SKIP per check.
# Configurable via env; sensible localhost defaults. Never fatal — runs all checks.
set -uo pipefail

KC_HTTP_PORT="${KEYCLOAK_HTTP_PORT:-8080}"
KC_MGMT_PORT="${KEYCLOAK_MGMT_PORT:-9000}"
PROM_PORT="${PROMETHEUS_PORT:-9090}"
REALM="${KEYCLOAK_REALM:-sre-test}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:8b}"
KEYCLOAK_MCP_ENDPOINT="${KEYCLOAK_MCP_ENDPOINT:-}"
PROMETHEUS_MCP_ENDPOINT="${PROMETHEUS_MCP_ENDPOINT:-}"

pass=0; fail=0; skip=0
ok()   { echo "[PASS] $1"; pass=$((pass+1)); }
no()   { echo "[FAIL] $1"; fail=$((fail+1)); }
sk()   { echo "[SKIP] $1"; skip=$((skip+1)); }

http_code() { curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$1" 2>/dev/null; }

# 1. Keycloak HTTP endpoint
c=$(http_code "http://localhost:${KC_HTTP_PORT}/realms/${REALM}/.well-known/openid-configuration")
[ "$c" = "200" ] && ok "Keycloak HTTP + ${REALM} realm (http://localhost:${KC_HTTP_PORT})" || no "Keycloak HTTP/realm (got ${c})"

# 2. Keycloak metrics endpoint (management port, NOT the app port)
c=$(http_code "http://localhost:${KC_MGMT_PORT}/metrics")
[ "$c" = "200" ] && ok "Keycloak metrics (http://localhost:${KC_MGMT_PORT}/metrics)" || no "Keycloak metrics (got ${c})"

# 3. Prometheus reachable
c=$(http_code "http://localhost:${PROM_PORT}/-/healthy")
[ "$c" = "200" ] && ok "Prometheus (http://localhost:${PROM_PORT})" || no "Prometheus (got ${c})"

# 4. Prometheus target for Keycloak is UP
up=$(curl -s --max-time 5 "http://localhost:${PROM_PORT}/api/v1/query?query=up%7Bjob%3D%22keycloak%22%7D" \
  | python3 -c "import sys,json;r=json.load(sys.stdin)['data']['result'];print(r[0]['value'][1] if r else '0')" 2>/dev/null)
[ "$up" = "1" ] && ok "Prometheus scrapes Keycloak (up{job=keycloak}=1)" || no "Prometheus Keycloak target not UP (up=${up:-none})"

# 5. Ollama reachable
c=$(http_code "${OLLAMA_URL}/api/tags")
[ "$c" = "200" ] && ok "Ollama (${OLLAMA_URL})" || no "Ollama (got ${c})"

# 6. qwen3:8b available
if [ "$(http_code "${OLLAMA_URL}/api/tags")" = "200" ]; then
  curl -s --max-time 5 "${OLLAMA_URL}/api/tags" | grep -q "\"${OLLAMA_MODEL}\"" \
    && ok "Model ${OLLAMA_MODEL} present" || no "Model ${OLLAMA_MODEL} missing (ollama pull ${OLLAMA_MODEL})"
else
  sk "Model ${OLLAMA_MODEL} (Ollama unreachable)"
fi

# 7. Keycloak MCP (only if configured)
if [ -n "${KEYCLOAK_MCP_ENDPOINT}" ]; then
  c=$(http_code "${KEYCLOAK_MCP_ENDPOINT}")
  { [ "$c" != "000" ] && [ -n "$c" ]; } && ok "Keycloak MCP reachable (${KEYCLOAK_MCP_ENDPOINT}, http ${c})" \
    || no "Keycloak MCP unreachable (${KEYCLOAK_MCP_ENDPOINT})"
else
  sk "Keycloak MCP (set KEYCLOAK_MCP_ENDPOINT to test)"
fi

# 8. Prometheus MCP (only if an HTTP endpoint is configured; the reference server is stdio)
if [ -n "${PROMETHEUS_MCP_ENDPOINT}" ]; then
  c=$(http_code "${PROMETHEUS_MCP_ENDPOINT}")
  { [ "$c" != "000" ] && [ -n "$c" ]; } && ok "Prometheus MCP reachable (${PROMETHEUS_MCP_ENDPOINT}, http ${c})" \
    || no "Prometheus MCP unreachable (${PROMETHEUS_MCP_ENDPOINT})"
else
  sk "Prometheus MCP HTTP check (reference server is stdio; see infra/README.md smoke test)"
fi

echo
echo "Summary: ${pass} pass, ${fail} fail, ${skip} skip"
[ "$fail" -eq 0 ]
