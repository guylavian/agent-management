# The Agent engine

`agent-engine/` is a generic Agent execution engine. It runs one bounded,
evidence-producing investigation: a model proposes actions, deterministic
runtime code decides whether they are allowed, and typed Evidence accumulates
until the model answers or a budget stops it.

It knows nothing about this platform. No Keycloak, no ToolHive, no MCP, no
OpenTelemetry, no domain. A host supplies an `AgentDefinition`, a `ToolPolicy`
and four ports; the engine supplies the execution semantics and every guardrail.

```
src/
├── agent/       AgentDefinition, budgets, tool access, Principal, credential
├── runner/      runAgent, the bounded loop, control actions, run results
├── model/       Model port and message/tool-schema primitives
├── tools/       ToolProvider port, visibility, argument validation, execution
├── evidence/    redaction-then-truncation boundary and set budgets
├── guardrails/  authorization, deadlines, read-only backstop, Sanitizer port
├── lifecycle/   CredentialProvider port and per-run credential acquisition
├── telemetry/   Telemetry port, no-op default, subject hashing
├── errors/      taxonomy, transience, safe messages
├── index.ts     THE PACKAGE CONTRACT — 35 curated exports
└── testing.ts   conformance-test subpath; production imports fail the build
```

`src/` holds directories and those two files. A file at the root is a file that
belongs to no concern.

## The package contract

`src/index.ts` is a curated list of **35 symbols**, not a barrel. It was 77.

| Group | Exported |
|---|---|
| entry point | `runAgent`, `AgentRunContext`, `EngineDependencies` |
| what an Agent is | `AgentDefinition`, `AgentBudgets`, `AgentToolAccess`, `AgentWorkload`, `Principal`, `ToolCredential` |
| Model port | `Model`, `ModelRequest`, `ModelResponse`, `ModelMessage`, `ModelToolCall`, `ModelToolSchema` |
| ToolProvider port | `ToolProvider`, `ToolDescriptor`, `ToolCallRequest`, `ToolCallResult`, `ListToolsOptions`, `ApprovedTool`, `ToolPolicy` |
| Sanitizer / Telemetry | `Sanitizer`, `Telemetry`, `SpanAttributes`, `noopTelemetry` |
| CredentialProvider | `CredentialProvider`, `WorkloadRef` |
| results and failures | `AgentResult`, `Evidence`, `EvidenceStatus`, `DomainHandoff`, `RuntimeError`, `RuntimeErrorCode`, `engineError` |

Everything a host must be able to NAME in order to run an Agent, and nothing
else. The loop, tool execution, result construction, credential exchange,
evidence normalisation, the authorization predicates and the envelope parser are
**37 now-private symbols**, so changing any of them is not a breaking change.

`genericity.test.ts` asserts this list EXACTLY rather than with `toContain`, so
adding an export is as deliberate an act as removing one. A barrel that grows
quietly is how an implementation detail becomes a compatibility obligation.

### The one exception, and why it exists

`@sre/agent-engine/testing` exposes seven symbols — `authorizeAgent`,
`authorizeTool`, `authorizeAudience`, `AuthorizationDecision`, `visibleTools`,
`invokeVisibleTool`, `VisibleTool`.

Two claims about the engine can only be proven from OUTSIDE the package, against
the host's real configuration, and the engine may not import a host to prove
them itself:

1. **Authorization parity** — the engine's predicates must agree with the
   platform's `AuthorizationService` across every agent × tool × principal ×
   environment in the shipping catalog.
2. **Tool visibility against the real catalog** — "this Agent cannot reach that
   server" is a claim about configuration as much as about code, so it is
   asserted against the configuration that actually ships.

Both consumers were examined individually; neither can move into
`agent-engine/tests/` without losing what it proves, because their value comes
from the real catalog rather than from engine logic.

`check-boundaries` fails the build if any non-test file imports this subpath,
and `platform/tests/boundaries.test.ts` asserts the rule by name. The guard was
verified by planting a violating import and confirming a non-zero exit.

## The ports

| Port | Required | Why |
|---|---|---|
| `Model` | yes | there is no investigation without one |
| `ToolProvider` | yes | `listTools` + `invoke`; no protocol named |
| `Sanitizer` | **yes** | see below |
| `Telemetry` | no — no-op default | losing a span loses observability, not safety |
| `CredentialProvider` | no | a host with no delegated identity model passes none |

`Sanitizer` has no default **on purpose**. A default would have to be either a
no-op — silently disabling redaction on every host that forgot to pass one — or
a second pattern set that could disagree with the host's. Making it required
means an engine that redacts nothing cannot be constructed.

`Telemetry` does default, and the asymmetry is the point: the two are not the
same kind of dependency, so they are not treated the same way.

## Authorization is owned, not injected

`guardrails/authorization.ts` is engine code, not a port. The decisions that make
an Agent safe live in the component that executes tools, so a host cannot satisfy
them with a permissive object:

```
authorizeAgent   enabled ∧ requiredRoles ⊆ principal.roles
authorizeTool    authorizeAgent ∧ granted on THIS server ∧ readOnlyVerified
                 ∧ agent.readOnly ∧ environment listed
authorizeAudience  the credential's audience == the audience declared for that server
```

A host narrows what it puts in the `AgentDefinition` and the `ToolPolicy`. It
cannot widen these. Each conjunct is an independent layer and none is redundant —
`tests/authorization.test.ts` removes them one at a time and asserts each removal
denies.

The platform's `AuthorizationService` still serves the Manager's routing filter.
Two implementations of one policy can drift, so
`platform/tests/security-regression.test.ts` compares them across every agent,
tool, principal and environment in the catalog and fails on any disagreement.

## What the model may do, and what it may not

The model decides WHAT to investigate. The runtime decides whether it is
ALLOWED. Nothing the model returns is trusted — not the tool name, not the
arguments, not the evidence IDs it cites:

```
model names a tool  ──► is it in the visible set?        no ─► MCP_INVALID_CALL, no provider call
                    ──► do the arguments match schema?   no ─► MCP_INVALID_CALL, no provider call
                    ──► is it still visible right now?   no ─► TOOL_DENIED
                    ──► is the credential bound to it?   no ─► TOOL_DENIED, credential never presented
model cites evidence ─► did the run collect that ID?     no ─► dropped + MODEL_INVALID_OUTPUT
```

Visibility is `policy ∩ published ∩ read-only ∩ authorized`, fixed for the loop —
and **recomputed at the moment of every call**, so an Agent disabled or a tool
withdrawn mid-investigation stops the very next call rather than the next run.

Untrusted content is labelled, never merged. The system prompt is the only
instruction channel; a handoff, a resolved entity and every tool result arrive
fenced and marked as data.

## Genericity is tested, not documented

`tests/genericity.test.ts` fails the build if the engine reacquires a platform
dependency, a product name or a protocol SDK:

- imports only `@sre/evidence`, `ajv`, `zod`, `node:crypto`
- declares only those three in `package.json`
- names no product, vendor or domain
- imports no protocol SDK, client or server
- `src/` holds directories, `index.ts` and `testing.ts`
- the public surface is exactly the 35 names above, and the test subpath exactly 7

The engine's own tests use a **synthetic host** — invented server names, an
in-memory `ToolProvider`, a toy sanitizer. Borrowing the platform's real Agent
catalog would have made "the engine is generic" an assertion in a comment rather
than something the suite demonstrates.

## What survived, and is stated rather than hidden

Two protocol-flavoured names remain, both strings in the contract the engine
shares with its host, neither of them protocol code:

1. Evidence ids and citations use an `mcp:` / `mcp://` URI scheme.
2. The shared error taxonomy has `MCP_*` codes.

Renaming either would change every evidence id, stored run and evaluation
fixture that already depends on them. The cost is real and the benefit is
cosmetic, so they stay — confined to `tools/evidence.ts` and the taxonomy, and
confined by a test that fails if they spread.

`@sre/evidence` is the one platform package the engine still imports, and it
qualifies as a neutral contract: 68 lines of Zod, zero dependencies beyond
`zod`, no implementation, no domain knowledge. It cannot move into the engine
because `contracts/agent-protocol`, the portal and the management API also
consume it, and `check-boundaries` forbids `contracts → agent-engine`.

## The host side

Everything that translates between this platform and the engine lives in
`platform/runtime-host/src/adapters/`, at the composition root:

| Adapter | Maps |
|---|---|
| `ports.ts` | Agent document → `AgentDefinition`, catalog → `ToolPolicy`, `@sre/redaction` → `Sanitizer`, `@sre/telemetry` → `Telemetry`, token exchange → `CredentialProvider` |
| `toolhive.ts` | ToolHive/MCP → `ToolProvider` |
| `direct-mcp.ts` | direct MCP endpoints → `ToolProvider` (local dev) |
| `specialist.ts` | `runSpecialist` / `runSpecialistInstance` in platform terms |

The projection onto `AgentDefinition` is lossy on purpose: routing,
capabilities, cross-domain policy and ownership are not passed through, because
the engine cannot use them and must not be able to read them.

Span and metric names are mapped in the adapter, not emitted by the engine. The
engine emits `tool.call.*`, `model.turn.*`, `tool.server`, `agent.invocations`;
`platformTelemetry` renames them to the platform's documented
`toolhive.call.*`, `llm.specialist.*`, `mcp.server`, `sre_*_total`. The engine
must not know that this platform calls its tool gateway ToolHive; the dashboards
that already exist must not break. Both hold.
