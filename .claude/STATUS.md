# PoC status

The Git root holds three first-class concerns (alongside `docs/`, `.claude/`,
CI config and a README):

    agent-engine/   the generic Agent execution engine (its own npm project)
    platform/       the SRE platform built on it (npm workspace root)
    deploy/         how both are packaged and run

Commands run from `platform/`; `npm run check` delegates into the engine.

## Current state

| Check | State | Evidence |
|---|---|---|
| Repository layout | **PASS** | agent-engine / platform / deploy are siblings at the Git root |
| Full repository check | **PARTIAL** | `cd platform && npm run check` — 851 tests (694 platform + 157 engine), boundaries, generated freshness. `validate:deploy` FAILS at HEAD and still does: the portal chart requires `oidc.metadataUrl`, which the check invokes without a values file. Pre-existing; not introduced by the hardening work. |
| Monorepo structure | **PASS** | `agent-engine/ orchestrator/ runtime-host/ portal/ contracts/ shared/ config/ deploy/` |
| Engine public API | **PASS** | `agent-engine/src/index.ts` is a curated 35-symbol contract (was 77); 37 internals now private; 7 conformance-test symbols behind `@sre/agent-engine/testing`, guarded by `check-boundaries` (guard verified by planting a violation) |
| Engine genericity | **PASS** | `agent-engine` depends on `@sre/engine-contract` + `ajv` + `zod` only; 0 platform implementations, 0 protocol SDKs, 0 product names — asserted by `genericity.test.ts` and `check-boundaries` |
| Engine ports | **PASS** | `Model`, `ToolProvider`, `Sanitizer` (required, no default), `Telemetry` (no-op default), `CredentialProvider`; adapters in `runtime-host/src/adapters` |
| Authorization parity | **PASS** | engine `authorizeAgent`/`authorizeTool`/`authorizeAudience` compared against `AuthorizationService` across every agent × tool × principal × environment |
| Evaluation harness | **PASS** | `npm run eval` — 8/8 target metrics met end to end through orchestrator → transport → engine → adapters |
| Architectural boundaries | **PASS** | `agent-engine ✕→ orchestrator`, `orchestrator ✕→ agent-engine` and `agent-engine ✕→ shared` proven at 0 imports; only `runtime-host` composes both |
| One image, two roles | **PASS** | one image from `deploy/runtime/Dockerfile` boots `mode: manager` and `mode: specialist` (run, not asserted) |
| In-process transport | **PASS** | manager + in-process specialist answers `/v1/query` with real evidence; `bob` denied `AUTHZ_DENIED` |
| HTTP transport | **PASS** | two real processes over TCP: manager :3100 → specialist :3110, real citation returned |
| Canonical Agent source of truth | **PASS** | `config/agents/*.yaml`; the three `registry.yaml` variants are deleted |
| Effective Manager catalog | **PASS** | derived from `config/agents` ∩ environment state; a test proves a new Agent routes with no second registry edit |
| Deployment overlays | **PASS** | allow-list schema, tested field-by-field against logical fields |
| Model bindings | **PASS** | per environment; unresolved profile for an enabled Agent fails STARTUP |
| Render pipeline | **PASS** | deterministic, committed, `check:generated` fails on any diff |
| Argo CD ApplicationSet | **PASS (static)** | discovers rendered files, no CMP plugin. Not applied to a live cluster |
| Create Agent change-set | **PASS** | Agent + prompt + overlay generated, applied to a config copy and loaded by the real loader |
| Backstage typecheck / lint / test / build | **PASS** | `yarn tsc`, `yarn lint:all`, 7 tests, `yarn build:all` — lint was red before this work |
| Keycloak workload identities (real) | **PASS** | 9/9 against live Keycloak 26.6 — see below |
| ToolHive access policy (real engine) | **PASS** | rendered Cedar policies evaluated by ToolHive's own authorizer |
| One image, both roles (post-refactor) | **PASS** | `deploy/runtime/Dockerfile` built and run: `ROLE=manager` answered a real `/v1/query` with cited evidence through orchestrator → in-process transport → runtime-host → agent-engine → adapters; `ROLE=specialist AGENT_ID=keycloak` booted from the SAME image |
| **Real PoC smoke (post-refactor)** | **16 PASS / 3 FAIL / 0 BLOCKED** | run at HEAD `ba4354b` against real Keycloak 26.6, real Prometheus, real ToolHive v0.46 with Cedar, real Keycloak/Prometheus/Wiki MCP and a real local LLM. Identical totals to the pre-refactor baseline. The 3 FAILs are local-model latency, not platform regressions — see below. |
| Real PoC failure causes | **environmental** | smoke B/C: `REQUEST_TIMEOUT`/`AGENT_TIMEOUT` — the local model exhausted the per-agent deadline. smoke D: `AUTHN_FAILED` 401 — verify obtains ONE user token then runs four smokes at up to 130s each; the Keycloak default 300s access-token lifespan expires before D. No `MODEL_RATE_LIMITED` this run (that was the Groq-era cause). |
| Real PoC smoke (pre-refactor baseline) | **16 PASS / 3 FAIL / 0 BLOCKED** | the 3 are `MODEL_RATE_LIMITED` in specialist spans, an external provider limit |

## What was verified against real infrastructure

**Keycloak 26.6, live realm** (`npm run verify:keycloak` — 9 PASS, 0 FAIL):
5 distinct confidential service-account clients for 5 Agents, none shared; no
interactive or public flow on any of them; a scoped token carries exactly one
ToolHive audience; no ToolHive audience at all without asking for the scope;
**another Agent's audience scope is refused by Keycloak**; a disabled Agent can
no longer obtain a token; the disabled identity is retained so its audit history
stays attributable; re-enabling restores issuance. Reconciliation is idempotent
(5 created, then 5 unchanged).

**ToolHive 0.46.0, its own Cedar engine** (`npm run verify:toolhive-policy`):
the rendered policies load; the granted Agent may call its tools; a *different*
Agent workload may not; an ungranted tool is denied to everyone; a server with
no grants denies everyone; a request without `azp` is denied rather than
erroring.

**Live gateway** (real PoC smoke A and B): real evidence returned through
ToolHive MCP tools under the rendered policies — 108 successful audit events
against 8 denials, all of them unauthenticated probes rather than tool calls.

## Honest completion state

| Dimension | State |
|---|---|
| Distributed runtime implementation | **COMPLETE** (one image, per-agent Deployment, internal Agent API) |
| Monorepo boundaries | **COMPLETE** (enforced by `check-boundaries` + `tests/boundaries.test.ts`) |
| Canonical config → render → Argo → Helm | **COMPLETE** and freshness-checked |
| Create Agent GitOps generation | **COMPLETE** (Agent + prompt + overlay; prompt is persisted) |
| Management plane owns mutations | **COMPLETE** — the runtime has no write endpoint and no Git credential |
| Keycloak per-Agent workload identity | **COMPLETE and verified against a real realm** |
| ToolHive per-Agent tool authorization | **COMPLETE for what 0.46 supports** — see the blocker below |
| Backstage production auth | **IMPLEMENTED, MAPPING BLOCKED** — guest and allow-all are gone; the IdP group→role mapping needs a real enterprise IdP |
| Tool-argument schema validation | **COMPLETE** (AJV, pre-ToolHive, backend never called on failure) |
| Absolute deadline + cancellation | **COMPLETE** — both planes; `/v1/query` aborts on client disconnect and sheds load past `SRE_MAX_CONCURRENT_QUERIES` |
| Manager `agents.allowed` enforcement | **COMPLETE** (all paths incl. bounded follow-up) |
| Deterministic multi-specialist fallback | **COMPLETE** |
| Multi-turn (bounded follow-up) | **COMPLETE** |
| Metrics + batched OTel | **COMPLETE** |
| **End-to-end identity to ToolHive (Gate #1)** | **runtime path COMPLETE and tested; RFC 8693 exchange now IMPLEMENTED (the manager-signed assertion is the `subject_token`, the specialist its `actor_token`) but UNVERIFIED against a real STS** |
| Real vLLM (Tier-S/Tier-L) integration | **PENDING** (no mirrored model endpoint) |
| Real-model reliability | **UNVALIDATED** — see below |
| Real RAG ACL integration | **OUT OF CURRENT POC** (Wiki MCP replaces baseline retrieval) |
| Production-like load validation | **PENDING** |

## Closed by the platform hardening pass (2026-09-05)

| Was | Now |
|---|---|
| One `sre-agent-integrations` Secret held the delegation signing key, Postgres URL and Argo token, and EVERY release mounted it — any specialist could mint delegated identity for any human | Secrets are split per role and mounted conditionally on `agent.mode`; the delegation key is a manager-only FILE mount. A CI gate renders both roles with Helm and fails if a specialist rendering references the key, Postgres or Argo. |
| A specialist could present its own projected token and be taken for the Manager (audience alone was checked, and every pod shares one audience) | The caller's `sub` is pinned to the Manager service account (`SRE_INTERNAL_EXPECTED_SUBJECT`, required whenever the agent client is real). |
| Tool credentials carried no human at all (client_credentials), and a cached token was re-stamped with the next human's `subjectHash` | Production uses the RFC 8693 exchange carrying the manager-signed assertion; the weaker strategies are refused at startup in production; the cache is keyed by subject. |
| `test`, `guy` and `efrgdv` were canonical Agents, `test` was `enabled: true` in production desired state and auto-synced | Purged everywhere. A policy gate now fails CI on placeholder capabilities, missing/short descriptions, or a rendered set that disagrees with the enabled overlays. |
| `/health/ready` always returned 200 with a hardcoded `configRevision: "real-poc-1"` | Readiness reflects desired-state, Postgres and operational-plane health and returns 503 when a dependency is down. |
| Run history was per-pod memory behind `replicaCount: 2`, and record failures were swallowed | Postgres-backed when configured, still fail-open for the answer but now metered and logged. |
| `SRE_OPERATIONAL_PLANE=on` silently degraded to a repository reporting nothing — a total routing outage from one variable | Startup refuses the flag without both a database and an acknowledged reconciler. |
| The manager's NetworkPolicy claimed "deliberately NOT ToolHive" while allowing every platform namespace on the port ToolHive serves | The exclusion is made by the selector (`DoesNotExist` on the ToolHive namespace label), which a port list cannot express. |

## Open blockers, stated as blockers

| Blocker | Why it is blocked |
|---|---|
| ToolHive live policy reconciliation | 0.46 reads `--authz-config` when a proxy STARTS and exposes no API to reconcile a running one. Applying a change means restarting that proxy. The desired state is rendered and verified; converging a live proxy is not implemented because it is not supported. |
| Enterprise RFC 8693 token exchange | The exchange is now implemented properly — the manager-signed delegation JWT is the `subject_token`, the specialist's workload token the `actor_token`, with client authentication — and it never falls back to an agent-only token. It has NOT run against an enterprise STS; the PoC still uses `signed-jwt`, which production config now refuses. |
| Operational-plane reconciler | Nothing in this repository writes the activation and attestation rows the operational plane reads. The flag now refuses to start without an acknowledged external reconciler, rather than reading an empty table as "no agent is ready". |
| `npm run validate:deploy` | Fails at HEAD and still fails: the portal chart requires `oidc.metadataUrl` and the check renders it with no values file. Out of scope for this pass; it means `npm run check` is red on that step alone. |
| Backstage IdP group → platform role mapping | The permission policy is implemented and tested; which enterprise groups carry the role is configuration (`permission.agentManagement.adminGroups`) that needs a real IdP. Unset denies every write. |
| Real-model reliability | `pass@1 = pass^8 = 0.983` comes from the **mock** regression track (deterministic model). It validates harness and runtime behaviour, not model reliability. Three real smoke cases currently fail on `MODEL_RATE_LIMITED` from the provider. |
| Argo CD apply | The ApplicationSet is validated statically. No live cluster was available. |

Gate #1 is **proven for the runtime trust path** — the effective human is
carried by a signed, audience-bound delegated JWT verified by ToolHive itself
(no unsigned header); Alice is allowed and audited, Bob/Carol denied with no
backend call. It is **not** proven end-to-end against an enterprise IdP.

## Repository operation constraints

The Backstage workspace requires Node 22/24 (`.nvmrc` pins 24.20.0). Installing
it under Node 20 fails to build `better-sqlite3` and `cpu-features`.

`npm run verify:toolhive-policy` needs the vendored ToolHive source
(`platform/tools/prepare-real-poc.sh`) and a Go toolchain. It exits non-zero when
either is missing rather than skipping, because a check that skips silently is
how PASS starts meaning "not run".

## Local PoC state

`platform/.real-poc/` is derived, gitignored state: vendored ToolHive and
prometheus-mcp sources, their built binaries, Keycloak H2 data, Prometheus TSDB,
generated keys, logs and pids. It was destroyed during the layout cleanup and
rebuilt from scratch — `prepare-real-poc.sh`, `start-real-poc.sh`,
`reconcile:keycloak` — which restored everything except local Prometheus scrape
history, which is not reproducible and was lost.

That it rebuilds completely is the reason it is not committed. Nothing under
`platform/config`, `platform/deploy` or any tracked path was affected.

## Why agent-engine is its own npm project

npm requires the workspace root to be an ancestor of every member. The engine is
a repository-root SIBLING of `platform/`, so it cannot be a platform workspace
member: npm links it, but Node resolves through the symlink to the real path and
walks up from the Git root, where there is no `node_modules`. Tested against npm
11.7.0 before choosing.

It therefore has its own `package.json` and `node_modules`, and links the
platform packages it needs by path. `npm run check` in `platform/` delegates into
it, so there is still one command and one baseline. Nothing under
`agent-engine/src` knows any SRE domain; check-boundaries enforces that.
