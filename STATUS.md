# PoC status

## Monorepo migration (current)

| Check | State |
|---|---|
| Structural migration | **PASS** — `agent-engine/ orchestrator/ runtime-host/ portal/ contracts/ shared/ config/ deploy/` |
| Full repository check | **PASS** — `npm run check`: 288 tests, 12 YAML checks, boundaries, generated freshness, 2 Helm charts |
| Architectural boundaries | **PASS** — `agent-engine ✕→ orchestrator` and `orchestrator ✕→ agent-engine` proven at 0 imports; only `runtime-host` composes both |
| One image, two roles | **PASS** — one image built from `deploy/runtime/Dockerfile` boots `mode: manager` and `mode: specialist` (verified by running it) |
| In-process transport | **PASS** — manager + in-process specialists answer a real `/v1/query` end to end |
| Canonical Agent source of truth | **PASS** — `config/agents/*.yaml`; the three `registry.yaml` variants are deleted |
| Effective Manager catalog | **PASS** — derived from `config/agents` ∩ environment deployment state; a test proves a new Agent routes with no second registry edit |
| Deployment overlays | **PASS** — allow-list schema, tested field-by-field against logical fields |
| Model bindings | **PASS** — per environment; unresolved profile for an enabled Agent fails STARTUP (tested) |
| Render pipeline | **PASS** — deterministic, committed, `check:generated` fails CI on any diff |
| Argo CD | **PASS (static)** — ApplicationSet discovers rendered files; no CMP plugin. Not applied to a live cluster |
| Backstage typecheck / test | **PASS** — `yarn tsc` clean, 1 test passing |
| Backstage lint | **FAIL** — 16 pre-existing a11y / react-hooks / nested-ternary errors in `plugins/agent-management`; predate the migration, not silenced |

Every existing security and runtime regression test still passes. The migration
introduced no intentional runtime behaviour change; the two deliberate
strengthenings are documented in the commits that made them (model-profile
fail-closed startup, tool-policy enforcement moved from a test into config load).

## Honest completion state

| Dimension | State |
|---|---|
| Distributed runtime implementation | **COMPLETE** (one image, per-agent Deployment, internal Agent API) |
| Monorepo boundaries | **COMPLETE** (enforced by `check-boundaries` + `tests/boundaries.test.ts`) |
| Mock integration tests | **PASS** — 288 tests + 12 YAML checks + chart lint/render |
| Tool-argument schema validation | **COMPLETE** (AJV, pre-ToolHive, backend never called on failure) |
| Absolute deadline + cancellation | **COMPLETE** |
| Manager `agents.allowed` enforcement | **COMPLETE** (all paths incl. bounded follow-up) |
| Config-driven routing | **COMPLETE** (routing vocabulary lives on the Agent; onboarding is config-only) |
| Deterministic multi-specialist fallback | **COMPLETE** |
| Multi-turn (bounded follow-up) | **COMPLETE** |
| Metrics + batched OTel | **COMPLETE** |
| **End-to-end identity to ToolHive (Gate #1)** | **runtime path COMPLETE and tested with a mock authority; real enterprise token-exchange BLOCKED** |
| Real vLLM (Tier-S/Tier-L) integration | **PENDING** (no mirrored model endpoint) |
| Real RAG ACL integration | **OUT OF CURRENT POC** (Wiki MCP replaces baseline retrieval) |
| Real ToolHive/MCP integration | **CODE COMPLETE / EXECUTION BLOCKED** |
| Real-model reliability benchmark | **PENDING** (Track 2, `eval/real-benchmark.md`) |
| Keycloak provisioning/reconciliation | **LIBRARY ONLY** — idempotent + tested, no entrypoint invokes it |
| Workload-client token acquisition | **WIRED, NOT ACTIVE** — real PoC still uses `signed-jwt` |
| GitOps pull requests | **WIRED, NOT CONFIGURED** — no Git provider set; reports `not-configured` |

## What the mock numbers mean

`pass@1 = pass^8 = 0.983` and 0 tool-policy violations come from the **mock
regression track** (deterministic model). They validate harness and runtime
behaviour, **not** real model reliability. Real small-model routing/tool
accuracy is UNVALIDATED until Track 2 runs against the pinned models.

Gate #1 is **proven for the runtime trust path** — the effective human is
carried by a signed, audience-bound delegated JWT and verified by ToolHive
itself (no unsigned header); Alice is allowed and audited, Bob/Carol are denied
with no backend call. It is **not** proven end-to-end against the enterprise IdP
and real ToolHive; that remains an INTEGRATION BLOCKER.

## Gate results (against mocks)

| Gate | Status | Evidence |
|---|---|---|
| Full repository check | PASS | `npm run check` |
| Architectural boundaries | PASS | `tests/boundaries.test.ts`, `scripts/check-boundaries.ts` |
| AG-01 identity to ToolHive | PASS (mock authority) | `tests/gate1-toolhive-identity.test.ts`, `tests/gate1-e2e.test.ts` |
| AG-02 unauthorized tool denied | PASS (mock) | denial before backend call |
| AG-03 no mutating tool | PASS (mock) | approved catalog is read-only-verified + tool policy enforced at config load |
| Tool-argument validation | PASS | `agent-engine/tests/arg-validator.test.ts` |
| Absolute deadline / cancellation | PASS | `tests/deadline.test.ts` |
| Manager allowlist | PASS | `orchestrator/tests/manager-allowlist.test.ts` |
| Config-driven routing | PASS | `orchestrator/tests/router.test.ts`, `shared/config-loader/tests/agent-catalog.test.ts` |
| Multi-specialist Tier-L fallback | PASS | `orchestrator/tests/fanout.test.ts` |
| Render determinism + freshness | PASS | `tests/render-pipeline.test.ts`, `npm run check:generated` |
| Mock eval (Track 1) | PASS | 60×8, pass@1/pass^8 0.983 |

## Open integration blockers

See `docs/INTEGRATION-POINTS.md`. Highest priority: enterprise RFC 8693 token
exchange for the Specialist → ToolHive credential (the real path is coded but
BLOCKED and never falls back to unsigned identity).

## Repository operation constraints

The two-process HTTP smoke and autocannon profiles run only in CI/dev runners.
HTTP-level behaviour is covered by `light-my-request` injection and the
contract-faithful `InProcessSpecialistTransport`.

The Backstage workspace requires Node 22/24 (`.nvmrc` pins 24.20.0). Installing
it under Node 20 fails to build `better-sqlite3` and `cpu-features`.
