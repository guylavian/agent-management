/**
 * TEST-ONLY SURFACE — `@sre/agent-engine/testing`.
 *
 * Not part of the package contract. Nothing here is intended for production
 * code, and `check-boundaries` fails the build if a non-test file imports this
 * subpath.
 *
 * It exists for one reason: two things a host must be able to prove about the
 * engine can only be proven from OUTSIDE this package, against the host's real
 * configuration, and the engine may not import a host to do it itself.
 *
 *   1. Authorization PARITY. The engine owns authorization. A host may also
 *      have its own implementation of the same policy for its own purposes —
 *      a routing filter, an admin preview — and two implementations of one
 *      policy can drift. The host compares them across every agent × tool ×
 *      principal × environment in its real catalog. That comparison needs both
 *      sides, and the engine cannot import a host without breaking the very
 *      dependency rule that makes it generic.
 *
 *   2. Tool VISIBILITY against a real catalog. "This Agent cannot reach that
 *      server" is a claim about the host's configuration as much as about the
 *      engine, so it is asserted against the configuration that actually ships
 *      rather than against a fixture that could quietly diverge from it.
 *
 * Everything else the engine's own tests need, they import by module path from
 * inside the package. This subpath is not a general escape hatch, and it must
 * not grow into one.
 */

export { authorizeAgent, authorizeAudience, authorizeTool } from "./guardrails/authorization.ts";
export type { AuthorizationDecision } from "./guardrails/authorization.ts";

export { invokeVisibleTool, visibleTools } from "./tools/visibility.ts";
export type { VisibleTool } from "./tools/port.ts";
