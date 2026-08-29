# Monorepo layout

Three first-class concerns at the repository root — the engine, the platform
built on it, and how both are packaged — with a strict separation between what
the platform IS and where it RUNS.

```
<git root>                     directories only
├── .claude/                   CLAUDE.md, STATUS.md — project-agent context
├── .woodpecker/               CI
│
├── agent-engine/              THE GENERIC SPECIALIST ENGINE — its own npm project
│   ├── src/{investigation,actions,tools,evidence,followup}  engine.ts
│   └── tests/
│
├── platform/                  THE SRE PLATFORM BUILT ON IT — npm workspace root
│   ├── orchestrator/          the Manager — routing, fan-out, follow-up, synthesis
│   ├── runtime-host/          THE COMPOSITION ROOT — process, HTTP, transports
│   ├── management/portal/     Backstage management plane (own Yarn workspace)
│   ├── contracts/             agent-schema, agent-protocol, evidence, management-api
│   ├── shared/                auth, config-loader, llm, redaction, telemetry
│   ├── config/                canonical logical platform definition
│   ├── tests/  eval/  tools/
│   └── package.json  tsconfig.json  vitest.config.ts
│
├── deploy/                    HOW THEY ARE PACKAGED AND RUN
│   └── runtime/ portal/ environments/ schemas/ argocd/ local/ supply-chain/
│
└── docs/
```

Three first-class concerns, not a hierarchy:

    platform  ──uses──►  agent-engine
         └──────────┬──────────┘
                    ▼
                 deploy  ──►  ONE runtime image  ──►  ROLE=manager | ROLE=specialist

`agent-engine` is a repository-root sibling because it is a GENERIC engine the
SRE platform consumes, not a part of it. It is domain-neutral: nothing under
`agent-engine/src` knows what a Keycloak or Active Directory agent is, and
check-boundaries enforces that. `deploy` is a sibling for the same reason in
reverse — packaging is not owned by the code it packages.

Source ownership and release unit are separate concepts. All three still build
into ONE image from ONE Dockerfile, whose context is the repository root
precisely because the runtime spans all three.

`agent-engine` is its own npm project rather than a workspace member: npm
requires the workspace root to be an ancestor of every member, and the engine
sits beside `platform/`, not inside it. It links the platform packages it needs
by path, and `npm run check` in `platform/` delegates into it so there is still
one command.

Component-local tests stay with their component (`agent-engine/tests/`,
`platform/shared/config-loader/tests/`). Only tests that span components — the
boundary graph, the domain handoff, lifecycle, render pipeline — live under
`platform/tests/`.

`contracts` and `shared` sit side by side under `platform/`, and the distinction
between them is enforced, not stylistic: `check-boundaries` forbids
`contracts → shared`, which is what keeps a contract a contract rather than a
facade over implementation.

## The dependency graph

```
runtime-host ──► agent-engine ──┐
     │      └──► orchestrator ──┤
     └───────────────────────►  shared ──► contracts ──► (nothing internal)
```

Two edges are deliberately absent, and they matter more than the ones present:

| Forbidden | Why |
|---|---|
| `agent-engine ✕→ orchestrator` | A specialist that could reach routing or fan-out could reach another specialist. Specialist-to-specialist communication is a red line. |
| `orchestrator ✕→ agent-engine` | Local dev runs both in one process. If the orchestrator could call the engine directly, the transport boundary would collapse the first time someone took the shortcut. |

`npm run validate:boundaries` enforces the whole graph and
`tests/boundaries.test.ts` asserts those two edges by name, so the rule is
visible rather than implied by the absence of a violation. The check resolves
zones from package NAMES, not directory names, because the two deliberately
differ (`shared/config-loader` publishes `@sre/config`).

## The composition root

`runtime-host` is the only layer allowed to see both engines. It reads the role
and agent configuration, builds every dependency fail-closed, mounts the
orchestrator for the Manager and the engine for a Specialist, and injects one of
two transports:

```
orchestrator ──► SpecialistTransport            (contracts/agent-protocol)
                        ▲                ▲
   HttpSpecialistTransport            InProcessSpecialistTransport
        (runtime-host/src/transport)      (runtime-host/src/transport)
                                                 │
                                          agent-engine
```

The orchestrator never learns which one it got. The in-process adapter runs the
real engine behind the same admission semantics as the HTTP specialist server —
protocol size limits, delegated-identity verification, deadline expiry, question
redaction — so `SRE_CLIENT_AGENT=inprocess` is a transport swap, not a second
code path with weaker rules.

That adapter is the reason this layer exists. Putting it next to the code that
uses it would have been the natural place, and would have broken the boundary.

## External protocols are adapters

How the platform is SPOKEN TO is a boundary concern, not an execution concern.
OpenAI Responses, A2A, MCP server exposure and enterprise messaging integrations
are adapters at the execution boundary — initially in `runtime-host`, beside the
HTTP app and the two transports:

```
   external caller
        │
        ▼
   protocol adapter          runtime-host/src/http · one per protocol
        │
        ▼
   orchestrator ──► SpecialistTransport ──► agent-engine
```

If operational requirements later justify a separate gateway or deployable, an
adapter may be extracted without changing Agent or orchestration semantics —
because it never had any to change.

**Adding, replacing or removing an adapter must not change** Agent execution,
orchestration, evidence, authorization or tool-execution semantics. That holds
only if the protocol never reaches the components that decide them, so
`check-boundaries` fails the build when `agent-engine` or `orchestrator`:

- declares an HTTP/websocket server or an external protocol SDK
  (`express`, `fastify`, `koa`, `ws`, `socket.io`, `openai`, A2A), or
- imports a protocol's SERVER entrypoint.

The distinction that matters is **consume vs expose**. `agent-engine` speaks MCP
as a *client*, because calling a tool through ToolHive is what a specialist
does — that is consumption, and it is legitimate. *Serving* MCP, becoming a
server other systems call, is exposure and belongs in the adapter layer. The
rule is therefore written against `@modelcontextprotocol/sdk/server`, not
against the package.

An external protocol must never become the internal one by default. Internal
Orchestrator→Specialist communication stays behind
`contracts/agent-protocol::SpecialistTransport`, whatever is bolted to the edge.

## One image, one chart, two roles

`agent-engine`, `orchestrator` and `runtime-host` are separate source components
but a **single release unit**:

```
agent-engine + orchestrator + runtime-host
                  ↓
           ONE runtime image
                  ↓
   ROLE=manager   |   ROLE=specialist, AGENT_ID=keycloak
```

Separate images would let the Manager and a Specialist drift to different
versions of the protocol they share. If a future driver genuinely requires
separate images, that is a decision to take deliberately, not to arrive at.

## Logical definition vs. deployed state

```
config/agents/<agent>.yaml            deploy/environments/<env>/agents/<agent>.yaml
  identity, routing, capabilities,      enabled, replicas, resources,
  tool access, prompt, limits,          serviceAccount, endpoint override
  cross-domain policy
        └───────────────┬──────────────────────────┘
                        ▼
           the Manager's EFFECTIVE catalog
```

The overlay schema is an **allow-list** (`additionalProperties: false`). It
cannot carry routing, capabilities, prompt, access, tools, owner or cross-domain
policy — those are properties of the Agent, and an overlay that could restate
them would be a second source of truth.

There is no routing registry. Onboarding an Agent is a `config/agents` file plus
an overlay, and a test asserts that a new canonical Agent becomes routable
without editing any other logical source.

## config → render → Argo → Helm

```
config/agents/<agent>.yaml   config/prompts/<agent>.md
deploy/environments/<env>/agents/<agent>.yaml
deploy/environments/<env>/model-bindings.yaml
        ↓  scripts/render-agent-deployment.ts   (validate, resolve, fail closed)
deploy/environments/<env>/rendered/agents/<agent>.yaml
        ↓  deploy/argocd/applicationsets/runtime.yaml    (discovers files)
deploy/runtime/helm  →  one Deployment per enabled Agent
```

Argo consumes configuration that is **already rendered**. There is deliberately
no Argo config management plugin: rendering inside the cluster would let the
committed state and the deployed state diverge with no reviewable diff.

A disabled Agent renders nothing. Absence is how "do not deploy this here"
reaches the cluster, because the ApplicationSet discovers files rather than
reading an enablement list.

Endpoints resolve by convention —
`http://sre-agent-{agentId}.{namespace}.svc.cluster.local` — owned by the Helm
chart and declared per environment. No Kubernetes API discovery or watch. An
environment that cannot follow the convention (compose service names, loopback
PoC ports) uses the documented per-agent `endpoint` override.

## Generated artifacts

Every generated artifact is **committed and CI-verified**. `npm run check` runs
`check:generated`, which regenerates everything and fails on any diff.

| Artifact | Generated from |
|---|---|
| `contracts/agent-schema/generated/agent.schema.json` | the Zod Agent schema |
| `deploy/schemas/*.schema.json` | the Zod overlay / bindings / rendered-values schemas |
| `contracts/management-api/generated/types.ts` | `contracts/management-api/openapi.yaml` |
| `portal/plugins/*/src/api/generated-types.ts` | the same OpenAPI document |
| `deploy/environments/*/rendered/agents/*.yaml` | config + overlay + model bindings |
| `deploy/supply-chain/npm/npm-packages.md` | `package-lock.json` |

This matters most for the air-gapped operational model, where the committed
render is what actually ships.

## Two toolchains

`portal/` is a self-contained Backstage Yarn 4 workspace: React, its own build
pipeline, its own tsconfig. Merging it into the root npm workspaces would force
one toolchain onto the other for no benefit, so it is:

- excluded from the root `workspaces` globs, `tsconfig.json` and root lint
- checked by its own `yarn tsc` via `npm run check:portal`
- pinned to Node 22/24; the repo's `.nvmrc` (24.20.0) is what its native
  dependencies build against

The portal imports no TypeScript source from the npm workspace. It consumes the
management API over HTTP, with types generated from the shared OpenAPI contract
and checked into its own workspace.

## Why one repository

The Agent schema is canonical. Splitting the planes into separate repositories
would turn `contracts/agent-schema` into a versioned cross-repo dependency, and
the moment the versions differ the portal can preview a configuration the runtime
would reject — exactly the drift the architecture forbids. It would also break
the single `npm run check` and complicate the real-PoC scripts, which orchestrate
both planes together.

So the components are separated by **directory and enforced dependency
direction**, not by repository.

## Commands

```bash
npm install            # contracts + shared + the three code components
npm run install:portal # Backstage (yarn, requires Node 22/24 + corepack)

npm run dev:runtime    # manager + in-process specialists
npm run dev:portal     # Backstage app :3010, backend :7007

npm run check          # typecheck, lint, boundaries, tests, YAML,
                       # generated freshness, both Helm charts
npm run check:portal   # Backstage typecheck
npm run render:deploy  # re-render every environment
```

`npm run check` is the one command that validates the monorepo.
