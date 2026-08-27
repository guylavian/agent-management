# Offline supply chain manifest

No runtime component may download from the internet. All artifacts are mirrored, scanned, and promoted internally with their digest/integrity metadata preserved.

- `package-lock.json` pins every npm artifact and integrity hash.
- `deploy/npm-packages.md` enumerates every locked npm package/version and is regenerated with `npm run gen:supply-chain`.
- `node:24.20.0-alpine3.22` is the only base image currently introduced; it supplies the pinned runtime with a small non-root-capable base.
- npm 11.7.0 manages the workspace and frozen lockfile; TypeScript, oxlint, Vitest, and autocannon are build/test tools only.
- Helm 3.18.3 is the pinned offline chart lint/render tool; the chart itself is versioned at 0.1.0.
- ToolHive, vLLM, model, retrieval, and enterprise MCP artifacts are not yet selected; adding them requires exact versions and immutable digests here before use.

Air-gap verification runs `npm ci --offline` against the internal mirror and builds containers with external egress disabled.
