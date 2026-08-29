#!/usr/bin/env bash
# Verifies the rendered ToolHive authorization policies against ToolHive's OWN
# Cedar engine, rather than against our belief about what it does.
#
# It found two real defects the TypeScript tests could not: ToolHive refuses to
# start a proxy whose policy set is empty, and Cedar ERRORS rather than denying
# when a policy reads an attribute the principal lacks. Both would have shipped.
#
#   npm run verify:toolhive-policy
#
# Requires the vendored ToolHive source (engineering/tools/prepare-real-poc.sh) and Go.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
toolhive="${TOOLHIVE_SRC:-$root/.real-poc/src/toolhive}"

if [ ! -f "$toolhive/go.mod" ]; then
  echo "BLOCKED: ToolHive source not found at $toolhive — run engineering/tools/prepare-real-poc.sh" >&2
  exit 1
fi
command -v go >/dev/null || { echo "BLOCKED: Go toolchain not available" >&2; exit 1; }

# the test must live inside ToolHive's module to import its internal packages
mkdir -p "$toolhive/sre-policy-check"
cp "$root/engineering/tools/toolhive-policy-check/main_test.go" "$toolhive/sre-policy-check/"
cd "$toolhive"
SRE_REPO="$root" go test ./sre-policy-check/...
