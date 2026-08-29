#!/usr/bin/env bash
# Generates the manager's loopback TLS cert (used to serve the internal JWKS over
# HTTPS for ToolHive). Signed by the mkcert local CA so the system trust store
# verifies it — run `mkcert -install` once to trust that CA.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
state="$root/.real-poc"
crt="$state/manager-tls.crt"
key="$state/manager-tls.key"

if [ -f "$crt" ] && [ -f "$key" ]; then
  exit 0
fi

command -v mkcert >/dev/null 2>&1 || { echo "mkcert is required: brew install mkcert && mkcert -install" >&2; exit 1; }
mkdir -p "$state"
mkcert -cert-file "$crt" -key-file "$key" 127.0.0.1 localhost >/dev/null
chmod 600 "$key"
echo "Manager TLS cert generated at $crt. Ensure 'mkcert -install' has trusted the local CA."
