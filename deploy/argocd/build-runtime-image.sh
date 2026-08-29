#!/usr/bin/env bash
# Build THE shared runtime image and make it available to Docker Desktop
# Kubernetes without any registry.
#
# One image serves the Manager and every Specialist. There is deliberately no
# per-agent build: roles differ by configuration, which is what stops
# Manager/Specialist version skew.
#
#   ./deploy/argocd/build-runtime-image.sh [tag]
set -euo pipefail

tag="${1:-local}"
image="sre-agent-runtime:${tag}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Build context is the repository root — the Dockerfile mirrors the repo layout
# so relative paths resolve identically in the image and in a working tree.
echo "building ${image}"
docker build -f "${root}/deploy/runtime/Dockerfile" -t "${image}" "${root}"

# Docker Desktop's Kubernetes runs in its own containerd namespace, so an image
# in the local Docker daemon is NOT automatically visible to the kubelet. Load
# it explicitly. imagePullPolicy: Never then guarantees the cluster never
# reaches for a registry — which is the same air-gapped posture as production,
# just proved on a laptop.
node="$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')"
if docker exec "${node}" true 2>/dev/null; then
  echo "loading ${image} into node ${node}"
  docker save "${image}" | docker exec -i "${node}" ctr --namespace k8s.io images import -
else
  echo "node ${node} is not a docker container; assuming a shared image store"
fi

echo "OK: ${image}"
