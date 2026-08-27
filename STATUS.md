# PoC status

## Current phase

Distributed refactor (architecture Rev 2.0) complete on top of the finished
T0–T6 PoC: every logical agent is an independently deployable instance of the
one Generic Agent Runtime image, fanned out over the versioned internal Agent
API. Docs: `docs/architecture-rev2.md`, `docs/poc-sdd-rev2.md`,
`docs/poc-tdd-rev2.md`, `docs/contracts/internal-agent-api.md`.

## Gate results

| Gate | Status | Evidence |
|---|---|---|
| Full repository check | PASS | `npm run check`: typecheck, lint, 22 files / 79 tests, YAML validation, helm lint + render of all four agent releases |
| AG-01 identity propagation | PASS (mock) | Distinct Alice/Bob subjects and request IDs reach ToolHive audit; delegated JWT verified per specialist hop (audience, expiry, request-ID, subject-hash binding) |
| AG-02 unauthorized tool denied | PASS (mock) | Denial occurs before backend invocation |
| AG-03 no mutating tool | PASS (mock) | Approved catalog contains verified read-only tools only |
| T2–T5 specialist/routing/fan-out/round 2 | PASS (mock) | Runtime suites now run through the distributed contract (`AgentClient`) |
| Specialist internal API over HTTP | PASS (mock) | `fastify.inject`: admission 403/413/504 vs execution 500 separation, delegated end-to-end 200 |
| T6 adversarial | PASS (mock) | Wiki/log injection, secret echo, catalog extraction, cross-user session isolation, confused deputy, write intent — via `InProcessAgentClient` |
| T6 evaluation (distributed path) | PASS (mock) | 60 cases × 8 runs: pass@1 98.3%, pass^8 98.3%; all SDD §22 targets met (0 tool-policy violations, routing 98.3%, tool selection 100%, citations 100%, unsupported claims 0%, missing-evidence disclosure 100%) |
| Load safety | PASS | Storm profile refuses real ToolHive **and** real agent client; autocannon execution still requires a runner that permits TCP listeners |
| Generic Helm chart | PASS | One chart; manager/AD/OpenShift/network releases lint and render; per-mode NetworkPolicy, projected workload token, HPA/PDB options |

## Open integration points

See `docs/INTEGRATION-POINTS.md` — enterprise OIDC/token-exchange delegation,
projected-token audience validation, distributed Gate #1 re-run, GitOps
registry generation, two-process HTTP smoke, cluster NetworkPolicy
verification.

## Deviations

None beyond the recorded decisions in `docs/DECISIONS.md` (notably:
`Evidence.agentId` addition, manager production env carrying unused
ToolHive/RAG variables to preserve fail-closed validation, environment
authorization now rejected before fan-out).

## Repository operation constraints

- This environment cannot bind TCP listeners (`listen EPERM`), so the
  two-process HTTP smoke and autocannon profiles run only in CI/dev runners;
  HTTP-level behavior is covered by `fastify.inject` and the
  contract-faithful `InProcessAgentClient`.
