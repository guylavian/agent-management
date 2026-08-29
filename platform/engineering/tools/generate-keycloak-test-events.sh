#!/usr/bin/env bash
# Generate reproducible Keycloak login signals (1 success + N failures) against
# the local sre-test realm, then show the resulting user-event metrics.
#
# Usage: scripts/generate-keycloak-test-events.sh [failed_attempts]   (default 5)
set -euo pipefail

KC_HTTP_PORT="${KEYCLOAK_HTTP_PORT:-8080}"
KC_MGMT_PORT="${KEYCLOAK_MGMT_PORT:-9000}"
KC="http://localhost:${KC_HTTP_PORT}"
REALM="${KEYCLOAK_REALM:-sre-test}"
CLIENT_ID="${KEYCLOAK_CLIENT_ID:-sre-test-client}"
CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:-sre-test-client-secret}"
USERNAME="${KEYCLOAK_TEST_USER:-sre-test-user}"
PASSWORD="${KEYCLOAK_TEST_PASSWORD:-sre-test-password}"
FAILS="${1:-5}"

token_url="${KC}/realms/${REALM}/protocol/openid-connect/token"

echo "==> 1 successful login as ${USERNAME}"
code=$(curl -s -o /dev/null -w "%{http_code}" \
  -d "client_id=${CLIENT_ID}" -d "client_secret=${CLIENT_SECRET}" \
  -d "username=${USERNAME}" -d "password=${PASSWORD}" -d "grant_type=password" \
  "${token_url}")
echo "    http=${code} (expect 200)"

echo "==> ${FAILS} failed logins (wrong password)"
for i in $(seq 1 "${FAILS}"); do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -d "client_id=${CLIENT_ID}" -d "client_secret=${CLIENT_SECRET}" \
    -d "username=${USERNAME}" -d "password=WRONG-${i}" -d "grant_type=password" \
    "${token_url}")
  echo "    attempt ${i}: http=${code} (expect 401)"
done

echo "==> Keycloak user-event metrics (management port ${KC_MGMT_PORT})"
curl -s "http://localhost:${KC_MGMT_PORT}/metrics" \
  | grep -E "^keycloak_user_events_total.*realm=\"${REALM}\"" || \
  echo "    (no user-event metrics yet — check KC_EVENT_METRICS_USER_ENABLED)"

echo
echo "Now query Prometheus, e.g.:"
echo "  curl -s 'http://localhost:${PROMETHEUS_PORT:-9090}/api/v1/query?query=keycloak_user_events_total{realm=\"${REALM}\"}'"
