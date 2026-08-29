# Internal Agent API contract — `internal/v1`

**Status:** Implemented (PoC)
**Producers:** every specialist deployment of the Generic Agent Runtime
**Consumer:** the manager deployment only (enforced by NetworkPolicy and workload identity)
**Source of truth:** `packages/agent-protocol/src/index.ts` — this document describes that code; on divergence the code wins and this file must be updated.

## 1. Purpose and scope

The internal Agent API is the only channel between the manager and specialist
deployments. It is a versioned, typed HTTP contract — deliberately not A2A, not
a message bus, and not a workflow engine: one platform, one trust domain, one
runtime implementation.

A specialist never calls another specialist. Cross-domain needs surface as
`needsDomain` in the response and are resolved by the manager (bounded Round 2).

## 2. Versioning

- The protocol version is carried in the path: `POST /internal/v1/execute`
  (`AGENT_PROTOCOL_VERSION = "internal/v1"`).
- Request and response bodies are validated with strict schemas on both sides;
  unknown fields are rejected, so additive changes require a new version.
- Manager and specialists deploy from the same image; version skew is limited
  to rollout windows. A breaking change ships as `/internal/v2/...` alongside
  `v1` for the rollout, then `v1` is removed.

## 3. Transport

| Aspect | Value |
|---|---|
| Endpoint | `POST /internal/v1/execute` |
| Content type | `application/json` |
| Correlation | `x-request-id` header (mirror of body `requestId`) |
| Tracing | W3C `traceparent`/`tracestate` headers, injected by the manager (`propagation.inject`) and extracted by the specialist (`withExtractedContext`) so one `sre.query` trace spans both processes |
| Service resolution | manager resolves `agentId → endpoint` through the effective catalog (canonical Agents ∩ `deploy/environments/<env>`); unknown or not-enabled entries fail closed as `AGENT_UNAVAILABLE` |

## 4. Authentication — two credentials, both mandatory

The specialist rejects the request unless **both** verifications pass, before
any execution begins.

1. **Workload identity (who is calling):** `Authorization: Bearer <token>`.
   In production this is the manager's projected ServiceAccount/OIDC token
   (audience `sre-agent-runtime`), re-read from disk per call so rotation is
   observed, and verified against the internal OIDC issuer. In mock mode a
   fixed local test token is accepted.
2. **Delegated human identity (on whose behalf):** `body.identityContext`, a
   JWT issued by the manager-side `DelegatedIdentityIssuer`:
   - audience-bound to exactly one target: `sre-agent:<agentId>` — a token for
     one specialist cannot be replayed to another;
   - expiry capped at `min(60 s, request deadline)`;
   - carries `sub`, `groups`, `roles`, `request_id`;
   - the specialist verifies signature, issuer, audience, `request_id`
     equality with the request, and that `sha256(sub)` equals the
     context's `subjectHash`.

An unsigned or manager-asserted identity (e.g. an `x-effective-user` header)
is never trusted. Mock issuer/verifier share an injected HS256 secret;
production uses RS256 with a JWKS-verified enterprise token-exchange issuer
(`PrivateKeyDelegatedIdentityIssuer` / `JwksDelegatedIdentityVerifier`).
Downstream, ToolHive still authorizes every tool call against this effective
human identity — Architecture Gate #1 spans the full
manager → specialist → ToolHive → MCP path.

## 5. Request schema (`agentExecutionRequestSchema`, strict)

| Field | Type | Notes |
|---|---|---|
| `requestId` | string 1..128 | one ID per user request, end to end |
| `question` | string 1..8000 | original user question (redacted by the manager; redacted again on receipt) |
| `environment` | string 1..128 | target environment (`prod`, `dr`, `lab`) |
| `identityContext` | object | delegated identity JWT + `tokenType` (`urn:ietf:params:oauth:token-type:jwt`), `issuer`, `audience`, `subjectHash` (hex sha256) |
| `conversationContext?` | object | `resolvedEntities?: Record<string, string ≤512>` — bounded session entities only, never transcripts |
| `handoff?` | `DomainHandoff` | Round-2 only: `originalQuestion`, `reasonCode`, typed `entities`, `evidenceRefs`, scalar-only `sanitizedFacts` (schema-enforced `string | number | boolean` values) |
| `deadline` | ISO 8601 datetime with offset | absolute; expired deadline → `504` without execution |

## 6. Response schema (`agentExecutionResponseSchema` = `specialistResultSchema`)

`SpecialistResult`: `agentId`, `status: "complete" | "partial" | "failed"`,
`evidence: Evidence[]`, `summary?`, `needsDomain?` (max 1 in practice),
`errors?: RuntimeError[]`.

`Evidence` is the platform contract (TDD §4.4) plus one distributed-model
addition: a required **`agentId`** attribution field, so the manager-side
reducer and synthesis gate can count contributing agents after evidence has
crossed the process boundary.

Security invariants on the producing side:

- redaction runs inside evidence normalization **before** the result leaves
  the specialist process; `summary` prose is redacted again as defence in depth;
- no model transcript, prompt, or tool schema ever appears in the response;
- provenance (`status`, `citation`, timestamps, redaction metadata) survives
  truncation.

## 7. Size limits (enforced on both sides)

| Direction | Limit | Enforcement |
|---|---|---|
| Request | 64 KiB (`MAX_AGENT_REQUEST_BYTES`) | client `assertSerializedLimit` before send; server Fastify `bodyLimit` + `assertSerializedLimit` → `413 AGENT_REQUEST_TOO_LARGE` |
| Response | 512 KiB (`MAX_AGENT_RESPONSE_BYTES`) | server before send → `502 AGENT_RESPONSE_TOO_LARGE`; client checks `content-length` and the received body |

## 8. Deadlines and cancellation

- The manager computes one absolute request deadline and passes it verbatim;
  each hop derives its own remaining budget from it.
- Client-side: `AbortSignal.any([callerSignal, AbortSignal.timeout(remaining)])`.
- Server-side: expired deadline → `504 AGENT_TIMEOUT`; client disconnect aborts
  the in-flight specialist work through the wired `AbortController`.

## 9. Error model

HTTP status ↔ transport code mapping (`AgentTransportError`):

| HTTP | Code | Retry by manager | Meaning |
|---|---|---|---|
| 400 | `AGENT_INVALID_RESPONSE` | no | request failed schema validation |
| 401/403 | `AGENT_UNAUTHORIZED` | no | workload or delegated identity rejected |
| 413 | `AGENT_REQUEST_TOO_LARGE` | no | request over protocol limit |
| 500 | `AGENT_EXECUTION_FAILED` | no | specialist internal failure (never conflated with authorization) |
| 502 | `AGENT_RESPONSE_TOO_LARGE` | no | response over protocol limit |
| 502/503/504 (transport) | `AGENT_UNAVAILABLE` | once | connection-level failure or upstream unavailability |
| 504 | `AGENT_TIMEOUT` | no | deadline expired |

Retry ownership: the manager's `HttpAgentClient` retries **once** on transport
502/503/504 only. Specialist→ToolHive retries follow the approved-catalog
`retryPolicy` (`none` / `transient-once`). No other layer retries — no nested
retry storms.

The manager converts every transport failure into visible `missing`/`denied`
evidence with a safe message; error bodies never carry policy internals,
stack traces, or specialist configuration.

## 10. Health endpoints

`GET /health/live` and `GET /health/ready` on every agent deployment return
`{ status, mode, agentId }` (+ `configRevision` on readiness). One unhealthy
specialist affects only its own Deployment — the manager records it as
`AGENT_UNAVAILABLE` evidence and continues with the others.

## 11. Local parity

`InProcessAgentClient` (`packages/runtime/src/in-process-agent-client.ts`)
implements this same contract — admission checks included — without a TCP
listener, and backs dev/local, the evaluation harness and tests. `MockAgentClient`
provides scripted responses for manager-side unit tests.
