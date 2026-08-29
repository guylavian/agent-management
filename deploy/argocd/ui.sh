#!/usr/bin/env bash
# Open the Argo CD UI against Docker Desktop Kubernetes.
#
#   ./deploy/argocd/ui.sh
#
# Port-forward rather than an Ingress or a LoadBalancer: nothing about the local
# cluster's exposure should look like a deployment decision.
set -euo pipefail

port="${ARGOCD_PORT:-8080}"
echo "user:     admin"
echo "password: $(kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d)"
echo "url:      https://localhost:${port}  (self-signed certificate)"
echo
exec kubectl -n argocd port-forward svc/argocd-server "${port}:443"
