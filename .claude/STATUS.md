# PoC status

All commands run from `platform/` — the Git root is a shell holding
`.claude/`, `.woodpecker/` and `platform/` only.

## Current state

| Check | State | Evidence |
|---|---|---|
| Repository layout | **PASS** | Git root is directories-only; `platform/` is the single npm workspace root |
| Full repository check | **PASS** | `cd platform && npm run check` — 320 tests, 12 YAML checks, boundaries, generated freshness, 2 Helm charts |
| Monorepo structure | **PASS** | `agent-engine/ orchestrator/ runtime-host/ portal/ contracts/ shared/ config/ deploy/` |
| Architectural boundaries | **PASS** | `agent-engine ✕→ orchestrator` and `orchestrator ✕→ agent-engine` proven at 0 imports; only `runtime-host` composes both |
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
| Real PoC smoke | **17 PASS / 2 FAIL / 0 BLOCKED** | rebuilt from scratch on the new layout; the 2 are `MODEL_RATE_LIMITED` in specialist spans |

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
| Absolute deadline + cancellation | **COMPLETE** |
| Manager `agents.allowed` enforcement | **COMPLETE** (all paths incl. bounded follow-up) |
| Deterministic multi-specialist fallback | **COMPLETE** |
| Multi-turn (bounded follow-up) | **COMPLETE** |
| Metrics + batched OTel | **COMPLETE** |
| **End-to-end identity to ToolHive (Gate #1)** | **runtime path COMPLETE and tested; real enterprise token-exchange BLOCKED** |
| Real vLLM (Tier-S/Tier-L) integration | **PENDING** (no mirrored model endpoint) |
| Real-model reliability | **UNVALIDATED** — see below |
| Real RAG ACL integration | **OUT OF CURRENT POC** (Wiki MCP replaces baseline retrieval) |
| Production-like load validation | **PENDING** |

## Open blockers, stated as blockers

| Blocker | Why it is blocked |
|---|---|
| ToolHive live policy reconciliation | 0.46 reads `--authz-config` when a proxy STARTS and exposes no API to reconcile a running one. Applying a change means restarting that proxy. The desired state is rendered and verified; converging a live proxy is not implemented because it is not supported. |
| Enterprise RFC 8693 token exchange | The Specialist → ToolHive credential path is coded and never falls back to unsigned identity, but has not run against an enterprise STS. The PoC uses `signed-jwt`. |
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
(`engineering/tools/prepare-real-poc.sh`) and a Go toolchain. It exits non-zero when
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
