#!/usr/bin/env bash
set -euo pipefail

container="${KEYCLOAK_CONTAINER:-sre-keycloak}"
realm="${KEYCLOAK_REALM:-sre-test}"
admin="${KEYCLOAK_ADMIN:-admin}"
admin_password="${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD is required}"
test_user="${KEYCLOAK_TEST_USER:-sre-test-user}"
test_password="${KEYCLOAK_TEST_PASSWORD:?KEYCLOAK_TEST_PASSWORD is required}"
test_client="${KEYCLOAK_CLIENT_ID:-sre-test-client}"
test_client_secret="${KEYCLOAK_CLIENT_SECRET:?KEYCLOAK_CLIENT_SECRET is required}"
mcp_client="${KEYCLOAK_MCP_CLIENT_ID:-sre-mcp-reader}"
mcp_secret="${KEYCLOAK_MCP_CLIENT_SECRET:?KEYCLOAK_MCP_CLIENT_SECRET is required}"
workload_client="${SRE_WORKLOAD_CLIENT_ID:-sre-manager-workload}"
workload_secret="${SRE_WORKLOAD_CLIENT_SECRET:?SRE_WORKLOAD_CLIENT_SECRET is required}"

# kcadm's session config defaults to ~/.keycloak (on the full container overlay);
# redirect it to the host-mounted data dir via --config so it can be written.
kcadm() { docker exec "$container" /opt/keycloak/bin/kcadm.sh "$@" --config /opt/keycloak/data/kcadm.config; }
kcadm config credentials --server http://127.0.0.1:8080 --realm master --user "$admin" --password "$admin_password" >/dev/null

user_id="$(kcadm get users -r "$realm" -q "username=$test_user" --fields id --format csv --noquotes | head -1)"
test -n "$user_id"
kcadm set-password -r "$realm" --userid "$user_id" --new-password "$test_password" >/dev/null

set_client_secret() {
  local client_id="$1" secret="$2" uuid
  uuid="$(kcadm get clients -r "$realm" -q "clientId=$client_id" --fields id --format csv --noquotes | head -1)"
  test -n "$uuid"
  kcadm update "clients/$uuid" -r "$realm" -s "secret=$secret" >/dev/null
}

set_client_secret "$test_client" "$test_client_secret"
set_client_secret "$mcp_client" "$mcp_secret"
set_client_secret "$workload_client" "$workload_secret"
echo "Keycloak realm $realm bootstrapped with configurable local credentials."
