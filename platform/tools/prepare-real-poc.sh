#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"   # platform/
repo="$(cd "$root/.." && pwd)"            # git root; deploy/ is a sibling of platform/
state="$root/.real-poc"
src="$state/src"
bin="$state/bin"
mkdir -p "$src" "$bin"

prometheus_mcp_version="${PROMETHEUS_MCP_VERSION:-v0.18.0}"
toolhive_version="${TOOLHIVE_VERSION:-v0.46.0}"
kubernetes_mcp_version="${KUBERNETES_MCP_VERSION:-v0.0.66}"

clone_pinned() {
  local url="$1" version="$2" target="$3"
  if [ ! -d "$target/.git" ]; then
    git clone --branch "$version" --depth 1 "$url" "$target"
  fi
  test "$(git -C "$target" describe --tags --exact-match 2>/dev/null)" = "$version" || {
    echo "$target is not pinned to $version" >&2
    exit 1
  }
}

clone_pinned https://github.com/prometheus/prometheus-mcp.git "$prometheus_mcp_version" "$src/prometheus-mcp"
clone_pinned https://github.com/stacklok/toolhive.git "$toolhive_version" "$src/toolhive"
clone_pinned https://github.com/containers/kubernetes-mcp-server.git "$kubernetes_mcp_version" "$src/kubernetes-mcp"

(
  cd "$src/prometheus-mcp"
  git submodule update --init --recursive
  GOTOOLCHAIN=auto go build -trimpath -o "$bin/prometheus-mcp" ./cmd/prometheus-mcp-server
)
(
  cd "$src/toolhive"
  GOTOOLCHAIN=auto go build -trimpath -o "$bin/thv" ./cmd/thv
)
(
  cd "$src/kubernetes-mcp"
  GOTOOLCHAIN=auto go build -trimpath -o "$bin/kubernetes-mcp" ./cmd/kubernetes-mcp-server
)

"$bin/prometheus-mcp" --version
"$bin/thv" version
"$bin/kubernetes-mcp" --version
