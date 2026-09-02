/**
 * A generic Agent execution engine.
 *
 * It runs one bounded, evidence-producing investigation: a model proposes
 * actions, deterministic runtime code decides whether they are allowed, and
 * typed Evidence accumulates until the model answers or a budget stops it.
 *
 * It knows nothing about any particular domain, product, protocol or platform.
 * A host supplies an AgentDefinition, a ToolPolicy and the ports below; the
 * engine supplies the execution semantics and every guardrail.
 *
 * THIS FILE IS THE PACKAGE CONTRACT.
 *
 * It is a curated list, not a barrel. Everything named here is something a HOST
 * must be able to name in order to run an Agent: the entry point, the shapes it
 * passes in, the ports it implements, and the result it gets back. Everything
 * else — the loop, tool execution, result construction, credential exchange,
 * evidence normalisation, the authorization predicates, the envelope parser —
 * is an implementation detail and is deliberately absent, so that changing it
 * is not a breaking change.
 *
 * A few internals are reachable from `@sre/agent-engine/testing`. That subpath
 * exists for cross-package conformance tests that cannot be written inside this
 * package, and production code importing it fails the boundary check.
 */

// ── entry point ──────────────────────────────────────────────────────────────
export { runAgent } from "./runner/run.ts";
export type { AgentRunContext, EngineDependencies } from "./runner/run.ts";

// ── what an Agent IS, in the engine's own vocabulary ─────────────────────────
export type { AgentBudgets, AgentDefinition, AgentToolAccess, AgentWorkload } from "./agent/definition.ts";
export type { Principal, ToolCredential } from "./agent/principal.ts";

// ── the Model port ───────────────────────────────────────────────────────────
export type { Model, ModelMessage, ModelRequest, ModelResponse, ModelToolCall, ModelToolSchema } from "./model/port.ts";

// ── the ToolProvider port, and the policy that bounds it ─────────────────────
export type { ApprovedTool, ListToolsOptions, ToolCallRequest, ToolCallResult, ToolDescriptor, ToolPolicy, ToolProvider } from "./tools/port.ts";

// ── the Sanitizer port: REQUIRED, with no engine default, so that an engine
//    which redacts nothing cannot be constructed ─────────────────────────────
export type { Sanitizer } from "./guardrails/sanitizer.ts";

// ── the Telemetry port: optional, because a lost span is not a lost security
//    property. The asymmetry with Sanitizer is deliberate. ──────────────────
export { noopTelemetry } from "./telemetry/port.ts";
export type { SpanAttributes, Telemetry } from "./telemetry/port.ts";

// ── the CredentialProvider port: optional; a host with no delegated identity
//    model passes none and the engine calls tools without a credential ──────
export type { CredentialProvider, WorkloadRef } from "./lifecycle/credentials.ts";

// ── what a run produces, and how it fails ────────────────────────────────────
export type { AgentResult, HandoffRequest, Evidence, EvidenceStatus } from "./evidence/index.ts";
export type { EngineError, EngineErrorCode } from "./errors/index.ts";

/**
 * Tag an error with a taxonomy code the engine understands. A ToolProvider that
 * throws `engineError("TOOL_TIMEOUT", …)` gets the engine's transient-retry and
 * evidence handling; anything else is treated as a non-retryable tool failure.
 */
export { engineError } from "./errors/index.ts";
