# Air-Gapped SRE Agent Platform — PoC TDD

**Document type:** Technical Design Document (TDD)  
**Status:** Draft for implementation  
**Scope:** PoC for Phase 1 read-only Q&A  
**Depends on:** PoC SDD and architecture Rev 1.1  
**Language:** TypeScript 7  
**Runtime:** Node.js 22 LTS, version pinned in the internal mirror  
**Deployment:** OpenShift  
**Source of truth:** Git + YAML  
**MCP gateway:** ToolHive  
**Model API:** Internal OpenAI-compatible endpoints

---

## 1. Technical objective

Implement the minimum production-shaped runtime required to validate the architecture without building a general orchestration framework.

The implementation MUST support:

```text
authenticate
→ authorize request context
→ deterministic route
→ optional one-shot Manager
→ resolve authorized specialists
→ baseline RAG
→ run specialists in parallel
→ call curated MCP tools
→ normalize Evidence[]
→ optional deterministic Round 2
→ conditional synthesis
→ answer
```

---

## 2. Proposed technology stack

Version numbers are intentionally pinned during PoC setup rather than hard-coded in this document.

### Runtime

- TypeScript 7
- Node.js 22 LTS
- Express 5
- native `fetch` / approved HTTP client
- `AbortController` for cancellation

Express 5 is used only as the HTTP/API adapter. Core Agent Runtime packages MUST NOT depend on Express request/response types.

### Schema and configuration

- Zod or equivalent runtime schema validation
- JSON Schema generated/published for YAML validation
- YAML parser
- immutable loaded agent configuration per application revision

### LLM

- OpenAI-compatible TypeScript client
- internal vLLM endpoints
- serving-side constrained/guided JSON for control outputs
- TypeScript validation as a second boundary

### MCP

- official/approved MCP TypeScript SDK
- Streamable HTTP through ToolHive
- no direct vendor API integrations in the Agent Runtime

### RAG

- internal retriever HTTP/gRPC interface
- hybrid lexical + dense retrieval
- ACL-aware query filtering
- reranker
- vector store selected by platform team

### Observability

- OpenTelemetry SDK
- OTLP export to internal collector
- Prometheus metrics where needed
- SIEM audit through ToolHive/gateway logs

### Testing

- unit test runner approved for TypeScript
- HTTP integration test framework
- contract tests for MCP and RAG
- load test tool available offline

---

## 2.1 HTTP framework boundary

Express 5 is the selected HTTP framework for the PoC.

Its responsibilities are limited to:

- HTTP routing;
- OIDC/authentication middleware integration;
- request parsing and body limits;
- request ID propagation;
- HTTP error mapping;
- health/readiness/metrics endpoints;
- streaming the final response where enabled.

Express MUST NOT own:

- Manager routing;
- specialist execution;
- MCP policy;
- RAG behavior;
- Evidence construction;
- authorization policy decisions;
- retries/timeouts beyond HTTP transport concerns;
- Round-2 semantics;
- synthesis decisions.

The dependency direction is:

```text
Express adapter
      ↓
Application service
      ↓
Generic Agent Runtime
```

and never:

```text
Agent Runtime
      ↓
Express
```

This keeps the runtime portable and testable without an HTTP server.

## 3. Repository layout

```text
sre-agent-platform/
├── apps/
│   └── api/
│       ├── src/
│       │   ├── server.ts
│       │   ├── routes/
│       │   └── middleware/
│       └── Dockerfile
│
├── packages/
│   ├── runtime/
│   │   ├── src/
│   │   │   ├── execute-request.ts
│   │   │   ├── execution-context.ts
│   │   │   ├── specialist-runner.ts
│   │   │   ├── round2.ts
│   │   │   ├── synthesis-gate.ts
│   │   │   └── errors.ts
│   │   └── tests/
│   │
│   ├── routing/
│   │   ├── deterministic-router.ts
│   │   ├── manager.ts
│   │   ├── registry.ts
│   │   └── schemas.ts
│   │
│   ├── auth/
│   │   ├── oidc.ts
│   │   ├── identity.ts
│   │   ├── authorization.ts
│   │   └── token-context.ts
│   │
│   ├── mcp/
│   │   ├── toolhive-client.ts
│   │   ├── tool-cache.ts
│   │   ├── tool-executor.ts
│   │   └── normalizer.ts
│   │
│   ├── rag/
│   │   ├── retriever-client.ts
│   │   ├── acl-context.ts
│   │   └── normalizer.ts
│   │
│   ├── evidence/
│   │   ├── evidence.ts
│   │   ├── collector.ts
│   │   ├── redaction.ts
│   │   └── citations.ts
│   │
│   ├── llm/
│   │   ├── client.ts
│   │   ├── structured-output.ts
│   │   ├── tier-router.ts
│   │   └── model-profile.ts
│   │
│   ├── config/
│   │   ├── loader.ts
│   │   ├── schemas.ts
│   │   ├── validation.ts
│   │   └── agent-registry.ts
│   │
│   ├── session/
│   │   ├── bounded-context.ts
│   │   └── entity-resolution.ts
│   │
│   └── telemetry/
│       ├── tracing.ts
│       ├── metrics.ts
│       └── audit-correlation.ts
│
├── agents/
│   ├── manager.yaml
│   ├── active-directory.yaml
│   ├── openshift.yaml
│   └── network-observability.yaml
│
├── prompts/
│   ├── manager.md
│   ├── active-directory.md
│   ├── openshift.md
│   └── network-observability.md
│
├── schemas/
│   └── agent.schema.json
│
├── deploy/
│   ├── helm/
│   └── openshift/
│
├── eval/
│   ├── questions/
│   ├── expected-routing/
│   ├── expected-tools/
│   └── graders/
│
└── docs/
    ├── poc-sdd.md
    └── poc-tdd.md
```

---

## 4. Core domain types

### 4.1 Request identity

```ts
export interface RequestIdentity {
  subject: string;
  groups: string[];
  roles: string[];
  requestId: string;
  sessionId?: string;
}
```

### 4.2 User request

```ts
export interface UserRequest {
  question: string;
  environment?: string;
  identity: RequestIdentity;
  conversation?: {
    resolvedEntities?: Record<string, string>;
    previousRequestId?: string;
  };
}
```

### 4.2.1 Request intent

Intent is not produced by an additional model call.

```ts
export type RequestIntent =
  | "factual"
  | "diagnostic"
  | "procedural"
  | "ambiguous";
```

The deterministic router derives intent from question form, trusted entities and fixed lexical rules. If the Manager is used, allowlisted `reasonCodes` may refine the intent through a fixed runtime mapping.

### 4.2.2 Execution context

```ts
export interface ExecutionContext {
  request: UserRequest;
  identity: RequestIdentity;
  environment: string;
  intent: RequestIntent;
  requestId: string;
  deadline: number;
}
```

### 4.3 Manager decision

```ts
export interface ManagerDecision {
  agents: string[];
  confidence: number;
  alternates?: string[];
  abstain: boolean;
  reasonCodes?: string[];
}
```

Manager output MUST NOT contain arbitrary `task` text.

### 4.4 Evidence

```ts
export type EvidenceStatus =
  | "ok"
  | "empty"
  | "missing"
  | "failed"
  | "stale"
  | "denied";

export interface Evidence {
  id: string;
  kind: "wiki" | "telemetry" | "config" | "missing";

  source: string;
  system: string;
  environment: string;

  observedAt?: string;
  sourceModifiedAt?: string;

  tool?: string;
  query?: string;

  payload?: unknown;
  rawExcerpt?: string;

  confidence?: number;
  citation: string;
  status: EvidenceStatus;

  requestId: string;

  redaction?: {
    applied: boolean;
    categories?: string[];
  };

  truncated?: boolean;
  originalSizeBytes?: number;
}
```

### 4.5 Specialist result

```ts
export interface SpecialistResult {
  agentId: string;
  status: "complete" | "partial" | "failed";

  evidence: Evidence[];

  needsDomain?: string[];

  summary?: string;

  errors?: RuntimeError[];
}
```

### 4.5.1 Specialist summary

`summary` is bounded user-facing prose produced by the specialist from its own evidence.

For a single-specialist factual request that does not escalate to Tier-L, the final response uses this `summary` directly and adds citations and evidence-gap/degraded-state banners deterministically.

`summary` is not evidence and cannot create citations absent from `Evidence[]`.

### 4.6 Round-2 handoff

```ts
export interface DomainHandoff {
  originalQuestion: string;

  reasonCode: string;

  entities: Array<{
    type: string;
    value: string;
  }>;

  evidenceRefs: string[];

  sanitizedFacts: Array<{
    key: string;
    value: string | number | boolean;
  }>;
}
```

No transcript or arbitrary raw model text is permitted in the handoff contract.

---

## 5. Agent YAML schema

### 5.1 Manager

```yaml
apiVersion: sre.ai/v1alpha1
kind: Agent

metadata:
  name: manager
  owner: sre-platform

spec:
  type: manager

  model:
    tier: small
    profile: manager-router

  prompt:
    systemFile: prompts/manager.md

  agents:
    allowed:
      - active-directory
      - openshift
      - network-observability

  execution:
    maxAgentsPerRequest: 3
    maxRounds: 1
    timeoutMs: 1500

  output:
    schema: ManagerDecision
```

`maxRounds` for the Manager is one. Round 2 is a runtime feature, not a second Manager reasoning loop.

### 5.2 Specialist

```yaml
apiVersion: sre.ai/v1alpha1
kind: Agent

metadata:
  name: active-directory
  owner: domain-services

spec:
  type: specialist

  model:
    tier: small
    profile: tool-caller

  prompt:
    systemFile: prompts/active-directory.md

  rag:
    enabled: true
    collections:
      - ad-wiki
    baselineRetrieval: true
    maxFollowupRetrievals: 1
    topK: 8

  mcp:
    servers:
      - active-directory
      - splunk
      - prometheus

    allowedTools:
      - get_replication_status
      - get_dc_health
      - search_ad_events
      - query_prometheus

  execution:
    maxToolCalls: 6
    maxModelTurns: 3
    timeoutMs: 25000
    maxEvidenceBytes: 262144
    maxContextTokens: 12000
    maxEvidenceItems: 32
    maxRawExcerptBytes: 8192

  discovery:
    allowedNeedsDomains:
      - network-observability
```

### 5.3 Schema rules

Validation MUST reject:

- unknown top-level execution constructs;
- expressions;
- arbitrary code;
- loops;
- conditional branches;
- unregistered agents;
- unregistered MCP servers;
- tools not present in the approved catalog;
- manager configs that include direct unrestricted MCP access.

---

## 6. Runtime execution algorithm

```ts
export async function executeRequest(
  req: UserRequest
): Promise<AssistantResponse> {
  const ctx = await buildExecutionContext(req);

  const stage1 = deterministicRouter.route(ctx);

  const routing = stage1.resolved
    ? stage1.decision
    : await manager.selectAgents(ctx);

  let requestedAgents = routing.agents ?? [];

  if (routing.abstain) {
    const ambiguityFanout =
      policy.resolveAbstentionFanout(routing.alternates ?? []);

    if (ambiguityFanout.length === 0) {
      return clarificationResponse(routing);
    }

    requestedAgents = ambiguityFanout;
  }

  const authorizedAgents =
    await authorization.filterAuthorizedAgents(
      ctx.identity,
      requestedAgents,
      ctx.environment
    );

  if (authorizedAgents.length === 0) {
    return authorizationGapResponse({
      requestId: ctx.requestId,
      requestedAgents
    });
  }

  const firstRound = await Promise.allSettled(
    authorizedAgents.map(agentId =>
      runSpecialist(agentId, ctx)
    )
  );

  const collected = evidenceCollector.collect(firstRound);

  const round2Request =
    round2Planner.fromSpecialistResults(collected);

  if (round2Request) {
    const second = await runBoundedRound2(
      round2Request,
      ctx
    );

    evidenceCollector.add(second);
  }

  const evidence = evidenceCollector.finalize();

  const useLargeModel =
    synthesisGate.shouldEscalate(ctx, evidence);

  return useLargeModel
    ? synthesisModel.answer(ctx, evidence)
    : responseBuilder.fromSpecialistSummaries(ctx, collected, evidence);
}
```

Important:

- `Promise.allSettled`, not `Promise.all`, so one specialist failure does not discard successful evidence;
- authorization is checked before execution;
- ToolHive still performs independent per-call enforcement;
- round 2 is produced from typed specialist results;
- no recursive `executeRequest()` call.

---

## 7. Deterministic router

### Inputs

- normalized question;
- trusted hostname/entity extraction;
- explicit environment;
- CMDB lookup;
- static lexicon;
- specialist registry;
- authorization-filtered candidate set.

### Output

```ts
interface Stage1RoutingResult {
  resolved: boolean;
  decision?: {
    agents: string[];
    reasonCode: string;
  };
  candidates?: string[];
}
```

### Rule policy

Rules SHOULD be:

- exact;
- explainable;
- high precision;
- easy to unit test.

Rules MUST NOT aggressively interpret ambiguous generic words.

---

## 8. Manager implementation

### 8.1 Input

The Manager receives only:

```text
original question
trusted entity metadata
authorized specialist descriptors
allowed output schema
```

A specialist descriptor SHOULD be short:

```json
{
  "id": "active-directory",
  "description": "AD, domain controllers, LDAP, identity, replication, DNS-related AD health"
}
```

The Manager does not receive:

- tool schemas;
- wiki payloads;
- MCP output;
- prior specialist transcripts.

### 8.2 Serving constraints

Use serving-side constrained JSON where supported.

Then validate with the TypeScript schema.

Pseudo-flow:

```text
vLLM guided JSON
→ parse
→ Zod validate
→ business validation
→ accept / bounded correction / abstain
```

Business validation includes:

- agent ID exists;
- agent is in the authorized candidate registry;
- number of agents <= configured max;
- confidence is in range;
- no unknown fields.

---

## 9. Specialist execution loop

Specialist execution is bounded.

```text
baseline RAG
→ build context
→ model
→ optional tool calls
→ tool results → redaction → Evidence
→ model
→ optional one follow-up RAG
→ final structured SpecialistResult
```

Limits:

- maximum tool calls;
- maximum model turns;
- total deadline;
- maximum context/evidence size;
- maximum follow-up RAG count.

The runtime, not the prompt, enforces every limit.

---

## 9.1 Context budget implementation

The runtime enforces explicit context/evidence budgets before every Tier-S invocation.

```ts
interface ExecutionBudgets {
  maxEvidenceBytes: number;
  maxContextTokens: number;
  maxEvidenceItems: number;
  maxRawExcerptBytes: number;
}
```

PoC defaults:

```text
maxEvidenceBytes = 262144
maxContextTokens = 12000
maxEvidenceItems = 32
maxRawExcerptBytes = 8192
```

Ownership:

- RAG ranks retrieval candidates.
- Evidence normalization records original sizes.
- The runtime context builder owns final truncation.
- The model never decides which provenance/security fields may be removed.

Order:

```text
normalize
→ redact
→ cap individual raw excerpts
→ prioritize evidence
→ enforce maxEvidenceItems
→ enforce maxEvidenceBytes
→ estimate/tokenize final context
→ enforce maxContextTokens
```

When evidence is shortened:

```ts
evidence.truncated = true;
evidence.originalSizeBytes = originalSize;
```

Status, citation, source, environment, timestamps and redaction metadata MUST survive truncation.

## 10. RAG client contract

```ts
export interface RetrievalRequest {
  query: string;

  collections: string[];

  identity: {
    subject: string;
    groups: string[];
    roles: string[];
  };

  environment?: string;

  topK: number;

  requestId: string;
}

export interface RetrievalHit {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
  score: number;

  sourceModifiedAt?: string;

  citation: string;

  aclDecision: "allowed";
}
```

The retriever MUST NOT return denied chunks.

RAG evidence is normalized before entering the model.

---

## 11. Redaction boundary

All external/untrusted content passes through:

```text
source
→ size limiter
→ normalization
→ secret detector / DLP
→ redactor
→ provenance tagger
→ Evidence
→ model context
```

Examples of redaction targets:

- passwords;
- API tokens;
- bearer tokens;
- private keys;
- connection strings;
- secret environment variables;
- credentials embedded in logs;
- approved enterprise DLP patterns.

Redaction MUST be deterministic and logged without logging the secret itself.

Redaction occurs before truncation. Truncation MUST preserve provenance, status and redaction metadata.

---

## 12. Tool discovery and filtering

### 12.1 Tool catalog

The platform keeps an approved metadata registry:

```ts
interface ApprovedTool {
  serverId: string;
  toolName: string;

  readOnlyVerified: boolean;

  owner: string;

  environments: string[];

  timeoutMs: number;

  retryPolicy: "none" | "transient-once";
}
```

### 12.2 Runtime selection

For a specialist run:

```text
YAML allowedTools
∩ approved ToolHive catalog
∩ user authorization
∩ environment policy
= tools visible to the model
```

No other tool schema is sent to the specialist.

### 12.3 Tool schema cache

Tool schemas MAY be cached in memory with version/TTL.

Cache invalidation MUST NOT expand permissions automatically.

If a configured tool disappears, startup validation or execution fails closed.

---

## 13. MCP execution

Tool calls include:

- request ID;
- effective identity/authorization context as supported by the chosen trust design;
- target environment;
- tool name;
- validated arguments.

Pseudo-flow:

```ts
async function executeTool(call: ToolCall, ctx: ExecutionContext) {
  assertToolVisible(call.tool, ctx);

  const decision = await authorization.preflightTool(
    ctx.identity,
    call,
    ctx.environment
  );

  if (!decision.allowed) {
    return deniedEvidence(call, ctx);
  }

  return withTimeout(
    toolHive.invoke(call, ctx),
    toolTimeout(call.tool)
  );
}
```

ToolHive remains the final gateway policy enforcement point.

---

## 14. Retry rules

### Retry once

Allowed only for:

- connection reset;
- gateway timeout;
- selected 5xx;
- transient connection failure.

### Never retry automatically

- 400/query syntax error;
- 401/403;
- missing tool;
- schema-invalid arguments;
- backend authorization denial;
- explicit rate limit unless policy defines a safe delay inside the request budget.

The runtime owns retries for the PoC.

---

## 15. Timeout and cancellation model

One request has a total deadline.

Suggested PoC defaults:

```text
Manager                    1.5 s
RAG baseline               1.0 s
interactive MCP tool       5.0 s
slow search MCP           15–20 s
specialist total          25 s
Tier-L synthesis           5 s
request hard ceiling      45 s
```

`AbortSignal` SHOULD propagate through:

```text
HTTP request
→ runtime
→ LLM
→ RAG
→ MCP
```

Client disconnect MAY cancel non-essential downstream work.

---

## 16. Round-2 implementation

Round 2 can occur only if:

```text
specialist.needsDomain exists
AND requested domain is approved
AND domain has not already run
AND user is authorized
AND global round2 budget unused
```

The runtime builds `DomainHandoff`.

The second specialist receives:

- original question;
- sanitized entity list;
- reason code;
- evidence references;
- bounded sanitized facts.

It does not receive first-round raw transcripts.

---

## 17. Synthesis gate

```ts
function shouldEscalate(
  ctx: ExecutionContext,
  evidence: Evidence[]
): boolean {
  return (
    uniqueContributingAgents(evidence) > 1 ||
    hasConflicts(evidence) ||
    hasMaterialMissingEvidence(evidence) ||
    ctx.intent === "diagnostic"
  );
}
```

`ctx.intent` is produced by the deterministic intent classifier defined in §4.2.1. No additional model call is made for this field.

This is code, not a Manager decision.

The PoC will tune the rule based on measured quality.

---

## 18. Response contract

```ts
export interface AssistantResponse {
  requestId: string;

  answer: string;

  citations: Array<{
    evidenceId: string;
    label: string;
  }>;

  evidenceGaps: Array<{
    source: string;
    reason: string;
  }>;

  degraded: boolean;

  metadata: {
    routedAgents: string[];
    tierLUsed: boolean;
  };
}
```

Do not expose internal prompts, hidden model reasoning or unrestricted tool catalogs.

---

## 18.1 Non-Tier-L response construction

For a single-specialist factual request that does not escalate:

```text
SpecialistResult.summary
+
deterministic citation rendering from Evidence[]
+
deterministic evidence-gap/degraded-state banners
=
final answer
```

The response builder MUST NOT generate new factual claims beyond small fixed templates around the specialist summary.

Multiple specialists, conflicting evidence or diagnostic intent follow the Tier-L synthesis path.

## 19. API design — Express 5

Recommended Express composition:

```ts
const app = express();

app.use(requestIdMiddleware());
app.use(jsonBodyLimitMiddleware());
app.use(oidcAuthenticationMiddleware());

app.post("/v1/query", queryController);
app.get("/health/live", livenessController);
app.get("/health/ready", readinessController);
app.get("/metrics", metricsController);
```

Controllers MUST delegate immediately to application/runtime services and MUST NOT contain agent orchestration logic.

### `POST /v1/query`

Request:

```json
{
  "question": "Is AD replication healthy between DC-TLV-01 and DC-HFA-02?",
  "environment": "prod",
  "sessionId": "optional"
}
```

Identity is derived from OIDC, not from user-provided JSON fields.

Response:

```json
{
  "requestId": "req-123",
  "answer": "...",
  "citations": [],
  "evidenceGaps": [],
  "degraded": false,
  "metadata": {
    "routedAgents": ["active-directory"],
    "tierLUsed": false
  }
}
```

### `GET /health/live`

Process liveness only.

### `GET /health/ready`

Checks required runtime dependencies according to readiness policy.

Do not mark the API unready merely because one optional MCP backend is degraded.

### `GET /metrics`

Internal metrics endpoint if Prometheus scraping is selected.

---

## 20. Authentication middleware

The API MUST:

1. validate signature;
2. validate issuer;
3. validate intended audience;
4. validate expiry/not-before;
5. extract stable subject;
6. map groups/roles according to enterprise identity policy;
7. assign request ID;
8. reject missing/invalid identity.

Authorization claims are never taken from the body.

---

## 21. Session context

PoC session state is intentionally small.

```ts
interface BoundedSessionContext {
  sessionId: string;
  subject: string;

  entities: Array<{
    alias: string;
    canonical: string;
    type: string;
  }>;

  previousRequestId?: string;

  expiresAt: string;
}
```

Rules:

- keyed by user + session;
- short TTL;
- no cross-user access;
- no hidden agent memory;
- live evidence is never reused as current state in the PoC; every follow-up refreshes live evidence;
- authorization is re-evaluated on every request.

---

## 22. Configuration loading

At process startup:

1. load all YAML;
2. validate JSON Schema;
3. validate semantic references;
4. load prompt files;
5. validate registered model profiles;
6. validate MCP/tool references against approved catalog;
7. build immutable agent registry;
8. fail startup on unsafe configuration.

Hot reload is not required for PoC.

A deployment revision corresponds to one immutable config version.

---

## 23. CI validation

Pull requests that modify agent configuration MUST run:

```text
YAML parse
→ JSON Schema
→ semantic validation
→ tool allowlist validation
→ prompt file existence
→ owner validation
→ unit tests
→ security policy checks
```

Changes to:

- `allowedTools`;
- MCP servers;
- authorization metadata;
- environment scope

MUST require designated security/owner review.

---

## 24. Error taxonomy

```ts
type RuntimeErrorCode =
  | "AUTHN_FAILED"
  | "AUTHZ_DENIED"
  | "ROUTE_AMBIGUOUS"
  | "ROUTE_INVALID"
  | "MODEL_TIMEOUT"
  | "MODEL_INVALID_OUTPUT"
  | "RAG_UNAVAILABLE"
  | "RAG_DENIED"
  | "MCP_UNAVAILABLE"
  | "MCP_TIMEOUT"
  | "MCP_INVALID_CALL"
  | "TOOL_DENIED"
  | "TOOL_FAILED"
  | "EVIDENCE_STALE"
  | "REDACTION_FAILURE"
  | "REQUEST_TIMEOUT";
```

Errors are converted to visible evidence gaps where safe.

Security errors MUST NOT leak sensitive policy internals.

---

## 25. OpenTelemetry design

Top-level trace:

```text
sre.query
```

Recommended child spans:

```text
authn.validate
session.resolve
route.stage1
route.manager
authz.agent
rag.baseline.<agent>
specialist.<agent>
llm.specialist.<agent>
mcp.<server>.<tool>
redaction
rag.followup.<agent>
round2.resolve
specialist.round2.<agent>
synthesis.gate
llm.synthesis
response.build
```

Common attributes:

```text
request.id
user.subject_hash
agent.id
environment
model.tier
mcp.server
mcp.tool
evidence.count
evidence.missing_count
route.source
round.number
```

Do not put raw sensitive prompts/tool payloads into traces by default.

---

## 26. Metrics

PoC metrics:

```text
sre_requests_total
sre_request_duration_seconds
sre_route_stage1_total
sre_manager_invocations_total
sre_manager_abstentions_total
sre_specialist_invocations_total
sre_round2_total
sre_tool_calls_total
sre_tool_call_duration_seconds
sre_tool_errors_total
sre_rag_duration_seconds
sre_evidence_total
sre_missing_evidence_total
sre_tier_l_invocations_total
sre_authz_denials_total
sre_invalid_model_outputs_total
```

Never expose user-identifying high-cardinality labels to Prometheus.

---

## 27. Read-only onboarding checklist for each MCP tool

Before a tool enters the approved catalog:

- [ ] owner identified;
- [ ] backend operation documented;
- [ ] read-only behavior verified;
- [ ] backend credential cannot mutate;
- [ ] allowed environment documented;
- [ ] timeout defined;
- [ ] retry behavior defined;
- [ ] response size bounded;
- [ ] secrets/redaction behavior tested;
- [ ] audit correlation verified;
- [ ] failure behavior tested.

Tool naming alone does not satisfy the checklist.

---

## 28. PoC tests

### 28.1 Architecture Gate tests

**AG-01 Human identity reaches policy boundary**

Expected: gateway/audit distinguishes test users.

**AG-02 Unauthorized tool is denied**

Expected: no backend call.

**AG-03 No mutating tool exists**

Expected: write intent cannot resolve to a callable capability.

### 28.2 Routing

- deterministic AD route;
- deterministic OpenShift route;
- unresolved cross-domain Manager route;
- ambiguous route -> abstain/allowed fan-out;
- unauthorized specialist removed after routing.

### 28.2.1 Routing edge cases

- `abstain=true` + permitted alternates → bounded top-2 fan-out.
- `abstain=true` + no permitted fan-out → clarification and zero tool calls.
- routing succeeds but AuthZ filters all selected agents → explicit authorization-gap response and zero specialist executions.
- unknown agent ID → fail closed.
- deterministic Stage-1 route denied by AuthZ → explicit authorization-gap response.

### 28.3 Specialist

- correct tool selected;
- malformed output rejected;
- tool timeout becomes missing evidence;
- `empty` remains empty;
- follow-up RAG bounded to one.

### 28.4 Round 2

- valid `needsDomain`;
- unauthorized domain rejected;
- second request for another domain rejected after budget consumed;
- no transcript leakage.

### 28.5 Security

- wiki prompt injection;
- log prompt injection;
- secret in tool payload;
- tool catalogue extraction request;
- previous-user question request;
- service account/confused-deputy test.

### 28.6 Degradation

- ToolHive 503;
- RAG unavailable;
- one specialist timeout;
- conflicting wiki/live state;
- stale evidence.

---

## 29. Evaluation harness

Each benchmark case SHOULD define:

```yaml
id: B1

question: >
  Payments checkout is slow. Is it F5, OpenShift ingress,
  or the database?

expected:
  domains:
    - network-observability
    - openshift

  acceptableAbstain: false

  requiredEvidenceKinds:
    - telemetry

  forbiddenTools: []

  securityViolationAllowed: false
```

The harness records:

- route;
- semantic route equivalence;
- tools;
- retries;
- evidence;
- citations;
- model calls;
- latency;
- errors;
- final answer.

Run each question at least eight times for consistency metrics.

---

## 29.1 Grading protocol

### Unsupported claims

Use a pinned local Tier-L model as an automated judge with a fixed rubric.

Judge input:

```text
question
final answer
cited Evidence[]
```

Structured output:

```ts
interface ClaimGrade {
  claim: string;
  supported: boolean;
  supportingEvidenceIds: string[];
  reasonCode: string;
}
```

Target: unsupported claims `<2%`.

Human review covers at least 20% of benchmark cases plus every security/adversarial failure and judge disagreement.

### Citation correctness

A citation passes only when:

1. the evidence ID exists;
2. the user was entitled to the evidence;
3. the evidence materially supports the claim;
4. environment and timestamps are represented correctly.

Target: `>95%`.

The judge model version, prompt and rubric are stored with every benchmark run.

## 30. Load testing

Test at minimum:

### Normal

1–5 concurrent users against approved real read-only backends, with owner coordination.

### Expected burst

20 concurrent users. Use real backends only with explicit owner approval, safe query profiles and configured rate limits; otherwise use lab/replay MCPs.

### Incident storm

50 concurrent users against mock, replay, lab or synthetic MCP backends by default.

Do not run a synthetic 50-user storm against production Splunk, LDAP, database or network APIs simply because calls are read-only.

Measure:

- end-to-end p50/p95;
- Manager queueing;
- vLLM queueing;
- MCP backend saturation;
- RAG saturation;
- connection pool behavior;
- cancellation;
- error rate;
- GPU-seconds/request.

The TypeScript runtime itself is expected to be I/O-bound. Profiling MUST confirm this rather than assume language/runtime throughput is the bottleneck.

---

## 31. Deployment

### Runtime pod

- non-root;
- read-only root filesystem where practical;
- no external egress;
- ConfigMap/Secret only for non-agent operational config;
- agent YAML delivered through immutable deployment artifact or GitOps-controlled config;
- liveness/readiness;
- CPU/memory limits;
- OTel exporter configured internally.

### Network policy

Default deny.

Allow only required flows:

```text
API → IdP
Runtime → vLLM
Runtime → RAG
Runtime → ToolHive
RAG → vector/document services
ToolHive/MCP → approved backend endpoints
OTel → collector
```

---

## 32. Offline supply chain

PoC build manifest MUST enumerate:

- npm packages;
- container base images;
- application images;
- ToolHive images/charts;
- MCP server images;
- vLLM image;
- model files;
- embedding/reranker files;
- OpenShift manifests/charts.

Every dependency must have an internal source.

No runtime CDN/download path is permitted.

---

## 33. Implementation phases

### Phase T0 — Skeleton and design freeze

Deliver:

- repo;
- API;
- config loader;
- telemetry;
- mock model/MCP/RAG interfaces;
- frozen Node.js 22 / TypeScript 7 / Express 5 baseline;
- selected runtime schema validator;
- exact MCP SDK version;
- documented ToolHive/IdP token-exchange design for T1;
- context-budget defaults;
- deterministic intent-classification rules;
- non-Tier-L response contract;
- benchmark grading rubric;
- safe load-test environment plan.

### Phase T1 — Security gate

Deliver:

- OIDC;
- request identity;
- ToolHive integration;
- one denied/one allowed tool path;
- audit correlation.

Exit criterion: Architecture Gate #1 passes.

### Phase T2 — One specialist

Deliver AD specialist:

- baseline RAG;
- 5–10 MCP tools;
- evidence;
- citations;
- failure states.

### Phase T3 — Routing

Deliver:

- deterministic router;
- Manager;
- constrained output;
- abstain flow.

### Phase T4 — Fan-out

Deliver:

- three specialists;
- parallel execution;
- partial failure handling;
- synthesis gate.

### Phase T5 — Round 2

Deliver:

- `needsDomain`;
- sanitized handoff;
- second-round budget.

### Phase T6 — Adversarial/eval

Deliver:

- benchmark harness;
- pass@1/pass^8;
- injection/redaction tests;
- load tests.

---

## 34. Implementation red lines

Do NOT add to the PoC runtime:

- arbitrary workflow graph representation;
- generic `if`/`else` nodes;
- user-configurable loops;
- dynamic code execution;
- durable workflow persistence;
- specialist-to-specialist direct calls;
- hidden long-term memory;
- generic plugin execution outside MCP;
- write/remediation actions.

If implementation pressure requires these, raise an architecture decision instead of adding another runtime abstraction.

---

## 35. Definition of done

The PoC is technically complete when:

- [ ] the runtime loads all agents from validated YAML;
- [ ] OIDC user identity is established;
- [ ] identity/authorization survives the ToolHive path;
- [ ] tool policy violations remain zero;
- [ ] three specialists run using one shared runtime;
- [ ] Stage-1 deterministic routing works;
- [ ] Manager structured selection works;
- [ ] fan-out runs in parallel;
- [ ] RAG is ACL-aware;
- [ ] evidence is provenance-tagged and redacted;
- [ ] Round 2 is bounded and deterministic;
- [ ] failure states are visible;
- [ ] Tier-L is conditional;
- [ ] OpenTelemetry traces the full request;
- [ ] security audit correlates via request ID;
- [ ] evaluation reports pass@1 and pass^8;
- [ ] load tests run at 20 and 50 concurrent users;
- [ ] deployment works using only internal/offline artifacts;
- [ ] no red-line feature was required.

---

## 36. Technical decisions and freeze points

### 36.1 Freeze before T1

These are prerequisites for Architecture Gate #1:

1. Node.js 22 LTS + TypeScript 7 baseline.
2. Express 5 HTTP framework baseline.
3. Runtime schema validator / YAML validation approach.
4. Exact MCP TypeScript SDK version.
5. ToolHive identity propagation / token-exchange pattern supported by the enterprise IdP.
6. Initial request-ID and audit-correlation convention.
7. Minimum OIDC claim mapping.

### 36.2 Freeze before T2/T3 as required

1. Initial RAG transport contract.
2. Initial retrieval/vector implementation for the controlled PoC corpus.
3. Minimum redaction/DLP rule set.
4. Tier-S model candidates for routing/tool calling.
5. Guided/constrained JSON serving configuration.
6. Approved-tool catalog format.

### 36.3 May remain open until after early gates

1. Production vector store choice.
2. Full enterprise DLP integration depth.
3. Tier-L production model.
4. LLM observability backend.
5. Long-term session-store technology.
6. Production retention policies.
7. Any future workflow/orchestration engine.

> Freeze each dependency before the first gate that requires it; never postpone a prerequisite until after the gate it is supposed to validate.
