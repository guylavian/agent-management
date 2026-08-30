# On-prem required values

Everything the platform team must supply for a new environment, and why. No
value here has a working default; placeholders in the `*.example.yaml` files
are syntactically valid and functionally wrong on purpose.

Files: `runtime-values.example.yaml` (every agent), `portal-values.example.yaml`
(management console), `secrets.example.yaml` (out-of-band objects),
`argocd/params.env` (bootstrap).

## Git / Argo CD — `argocd/params.env`

| Value | Why |
|---|---|
| `GIT_REPO_URL` | Bitbucket Data Center clone URL `https://<host>/scm/<PROJECT>/<repo>.git`. Argo CD's only source; also the project's only trusted repo. |
| `GIT_REVISION` | Branch Argo CD tracks (the ApplicationSet discovers rendered agents on it). |
| `TARGET_NAMESPACE` | Namespace every agent and the portal land in. Must equal `environmentOverride.namespace`, because the Manager resolves specialists by `http://sre-agent-<id>.<namespace>.svc.cluster.local`. |
| `namespace:` in `argocd/kustomization.yaml` | The Argo CD namespace (`openshift-gitops` for OpenShift GitOps). |
| Secret `sre-agent-platform-repo` | Read credential for the repo, in the Argo CD namespace. |

## Images — both values files

| Value | Why |
|---|---|
| `image.repository`, `image.tag` | Internal registry path of the two images (`sre-agent-runtime`, `sre-agent-portal`). The cluster never reaches a public registry. |
| `imagePullSecrets[].name` + Secret `internal-registry` | Only if the registry requires auth. |

## OpenShift — both values files

| Value | Why |
|---|---|
| `securityContext.runAsUser/runAsGroup: null` (runtime) | The restricted SCC assigns a uid from the namespace range; a pinned uid is rejected. |
| `caBundle.enabled/create/configMap` | Enterprise CA for Keycloak, ToolHive, Bitbucket, PostgreSQL, vLLM behind internal PKI. `create: true` makes a ConfigMap labelled `config.openshift.io/inject-trusted-cabundle` that the cluster fills. TLS verification is never disabled. Each chart needs its own ConfigMap name. |
| `route.enabled/host` | Manager API and portal exposure through the OpenShift router. `routerNamespaceLabels` admits the router in NetworkPolicy. |
| `networkPolicy.dnsPorts: [53, 5353]` | OpenShift CoreDNS pods listen on 5353. |
| `networkPolicy.*PlatformPorts`, `platformNamespaceLabel` | Actual Service ports of vLLM/ToolHive/RHBK/PostgreSQL/OTel; label those namespaces `sre.ai/platform-service=true`. |
| `environmentOverride` (runtime) | Only if the namespace differs from `sre-assistant` — otherwise the image's `deploy/environments/production/environment.yaml` applies. |
| `telemetry.otlpEndpoint` or `exporter: console` | The OTel collector in this cluster; `console` if none. |

## Keycloak (RHBK) — ConfigMap `sre-agent-endpoints` and portal values

Two realms are assumed: one for people, one for agent workloads.

| Value | Why |
|---|---|
| `SRE_OIDC_ISSUER`, `SRE_OIDC_AUDIENCE`, `SRE_OIDC_JWKS_URI` | Verify the end-user token presented to the Manager. Required when `clients.oidc=real`. |
| `SRE_INTERNAL_OIDC_ISSUER/AUDIENCE/JWKS_URI` | Verify Manager→Specialist workload tokens. Required when `clients.agent=real`. The projected token audience is `workloadIdentity.audience` (default `sre-agent-runtime`). |
| `SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT`, `_ISSUER`, `_AUDIENCE_PREFIX`, `_JWKS_URI`, `_STRATEGY` | RFC 8693 token exchange for ToolHive; the audience per MCP server is `<prefix><server>` and must match the Cedar policies under `deploy/environments/production/rendered/toolhive/`. |
| `SRE_DELEGATION_ISSUER`, `SRE_DELEGATION_JWKS_URI` + Secret key `SRE_DELEGATION_PRIVATE_KEY_PKCS8` | Manager-signed delegation tokens specialists verify. |
| portal `oidc.metadataUrl`, `oidc.clientId` + Secret `sre-agent-portal-oidc` | Human sign-in to the console. |
| portal `runtime.oidc.tokenUrl/clientId` + Secret `sre-agent-portal-runtime-oidc` | Service credential the portal uses to call the Manager's management API. |
| portal `adminGroups` | Which IdP groups may propose Agent changes. Empty denies all writes. |

## ToolHive / MCP — ConfigMap `sre-agent-endpoints`

| Value | Why |
|---|---|
| `SRE_TOOLHIVE_URL` and/or `SRE_TOOLHIVE_ENDPOINTS_JSON` | Gateway URL (`/mcp/<server>` convention) or an explicit `{"<server id>": "<url>"}` map when the proxies have their own hostnames. Server ids are the MCP server names in `config/agents/*.yaml`. |
| Cedar authz files | Load `deploy/environments/production/rendered/toolhive/*.authz.yaml` into each ToolHive proxy; they are the default-deny per-agent tool allowlists. |

## Models — ConfigMap `sre-agent-endpoints`

| Value | Why |
|---|---|
| `SRE_LLM_TIER_S_URL`, `SRE_LLM_TIER_L_URL` (or `SRE_LLM_BASE_URL`) | Internal OpenAI-compatible endpoints (vLLM). No external model provider is reachable or configured. |
| `SRE_LLM_API_KEY` (Secret, optional) | Only if the internal endpoint enforces one. |
| served model ids | Come from `deploy/environments/production/model-bindings.yaml` (rendered into `SRE_MODEL_*`); change them there and re-render, not in values. |

## Data — Secrets

| Value | Why |
|---|---|
| `SRE_POSTGRES_URL` in `sre-agent-integrations` | Manager session store (`deploy/runtime/postgres/001_sessions.sql`). Use `sslmode=verify-full`. |
| `sre-agent-portal-postgres` (`host`,`port`,`user`,`password`) + `postgres.ssl` | Backstage catalog DB. |
| `sre-agent-portal-backend` (`secret`) | Signs Backstage service tokens; mandatory with >1 replica. |

## Bitbucket — portal values + Secret

| Value | Why |
|---|---|
| `gitops.provider: bitbucketServer`, `gitops.host`, `gitops.owner` (project key), `gitops.repo`, `gitops.baseBranch` | Where the console opens pull requests for Agent changes. |
| `sre-agent-portal-gitops` (`token`) | HTTP access token with write + PR permission on that repo. |

## Optional

| Value | Why |
|---|---|
| `SRE_ARGOCD_BASE_URL` + Secret `SRE_ARGOCD_TOKEN` | Lets the Manager report Argo sync state. Both or neither. |
| `extraEnv.SRE_REQUEST_DEADLINE_MS` | Slower on-prem models may need a longer request deadline. |
| `hpa`, `pdb`, `replicaCount` (per agent in `deploy/environments/production/agents/*.yaml`) | Capacity. |
