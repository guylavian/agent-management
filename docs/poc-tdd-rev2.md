# Air-Gapped SRE Agent Platform — PoC TDD, Revision 2.0

**Status:** Implemented (PoC)
**Supersedes:** `docs/poc-tdd.md` (Rev 1) in the sections listed below; all
other Rev 1 sections (types, YAML schema, budgets, redaction, retry rules for
MCP, metrics, red lines, phases) apply unchanged. Wire contract:
`docs/contracts/internal-agent-api.md`.

## Changelog against Rev 1

| Rev 1 section | Change |
|---|---|
| §3 Repository layout | + `packages/agent-protocol`, `packages/agent-client`, `packages/agent-registry`; `packages/session` store is implemented and wired |
| §4.4 Evidence | + required `agentId` attribution field |
| §6 Execution algorithm | fan-out via `AgentClient` with per-target delegated identity (below) |
| §13 MCP execution | unchanged, now specialist-process-local only |
| §15 Timeouts | one absolute deadline propagated as ISO string; per-hop budgets derived |
| §19 API design | two server modes from one app: manager (`/v1/query`) and specialist (`/internal/v1/execute`) |
| §22 Config loading | `loadAgentInstance` loads exactly one agent per process |
| §25 OTel | cross-process W3C context propagation |
| §31 Deployment | generic per-agent Helm chart |

## 1. Repository layout delta

```text
packages/
├── agent-protocol/   # internal/v1 schemas, size limits, delegated-identity context
├── agent-client/     # AgentClient: HttpAgentClient, MockAgentClient, workload token providers
├── agent-registry/   # AgentServiceRegistry: agents/registry.yaml → endpoints/authz/discovery edges
├── auth/             # + delegation.ts: DelegatedIdentityIssuer/Verifier (mock HS256, prod RS256+JWKS)
├── runtime/          # executeRequest (manager side), runSpecialistInstance (specialist side),
│                     # in-process-agent-client.ts (contract-faithful loopback for dev/eval/tests)
└── session/          # BoundedSessionContext store (mock + PostgreSQL)
deploy/helm/          # ONE generic chart; values/<agent>.yaml per release
agents/registry.yaml  # AgentServiceRegistry document (GitOps source of truth)
```

## 2. Core interfaces (as implemented)

```ts
// agent-client
interface AgentClient {
  readonly mode: "mock" | "real";
  execute(agentId: string, request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResponse>;
}
interface WorkloadTokenProvider { getToken(audience: string): Promise<string> }
type AgentTransportErrorCode =
  | "AGENT_UNAVAILABLE" | "AGENT_TIMEOUT" | "AGENT_UNAUTHORIZED"
  | "AGENT_EXECUTION_FAILED" | "AGENT_INVALID_RESPONSE" | "AGENT_RESPONSE_TOO_LARGE";

// agent-registry
interface AgentRegistryEntry {
  agentId: string; endpoint: string; owner: string; description: string;
  enabled: boolean; environments: string[]; requiredRoles: string[];
  allowedNeedsDomains: string[];
}
interface AgentRegistry {
  resolve(agentId: string): AgentRegistryEntry | undefined;
  listEnabled(environment?: string): AgentRegistryEntry[];
  filterAuthorized(agentIds: string[], roles: string[], environment: string): string[];
  mayRequestDomain(originAgentId: string, targetAgentId: string): boolean;
}

// auth/delegation
interface DelegatedIdentityIssuer {
  issue(identity: RequestIdentity, audience: string, deadline: number): Promise<DelegatedIdentityContext>;
}
interface DelegatedIdentityVerifier {
  verify(context: DelegatedIdentityContext, expectedAudience: string, requestId: string): Promise<RequestIdentity>;
}
```

Request/response schemas and limits: see the contract document.

## 3. Manager execution (actual shape of `executeRequest`)

```ts
async function executeRequest(req, deps): Promise<AssistantResponse> {
  const safeQuestion = redactText(req.question);
  // the effective catalog IS the routing table; there is no second allowlist
  const candidates = deps.registry.listEnabled(env);
  const stage1 = deterministicRoute(safeQuestion, candidates);
  const routing = stage1.resolved ? stage1.decision
                : managerRouter.selectAgents(safeQuestion, filterAuthorized(candidates));
  if (routing.abstain) { top-2 fan-out if policy permits, else clarification (zero tool calls); }
  const authorized = deps.registry.filterAuthorized(routing.agents, roles, env);
  if (authorized.length === 0) return authorizationDenied();   // AUTHZ_DENIED shape

  const settled = await Promise.allSettled(authorized.map(async (agentId) => {
    const identityContext = await deps.identityIssuer.issue(identity, `sre-agent:${agentId}`, deadline);
    return deps.agentClient.execute(agentId, { requestId, question, environment,
      identityContext, conversationContext?, deadline: iso(deadline) }, signal);
  }));
  results = settled.map(fulfilled ? value : typedFailureEvidence(AgentTransportError));

  const round2 = planRound2(results, registry, identity, budget);   // validate chain, ≤1 domain, ≤1 round
  if (round2.request) results.push(await executeAgent(round2.request.agentId, ..., round2.request.handoff));

  const reduced = reduceEvidence(results);
  return shouldEscalate(ctx, reduced) ? synthesizeResponse(...)     // Tier-L
       : deterministicResponseBuilder(ctx, results[0]);
}
```

Round-2 validation chain is unchanged from Rev 1 §16, evaluated against the
service registry (`mayRequestDomain`, `filterAuthorized`, already-ran, global
budget); the handoff remains scalar-only and schema-enforced.

## 4. Runtime startup modes

Same image; `AGENT_CONFIG` selects the file, `loadAgentInstance` loads exactly
one validated agent document + prompt (specialists also cross-check the
approved tool catalog), and `buildDependencies` constructs only that mode's
clients:

| Dependency | manager | specialist |
|---|---|---|
| user OIDC verifier | ✓ | — |
| Tier-S model client | ✓ (routing) | ✓ (tool loop) |
| Tier-L model client | ✓ (synthesis) | — |
| AgentServiceRegistry + AgentClient + workload token | ✓ | — |
| DelegatedIdentityIssuer | ✓ | — |
| DelegatedIdentityVerifier + internal OIDC (workload check) | — | ✓ |
| ToolHive client + approved catalog + AuthorizationService | — | ✓ |
| RAG client | — | ✓ |
| Session store (mock/PostgreSQL) | ✓ | — |

Fail-closed rules: production forbids every mock client; each `real` client
requires its endpoint at startup; the manager validates that all allowed
agents exist in the registry before listening.

## 5. Specialist server flow (`POST /internal/v1/execute`)

```text
strict schema parse                    → 400
extract W3C trace context (one distributed trace)
phase 1 — admission:
  serialized size limit                → 413 AGENT_REQUEST_TOO_LARGE
  workload identity verify             → 403 AGENT_UNAUTHORIZED
  delegated identity verify (audience, expiry, request_id, subjectHash)
                                       → 403 AGENT_UNAUTHORIZED
  deadline expired                     → 504 AGENT_TIMEOUT
phase 2 — execution:
  abort wiring (client disconnect → AbortController)
  redact question → classify intent → runSpecialistInstance (budgets, RAG,
    tool loop, redaction, evidence normalization)
  response size limit                  → 502 AGENT_RESPONSE_TOO_LARGE
  internal failure                     → 500 AGENT_EXECUTION_FAILED   (never 403)
  success                              → 200 SpecialistResult
```

## 6. Retry and timeout ownership (single owner per hop)

| Hop | Timeout source | Retry |
|---|---|---|
| API → manager | request hard ceiling (45 s default) | none |
| manager → specialist | remaining absolute deadline via `AbortSignal.any` | once, transport 502/503/504 only |
| specialist → Tier-S | remaining deadline | none |
| specialist → ToolHive tool | `min(catalog timeoutMs, remaining)` | per catalog `retryPolicy` (`none`/`transient-once`) |
| specialist → RAG | remaining deadline | none |
| manager → Tier-L | remaining deadline | none (deterministic fallback answer) |

## 7. Distributed trace model

```text
sre.query                                   (manager)
├── manager.route.stage1
├── manager.route.llm                       (when Stage-1 unresolved)
├── manager.fanout
│   ├── agent.active-directory.execute      (client span, traceparent injected)
│   │   └── agent.active-directory.execute  (server span, extracted context)
│   │       ├── rag.baseline.active-directory
│   │       ├── llm.specialist.active-directory
│   │       └── mcp.<server>.<tool>
│   └── agent.openshift.execute ...
├── round2.resolve
├── agent.<round2>.execute
├── evidence.reduce
├── synthesis.gate
├── llm.synthesis                           (conditional)
└── response.build
```

Attributes unchanged from Rev 1 §25 (`request.id`, `user.subject_hash`,
`agent.id`, ...); security audit stays in ToolHive→SIEM.

## 8. Source-code refactor list (in-process → distributed, as executed)

1. Extracted the wire contract into `@sre/agent-protocol` (schemas, limits,
   delegated-identity context).
2. Introduced `@sre/agent-client` (`HttpAgentClient` + mock + workload token
   providers) and `@sre/agent-registry` (service registry, authz filter,
   discovery edges).
3. Added `auth/delegation.ts` — issuer/verifier pair for the delegated user
   JWT (mock HS256 authority; production RS256 signer + JWKS verifier).
4. Rewrote `executeRequest` to fan out through `AgentClient` with per-target
   delegated identity; transport failures map to typed evidence.
5. Split the API app into manager/specialist modes; added the specialist
   server with two-phase admission/execution error handling.
6. Replaced multi-agent process config with `loadAgentInstance` (one agent per
   process); the multi-agent loader remains for eval/tests only.
7. Round 2 re-validated against the service registry and dispatched over the
   same client path.
8. Added `Evidence.agentId` so reduction/synthesis attribution survives the
   process boundary.
9. Added `InProcessAgentClient` — contract-faithful loopback (admission checks
   included) for dev/local, eval, and tests; eval/adversarial suites migrated
   to it.
10. W3C trace propagation: client injection + server extraction.
11. Generic per-agent Helm chart; per-mode NetworkPolicy; projected
    workload-identity token for the manager; Dockerfile bakes
    `agents/ prompts/ policies/`.

## 9. Migration plan (repeatable for other installations)

| Phase | Action | Verification |
|---|---|---|
| M1 | ship `agent-protocol` + `agent-registry`; add `Evidence.agentId` | `npm run check`; schemas round-trip |
| M2 | ship `agent-client` with mock; rewrite manager fan-out against it | runtime fan-out/round2 tests on `MockAgentClient` |
| M3 | add delegation issuer/verifier; specialist server route | HTTP tests: admission 403/504/413, success 200 |
| M4 | split startup modes (`AGENT_CONFIG`); per-mode dependency graphs | manager and specialist boot from the same image locally |
| M5 | migrate eval/adversarial/load to `InProcessAgentClient` | `npm run eval` — targets unchanged; storm refusal covers agent client |
| M6 | per-agent Helm chart + NetworkPolicies + registry endpoints | `helm lint` + render all releases; DNS names = registry entries |
| M7 | enterprise re-verification | Gate #1 across manager→specialist→ToolHive with real IdP/token exchange (integration point) |

## 10. Tests required for the distributed architecture

| Concern | Test | Status |
|---|---|---|
| protocol schemas + size limits | `packages/agent-protocol/tests/protocol.test.ts` | exists |
| client retry/deadline/registry-fail-closed/size | `packages/agent-client/tests/client.test.ts` | exists |
| registry authz/discovery edges | `packages/agent-registry/tests/registry.test.ts` | exists |
| delegation binding (audience, expiry, request_id, subject hash) | `packages/auth/tests/delegation.test.ts` | exists |
| manager fan-out partial failure, round 2, routing edges | `packages/runtime/tests/{fanout,round2,routing-execution}.test.ts` | exists |
| specialist HTTP admission (403/504) + end-to-end 200 | `apps/api/tests/app.test.ts` | added in this revision |
| session continuity into fan-out requests | `apps/api/tests/app.test.ts` | added in this revision |
| eval/adversarial through the distributed contract | `eval/tests/adversarial.test.ts`, `eval/run.ts` | migrated in this revision |
| storm-profile refusal (real ToolHive or real agent client) | `eval/tests/load-safety.test.ts` | extended in this revision |
| real two-process HTTP smoke (listener required) | manual/CI runner | open — sandbox denies TCP listeners; covered by contract-faithful in-process client |

---

# Revision 2.1 — remediation delta

Supplements Rev 2.0 with the P0/P1 fixes. Code is authoritative; this records what changed.

## Changelog against Rev 2.0

| Area | Change |
|---|---|
| HTTP framework | Fastify → **Express 5** (`apps/api`); runtime stays Express-free; tests use `light-my-request`. |
| Specialist → ToolHive identity | unsigned `x-effective-subject` removed; verified delegated credential (`@sre/auth` `ToolCredentialExchanger`/`Verifier`, `toolHiveAudience`). `ToolInvocation.credential` carries it; `MockToolHiveClient` verifies and audits the effective human; `RealToolHiveClient` sends `Bearer`. `RealTokenExchangeCredentialExchanger` = RFC 8693, INTEGRATION BLOCKER. |
| Tool args | `validateToolArguments` (AJV) pre-flight in `specialist-runner`; invalid ⇒ `MCP_INVALID_CALL`, no backend call, counted in budget. |
| Deadline | absolute deadline fixed at `executeRequest` entry; one AbortController through Manager LLM, fan-out, RAG, Tier-S, MCP, Tier-L; `MockToolHiveClient`/real `callTool` honour `signal`+`timeout`. |
| Routing | `agents/registry.yaml` `routing:{exactTerms,entityPatterns,ambiguousTerms}`; `deterministicRoute(question, RoutingRule[])`; onboarding is config-only. |
| Round 2 | `planRound2` adds `allowedManagerAgents` gate (`not-in-manager-allowlist`). |
| Fallback | `deterministicMultiSpecialistResponse` on Tier-L failure with >1 contributor. |
| Multi-turn | resolved entities injected into specialist context as `TRUSTED_RESOLVED_ENTITIES`. |
| Metrics | `@sre/telemetry` counter/gauge/histogram; `observeDuration`/`observeInflight`; API records request/agent durations. |
| Tracing | OTLP export via `BatchSpanProcessor`. |
| Config | `toolCredential` block; real ToolHive fails closed without the token endpoint. |

## New/updated interfaces

```ts
// @sre/auth
interface ToolCredentialExchanger { readonly mode: "mock"|"real"; exchange(identity, audience, deadline): Promise<ToolCredential> }
interface ToolCredentialVerifier  { verify(credential, expectedAudience, requestId): Promise<VerifiedToolPrincipal> }
// @sre/mcp
function toolHiveAudience(serverId: string): string        // "sre-toolhive:<serverId>"
function validateToolArguments(tool, args): { valid: boolean; reason?: "SCHEMA_VALIDATION_FAILED" }
// @sre/routing
interface RoutingRule { agentId; exactTerms; entityPatterns; ambiguousTerms }
```

## Tests added this revision

`packages/mcp/tests/arg-validator.test.ts`, `apps/api/tests/gate1-toolhive-identity.test.ts`,
`apps/api/tests/gate1-e2e.test.ts`, `packages/runtime/tests/deadline.test.ts`,
`packages/runtime/tests/manager-allowlist.test.ts`, `packages/telemetry/tests/metrics.test.ts`,
new fallback cases in `packages/runtime/tests/fanout.test.ts`, onboard-by-config in
`packages/routing/tests/router.test.ts`, invalid-args-no-backend in
`packages/runtime/tests/specialist.test.ts`.

## Still blocked / deferred

Enterprise RFC 8693 STS and real ToolHive verification (Gate #1 real path);
real Tier-S/Tier-L benchmark run; MCP pooling and tokenizer budgeting (P2). See
`docs/INTEGRATION-POINTS.md`.
