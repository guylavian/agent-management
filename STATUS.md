# PoC status

## Current phase

T6 — Eval, adversarial, and load harness implementation complete. All in-process checks and mock evaluation gates pass. Autocannon execution awaits an environment that permits binding a local TCP listener.

## Gate results

| Gate | Status | Evidence |
|---|---|---|
| Full repository check | PASS | `npm run check`: typecheck, lint, 18 files / 66 tests, YAML validation and Helm lint |
| AG-01 identity propagation | PASS (mock) | Distinct Alice/Bob subject and request ID reach ToolHive audit |
| AG-02 unauthorized tool denied | PASS (mock) | Denial occurs before backend invocation |
| AG-03 no mutating tool | PASS (mock) | Approved catalog contains verified read-only tools only |
| T2 AD specialist | PASS (mock) | RAG + MCP, redaction/truncation, citations, failures and bounded loops |
| T3 routing | PASS (mock) | Deterministic rules/intent, one-shot Manager, abstention and AuthZ edge cases |
| T4 fan-out | PASS (mock) | Three specialists, `Promise.allSettled`, partial evidence and Tier-L gate |
| T5 Round 2 | PASS (mock) | One scalar-only sanitized handoff, authorization and total-agent budget |
| T6 adversarial | PASS (mock) | Wiki/log injection, secret echo, catalog extraction, cross-user, confused deputy and write intent |
| T6 evaluation | PASS (mock) | 60 cases x 8 runs; pass@1 100%, pass^8 100%; all SDD section 22 targets pass |
| 20/50 concurrency fallback | PASS (mock) | `fastify.inject` concurrent tests use mock ToolHive only |
| autocannon normal/burst/storm | BLOCKED (sandbox) | Profiles and real-client refusal are implemented/tested; local bind returns `EPERM` |

## Open integration points

See `docs/INTEGRATION-POINTS.md`. Gate 1 enterprise OIDC/ToolHive identity propagation is the first external validation.

## Deviations

None. Binding-amendment conflict resolutions are recorded in `docs/DECISIONS.md` and are not deviations.

## Repository operation constraints

- Conventional phase commits and tags could not be created because this workspace exposes `.git` read-only (`index.lock: Operation not permitted`).
- Process-level `dev:local` and autocannon smoke execution could not bind a loopback/listening socket in the sandbox. Fastify injection, including 20/50 concurrent requests, passes.
