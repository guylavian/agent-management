# Deployment validation — 2026-08-30

What was actually run on a laptop (Docker Desktop 29.7, Helm 3.18.3,
kubectl kustomize) against the on-prem example values. No OpenShift cluster was
available; cluster-side behaviour (SCC admission, Route, CA injection,
NetworkPolicy enforcement) is reasoned from the rendered manifests and stated
as such.

## Charts

| Check | Runtime chart | Portal chart | Result |
|---|---|---|---|
| `helm lint` (defaults) | ✅ | ✅ | 0 failures |
| `helm lint` (on-prem example values + rendered agent) | ✅ manager, openshift | ✅ | 0 failures |
| `helm template` renders | 7 objects (manager: Deployment, Service, SA, ConfigMap×2, NetworkPolicy, Route) / 6 (specialist) | 7 (Deployment, Service, SA, ConfigMap×2, NetworkPolicy, Route) | PASS |
| no `runAsUser`/`runAsGroup` when values null | ✅ omitted | n/a (never pinned) | PASS |
| `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, drop ALL, seccomp RuntimeDefault | ✅ | ✅ | PASS |
| probes, requests/limits, replicas, imagePullSecrets, CA volume + `NODE_EXTRA_CA_CERTS` | ✅ | ✅ | PASS |
| embedded secrets in rendered output (`grep` for password/PRIVATE/stringData/api key) | none | none (only `secretKeyRef` names) | PASS |
| `platform/tools/check-tracked-files.ts` (repo credential guard) | 474 files, no credentials | | PASS |
| `platform/tests` (incl. `render-pipeline.test.ts` pinning the ApplicationSet) | 471 passed | | PASS |

## Env names vs application

Rendered env names were cross-checked against
`platform/shared/config-loader/src/app-config.ts` (runtime) and
`platform/management/portal/app-config*.yaml` (portal). Mismatches found and
fixed in the charts:

- Portal set `POSTGRES_CONNECTION`; the app reads `POSTGRES_HOST/PORT/USER/PASSWORD` → chart now maps the Secret's four keys.
- Portal never set `SRE_MANAGEMENT_OIDC_*` (portal→Manager credential) nor `backend.auth.keys` (mandatory with >1 replica) nor the public `baseUrl` (was `localhost:7007` from the image) → now values + a chart-rendered `app-config.cluster.yaml`.
- Runtime projected `SRE_WORKLOAD_TOKEN_FILE` for the manager only; `loadAppConfig` requires it for **every** role when `clients.agent=real`, so a production specialist crash-looped → now projected for both modes (verified: the specialist container failed before, starts after).

## Containers (representative on-prem values)

Runtime image built from `deploy/runtime/Dockerfile` with `--build-arg BASE_IMAGE`.
Started with `--read-only --tmpfs /tmp --user 1000450000:0` (arbitrary uid, as
the restricted SCC assigns), the ConfigMap/Secret env from `secrets.example.yaml`
(placeholders replaced by throwaway keys generated locally, never committed),
a mounted CA bundle, a mounted projected token file and delegation public key:

| Role | `SRE_ENV` | clients | Result |
|---|---|---|---|
| manager (`config/agents/manager.yaml`) | production | all `real` | starts; `/health/live` 200, `/health/ready` 200 `{"status":"ready","environmentMode":"production",...}` |
| specialist (`config/agents/openshift.yaml`) | production | all `real` | starts; `/health/ready` 200 |

Endpoints were unreachable hosts (`*.example.internal`); startup validates
presence, not reachability, which matches the fail-closed contract. A missing
variable produces `ConfigValidationError: unsafe configuration: - <reason>`.

**Portal image: NOT built/tested here.** `deploy/portal/Dockerfile` requires a
host-side `yarn install && yarn build:backend`; on this machine `yarn install`
fails compiling native modules (`better-sqlite3`, `cpu-features`) with node-gyp
(host node 20 vs image node 24). Chart rendering and config wiring for the
portal are validated statically only.

## Argo CD

- `kubectl kustomize deploy/on-prem/argocd` builds; repo URL, revision,
  Argo namespace and destination namespace replaced in AppProject,
  ApplicationSet (generator + both sources) and the portal Application. PASS
- `applicationsets/runtime.yaml` was single-`source` with a `$values/...`
  path, which Argo only resolves in multi-source Applications → converted to
  the same two-source shape the local twin already used. Fixed.
- AppProject whitelist lacked `ConfigMap` (already rendered by the chart when
  `configOverride` is set) and `Route` → added. Cluster-scoped whitelist stays
  empty; no cluster-admin anywhere.

## Reasoned, not executed (needs a cluster)

- OpenShift restricted-v2 SCC: no pinned uid/gid, non-root, no capabilities,
  RuntimeDefault seccomp, no hostPath → expected to admit.
- `config.openshift.io/inject-trusted-cabundle` label → cluster fills
  `ca-bundle.crt`; verify with `oc get cm sre-agent-trusted-ca -o jsonpath='{.data}'`.
- `environmentOverride` subPath mount over the image's `environment.yaml`.
- NetworkPolicy: manager ingress from router namespace when `route.enabled`;
  CoreDNS 5353 egress; portal→manager needs `sre.ai/api-client=true` on the
  target namespace (INSTALL.md).

## Air-gap audit (runtime Internet dependencies)

| Dependency | Kind | Status |
|---|---|---|
| Model provider | runtime | internal only: `SRE_LLM_TIER_*_URL`; no external provider default in the runtime. (`api.groq.com` appears only in a unit test.) |
| Keycloak JWKS, ToolHive, PostgreSQL, OTel | runtime | internal URLs from ConfigMap/Secret; TLS via `NODE_EXTRA_CA_CERTS` (never disabled) |
| Bitbucket REST | runtime (portal) | internal host from `gitops.host` |
| `node:24-alpine`, `node:24-trixie-slim` | build | `--build-arg BASE_IMAGE` → mirror |
| npm / yarn registry | build | `--build-arg NPM_REGISTRY` → mirror (lockfile integrity hashes still enforced) |
| Debian apt (`libsqlite3-dev`, portal image) | build | mirror required, or drop `better-sqlite3` (production uses pg) — code change, not made here |
| `bootstrap-local.sh` fetches Argo CD from raw.githubusercontent.com | local dev only | not in the on-prem path (managed Argo CD) |
| **Google Fonts** `<link>` in `platform/management/portal/packages/app/public/index.html` | runtime (browser) | **remaining**: air-gapped browsers fall back to Helvetica/Arial (the CSS stack already lists them) but the page issues a blocked request. Required code change: remove the two `fonts.googleapis.com` lines or bundle the font. Not changed here (outside `deploy/`). |

## Not covered

- Cedar policy loading into ToolHive and RHBK realm/client creation are
  managed-service steps; the rendered inputs live under
  `deploy/environments/production/rendered/toolhive/`.
- A namespace other than `sre-assistant` was not exercised end to end; the
  path is `environmentOverride` + `TARGET_NAMESPACE`.
