# Development

## Prerequisites

- Node 24.20.0 (`.nvmrc`) for the runtime
- Node 22 or 24 **plus corepack/yarn 4** for the Backstage portal
- Helm (for `validate:deploy`)
- Docker (for the real local PoC)

## Install

```bash
cd platform            # the Git root is a shell; this is the npm workspace root
npm install              # contracts + runtime + management packages
npm run install:portal   # Backstage (yarn 4, separate workspace)
```

The portal is a separate yarn workspace on purpose — see
[monorepo.md](architecture/monorepo.md).

## Run

```bash
npm run dev:runtime   # manager + in-process specialists
npm run dev:portal    # Backstage app :3000, backend :7007
npm run dev           # both
```

Point the portal at the runtime:

```bash
export SRE_MANAGEMENT_API_URL=http://localhost:3000
export SRE_MANAGEMENT_API_TOKEN=<a human token from /dev/token/alice>
```

Without these the portal renders "not configured" on every management page,
which is intentional: an empty console must not be mistakable for a real,
empty platform.

## Check

```bash
npm run check         # typecheck + lint + boundaries + tests + YAML + both Helm charts
npm run check:portal  # Backstage typecheck
npm run build         # runtime typecheck + portal bundles
```

`npm run check` is the single command that validates the runtime monorepo. It
must pass before every commit.

## Real local PoC

```bash
npm run real-poc:prepare
npm run real-poc:start
npm run real-poc:verify
```

Runs real Keycloak, Prometheus, ToolHive proxies and MCP servers. Mocks are for
unit tests and explicit fixtures only — no `mock`, `direct`, `inprocess` or
ToolHive-bypassing fallback may be silently activated, and `loadAppConfig`
rejects any of them in `real-poc` or `production`.

## Adding an Agent

Preferably through the portal (Create Agent → Preview YAML → Create Pull
Request). By hand:

1. write `config/agents/<name>.yaml` — identity, routing, access and limits, all
   in one file (see [agent-policy.md](architecture/agent-policy.md))
2. write `config/prompts/<name>.md`
3. if a new MCP server is involved, add `config/mcp-servers/<server>.yaml`; only
   `readOnlyVerified` tools may be approved
4. enable it where it should run: `deploy/environments/<env>/agents/<name>.yaml`
5. `npm run render:deploy && npm run check`

There is deliberately no routing registry to update, and nothing to add to
`config/agents/manager.yaml`: the Manager's catalog is derived from step 1
(the Agent's own `lifecycle`) intersected with step 4 (`enabled` in that
environment). The Manager document has no `agents.allowed` field, and a
leftover one is a schema error rather than a silently ignored block.

The Manager re-reads both while it runs, so a merged pull request takes effect
without a restart.

### Lifecycle

    draft ─▶ pending-merge ─▶ reconciling ─▶ active
                                  │             │
                                  ├─▶ degraded ─┤   actual state failed
                                  └─▶ failed        desired state invalid

    active ─▶ reconciling ─▶ disabled                 (and back on re-enable)

- **draft** — the Agent document is merged, but its own `lifecycle` says it is
  not meant to run. Distinct from *disabled*: nothing was turned off.
- **pending-merge** — an open pull request. Only the management plane can see
  this; the runtime reads the repository as Argo synced it.
- **reconciling** — desired and actual state do not agree yet. A *disable* also
  passes through here: while Argo still holds the Application the workload is
  being pruned, and reporting `disabled` then would claim a pod is gone while
  it is still serving.
- **degraded / failed** — a merged Agent whose deployment failed stays listed
  with the signal that caused it, rather than disappearing.

Routing is `lifecycle active ∩ enabled here ∩ not observed failing`. The last
term fails OPEN on `unknown`: a deployment with no probe wired observes nothing,
and treating that as unavailable would empty the catalog. Only a positive
observation of failure removes an Agent. Set `SRE_RUNTIME_PROBE=on` and
`SRE_ARGOCD_BASE_URL`/`SRE_ARGOCD_TOKEN` to have actual state observed at all;
without them the console reports `unknown` with the reason rather than a colour.

The workload client id and ToolHive audience are derived; do not invent them.
Reconcile Keycloak with `@sre/keycloak-provisioning` (idempotent; dry-run first).

## Red lines

Stop and report rather than implement: workflow graphs, configurable loops,
durable agent state, specialist-to-specialist calls, dynamic code execution, or
any write action. `TODO` markers are allowed only in `docs/INTEGRATION-POINTS.md`.
