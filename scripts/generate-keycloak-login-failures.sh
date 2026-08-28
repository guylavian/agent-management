#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${REAL_POC_ENV_FILE:-$root/.env.real-poc}"
if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi
exec "$root/scripts/generate-keycloak-test-events.sh" "${1:-5}"
