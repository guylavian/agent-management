# PoC status

## Real local Keycloak/Prometheus milestone (current)

| Check | State |
|---|---|
| Runtime/config/source implementation | **PASS** — `npm run check` (133 tests, 7 YAML checks, Helm lint/render) |
| First-class Keycloak specialist | **PASS** — Keycloak MCP + Wiki MCP only |
| First-class Observability specialist | **PASS** — upstream Prometheus MCP + Wiki MCP only |
| RAG in active execution | **REMOVED** |
| Real ToolHive discovery/invocation | **IMPLEMENTED** — authenticated `tools/list` and `tools/call`, cancellation and timeouts |
| Real smoke A-D | **BLOCKED (environment)** — GitHub DNS unavailable, Docker socket denied, `.env.real-poc` absent, real LLM/Wiki endpoints not listening |

The last attempted `scripts/verify-real-poc.sh` result was `0 PASS, 0 FAIL, 19 BLOCKED`. This is an external startup block, not a claimed integration pass. See `docs/REAL-POC.md`.

## Honest completion state

| Dimension | State |
|---|---|
| Distributed runtime implementation | **COMPLETE** (one image, per-agent Deployment, internal Agent API) |
| Express 5 alignment | **COMPLETE** |
| Mock integration tests | **PASS** — 133 unit/integration tests + 7 YAML checks + chart lint/render |
| Tool-argument schema validation | **COMPLETE** (AJV, pre-ToolHive, backend never called on failure) |
| Absolute deadline + cancellation | **COMPLETE** |
| Manager `agents.allowed` enforcement | **COMPLETE** (all paths incl. Round 2) |
| Config-driven routing | **COMPLETE** (vocabulary in registry; onboarding is config-only) |
| Deterministic multi-specialist fallback | **COMPLETE** |
| Multi-turn (bounded follow-up) | **COMPLETE** (Option A: entities transported and consumed; evidence always refreshed) |
| Metrics (counter/histogram/gauge) + batched OTel | **COMPLETE** |
| **End-to-end identity to ToolHive (Gate #1)** | **runtime path COMPLETE and tested with a mock authority; real enterprise token-exchange BLOCKED** |
| Real vLLM (Tier-S/Tier-L) integration | **PENDING** (no mirrored model endpoint) |
| Real RAG ACL integration | **OUT OF CURRENT POC** (Wiki MCP replaces baseline retrieval) |
| Real ToolHive/MCP integration | **CODE COMPLETE / EXECUTION BLOCKED** (see current milestone) |
| Real-model reliability benchmark | **PENDING** (Track 2, `eval/real-benchmark.md`) |
| Production-like load validation (autocannon) | **PENDING** (sandbox denies TCP listeners) |

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
| AG-01 identity to ToolHive | PASS (mock authority) | `apps/api/tests/gate1-toolhive-identity.test.ts`, `gate1-e2e.test.ts` |
| AG-02 unauthorized tool denied | PASS (mock) | denial before backend call |
| AG-03 no mutating tool | PASS (mock) | approved catalog is read-only-verified |
| Tool-argument validation | PASS | `packages/mcp/tests/arg-validator.test.ts` + runtime no-backend-call test |
| Absolute deadline / cancellation | PASS | `packages/runtime/tests/deadline.test.ts` |
| Manager allowlist | PASS | `packages/runtime/tests/manager-allowlist.test.ts` |
| Config-driven routing | PASS | `packages/routing/tests/router.test.ts` (incl. onboard-by-config) |
| Multi-specialist Tier-L fallback | PASS | `packages/runtime/tests/fanout.test.ts` |
| Mock eval (Track 1) | PASS | 60×8, pass@1/pass^8 0.983, all SDD §22 targets |

## Open integration blockers

See `docs/INTEGRATION-POINTS.md`. Highest priority: enterprise RFC 8693 token
exchange for the Specialist → ToolHive credential (real path is coded but
BLOCKED and never falls back to unsigned identity).

## Remediation change classification (this round)

| Requirement | Classification |
|---|---|
| 1 Express 5 alignment | FIXED |
| 2 Real identity to ToolHive | FIXED (runtime) / BLOCKED BY EXTERNAL INTEGRATION (enterprise STS) |
| 3 Tool argument schema validation | FIXED |
| 4 Absolute deadline semantics | FIXED |
| 5 MCP cancellation reaches callTool | FIXED |
| 6 Config-driven routing | FIXED |
| 7 Manager `agents.allowed` enforcement | FIXED |
| 8 Registry/config ownership | FIXED (registry already lightweight; routing metadata added there, not in specialist config) |
| 9 Multi-turn | FIXED (Option A, bounded) |
| 10 MCP connection reuse | DEFERRED (P2; not started until Gate #1 real path unblocks) |
| 11 Deterministic multi-specialist fallback | FIXED |
| 12 Precise tokenizer context budgeting | DEFERRED (P2; byte + item budgets remain the enforced safety bound) |
| 13 Metrics types | FIXED |
| 14 OTel batching + propagation | FIXED |
| 15 STATUS/completion honesty | FIXED |
| 16 Real evaluation set | PARTIALLY FIXED — set authored + documented; RUN is BLOCKED BY EXTERNAL INTEGRATION |
| 17 Preserve distributed architecture | PRESERVED |

## Repository operation constraints

This environment cannot bind TCP listeners (`listen EPERM`); the two-process
HTTP smoke and autocannon profiles run only in CI/dev runners. HTTP-level
behaviour is covered by `light-my-request` injection and the contract-faithful
`InProcessAgentClient`.
