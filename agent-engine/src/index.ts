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
 * The dependency direction is one-way: the engine never imports a host, and no
 * external protocol reaches it. Serving a protocol is a boundary concern; the
 * engine only ever consumes what it is handed.
 */

export * from "./agent/index.ts";
export * from "./errors/index.ts";
export * from "./evidence/index.ts";
export * from "./guardrails/index.ts";
export * from "./lifecycle/index.ts";
export * from "./model/index.ts";
export * from "./runner/index.ts";
export * from "./telemetry/index.ts";
export * from "./tools/index.ts";
