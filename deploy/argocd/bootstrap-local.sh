#!/usr/bin/env bash
# Bootstrap Argo CD on Docker Desktop Kubernetes and hand it this repository.
#
# This script is the ONLY place kubectl apply is used for anything that is not
# Argo CD itself or its credentials. Every agent workload is owned by Argo, so
# reverting a change means reverting a commit, not running a command.
#
#   ./deploy/argocd/bootstrap-local.sh
#
# Repository credentials are read from the environment or the gh CLI and written
# straight into a Kubernetes Secret. Nothing credential-shaped is ever written to
# a file in this repository.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_url="${SRE_GIT_REPO_URL:-https://github.com/guylavian/agent-management.git}"
argocd_version="${ARGOCD_VERSION:-stable}"

ctx="$(kubectl config current-context)"
[ "${ctx}" = "docker-desktop" ] || { echo "refusing to run: context is '${ctx}', expected 'docker-desktop'" >&2; exit 1; }

echo "==> installing Argo CD"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
# --server-side: the ApplicationSet CRD's schema exceeds the 256 KiB
# last-applied-configuration annotation that client-side apply writes.
kubectl apply --server-side --force-conflicts -n argocd -f \
  "https://raw.githubusercontent.com/argoproj/argo-cd/${argocd_version}/manifests/install.yaml"

echo "==> waiting for Argo CD"
kubectl -n argocd rollout status deploy/argocd-repo-server --timeout=300s
kubectl -n argocd rollout status deploy/argocd-applicationset-controller --timeout=300s
kubectl -n argocd rollout status deploy/argocd-server --timeout=300s
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=300s

# --- repository credentials -------------------------------------------------
# A private repo needs a token. Prefer an explicit env var; fall back to the gh
# CLI so a developer never has to paste a secret into a shell history. The token
# lands only in a Secret; `stringData` is not echoed back by this script.
echo "==> connecting ${repo_url}"
token="${SRE_GIT_TOKEN:-}"
if [ -z "${token}" ] && command -v gh >/dev/null 2>&1; then
  token="$(gh auth token 2>/dev/null || true)"
fi
if [ -z "${token}" ]; then
  echo "no credentials: set SRE_GIT_TOKEN or run 'gh auth login'" >&2
  echo "(a public repository needs no credential — delete the secret and re-run)" >&2
  exit 1
fi

# The label is what makes Argo CD adopt this Secret as a repository entry.
# username is ignored by GitHub for token auth but required by the credential
# shape, so it stays generic rather than provider-specific.
#
# Built as a manifest on stdin rather than `--from-literal=password=...`: an
# argument is visible in `ps` to every other user on the machine for as long as
# kubectl runs. stdin is not.
kubectl apply -f - <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: sre-agent-platform-repo
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: ${repo_url}
  username: git
  password: ${token}
YAML

# --- integrations secret ----------------------------------------------------
# The chart mounts this via envFrom; the pod does not start without it. Locally
# it carries the shared mock-delegation secret and nothing else. Real endpoints
# and keys belong here too in a real cluster — never in Git.
echo "==> creating integrations secret"
kubectl create namespace sre-assistant --dry-run=client -o yaml | kubectl apply -f -
kubectl -n sre-assistant create secret generic sre-agent-integrations \
  --from-literal=SRE_DELEGATION_MOCK_SECRET="${SRE_DELEGATION_MOCK_SECRET:-local-shared-delegation-secret-change-me-0001}" \
  --dry-run=client -o yaml | kubectl apply -f -

# --- desired state ----------------------------------------------------------
# From here on Git is in charge. These two objects are the last manual apply.
echo "==> applying project + ApplicationSet"
kubectl apply -f "${here}/projects/sre-agent-platform.yaml"
kubectl apply -f "${here}/applicationsets/runtime-local.yaml"

echo
echo "OK. Argo CD is reconciling ${repo_url} (branch main, environment local)."
echo "    verify:  ./deploy/argocd/verify.sh"
echo "    UI:      ./deploy/argocd/ui.sh"
