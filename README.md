# agent-management

A read-only SRE agent platform: a Manager agent routes an operator's question to
domain specialists, each of which investigates through approved MCP tools and
returns cited evidence. The Manager synthesizes one answer.

The point of the design is what it *refuses* to do. Specialists cannot call each
other, agents cannot write, tools are allowlisted rather than discovered, and
every budget is enforced in code with a test behind it.

## Architecture

```
                 operator
                    │  OIDC
                    ▼
              Orchestrator ──── routing, synthesis, session
                    │
                    │  SpecialistTransport   (internal/v1, strict schema,
                    │                         64 KiB req / 512 KiB resp)
                    ▼
              runtime-host ──── composition root, adapters, HTTP boundary
                    │
                    ▼
              agent-engine ──── generic: runner, guardrails, tools, telemetry
                    │
                    ▼
     ToolExecutor ──► ToolHive ──► MCP servers ──► backends
```

Two properties hold the whole thing together:

- **The engine is generic.** `agent-engine` knows nothing about SRE, about this
  platform, or about the protocol that carried the request. Prompt, tool policy,
  identity and every budget arrive as configuration through ports. The platform
  projects onto those ports in `runtime-host/src/adapters/ports.ts`, and the
  projection is deliberately lossy — routing and cross-domain policy are not
  passed through, because the engine must not be able to read them.
- **The transport boundary is real.** The orchestrator depends on the
  `SpecialistTransport` interface and on nothing else about how a specialist is
  reached. Only the composition root sees both sides, which keeps
  `orchestrator ✕→ agent-engine` true even when local dev runs both in one
  process. `platform/tools/check-boundaries.ts` enforces this mechanically.

## Layout

| Path | What |
|---|---|
| `agent-engine/` | Generic agent execution engine — domain- and host-neutral |
| `platform/orchestrator/` | Routing, fan-out, synthesis, sessions |
| `platform/runtime-host/` | Composition root, HTTP boundary, platform→engine adapters |
| `platform/contracts/` | Versioned schemas: agent protocol, evidence, agent documents |
| `platform/shared/` | Auth, config loading, redaction, telemetry, LLM client |
| `platform/management/portal/` | Backstage portal for agent lifecycle |
| `deploy/` | Helm charts, ArgoCD, OpenShift/K8s manifests, supply chain |
| `docs/` | Architecture, TDD/SDD, decisions (ADRs), integration points |

## Security invariants

These are code, not prompts, and each has a test:

- Startup configuration fails closed.
- Visible tools = YAML allowlist ∩ approved catalog ∩ user authorization ∩
  environment policy.
- The Manager never receives tool schemas or payloads.
- `DomainHandoff.sanitizedFacts` accepts scalars only, schema-enforced.
- Deterministic secret redaction runs before untrusted content enters model
  context.
- Fan-out uses `Promise.allSettled`, never `Promise.all`.
- Every tool-call, model-turn, deadline, context-byte, evidence-item, follow-up,
  agent and round limit is enforced at runtime.

### Identity

Two authorization problems, never merged: *may this human invoke this agent* and
*may this agent workload call this tool*. Each agent gets its own Keycloak client
derived from its name — there is deliberately no shared agent credential. Tokens
are audience-bound to exactly one MCP via optional client scopes, live 60
seconds, and carry the human as a signed RFC 8693 delegated credential with the
workload as the `act` claim. ToolHive verifies independently. See
`docs/architecture/identity-and-authorization.md`.

No secrets live in Git, agent YAML, the catalog, browser storage, traces or logs.
`assertNoSecretMaterial` rejects credential-shaped keys structurally at config
load.

## Red lines

Work that appears to require workflow graphs, configurable loops, durable state,
specialist-to-specialist calls, dynamic code execution, or write actions is
reported as a red line rather than implemented.

## Getting started

Requires Node 24.20.0 and npm 11.

```sh
cd platform
npm install
npm run dev:local     # runtime-host with an in-process specialist transport
npm run dev:portal    # Backstage portal (separate terminal)
```

Checks:

```sh
npm run typecheck
npm run lint
npm test
```

The `real-poc:*` scripts stand up a local Keycloak, Prometheus and ToolHive to
exercise the real credential path; they require the corresponding environment
variables and never fall back to unsigned identity.

## Documentation

Start with `docs/architecture-rev2.md`, then `docs/DECISIONS.md` for binding
amendments and ADRs. `docs/INTEGRATION-POINTS.md` tracks what is still stubbed.
