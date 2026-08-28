#!/usr/bin/env bash
# Generate a self-signed localhost cert so Keycloak can serve HTTPS on 8443.
# Required only for the Keycloak MCP path (it refuses cleartext http://).
# Dev only — the private key is gitignored and must never leave the machine.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/deploy/local/keycloak/certs"
mkdir -p "$DIR"
if [ -f "$DIR/tls.crt" ] && [ -f "$DIR/tls.key" ]; then
  echo "cert already present at $DIR (delete to regenerate)"; exit 0
fi
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$DIR/tls.key" -out "$DIR/tls.crt" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:keycloak,IP:127.0.0.1"
chmod 600 "$DIR/tls.key"
echo "wrote $DIR/tls.crt and tls.key"
