# Offline supply chain manifest

No runtime component may download from the internet. All artifacts are mirrored, scanned, and promoted internally with their digest/integrity metadata preserved.

- `package-lock.json` pins every npm artifact and integrity hash.
- `deploy/npm-packages.md` enumerates every locked npm package/version and is regenerated with `npm run gen:supply-chain`.
- `node:24.20.0-alpine3.22` supplies the pinned agent runtime with a small non-root-capable base.
- `quay.io/keycloak/keycloak:26.6` supplies the disposable local Keycloak backend and is never used as an agent image.
- `prom/prometheus:v2.55.1` supplies the disposable local Prometheus backend.
- `prometheus/prometheus-mcp` tag `v0.18.0` is cloned and built locally by `engineering/tools/prepare-real-poc.sh`; it is the only Prometheus MCP implementation.
- `stacklok/toolhive` tag `v0.28.3` is cloned and built locally by `engineering/tools/prepare-real-poc.sh`; its remote-proxy workloads are the only real MCP access path.
- `/Users/guylavian/Projects/Active/mcp/keycloak-mcp-server` is the required existing Keycloak MCP source. Its Python dependencies remain governed by that project's lockfile and must be mirrored before air-gap promotion.
- npm 11.7.0 manages the workspace and frozen lockfile; TypeScript, oxlint, Vitest, and autocannon are build/test tools only.
- Helm 3.18.3 is the pinned offline chart lint/render tool; the chart itself is versioned at 0.1.0.
- The real model and LLM Wiki MCP endpoints remain environment-selected because they are existing local/enterprise services; their promoted model and image digests must be added before air-gap promotion.

Air-gap verification runs `npm ci --offline` against the internal mirror and builds containers with external egress disabled.
