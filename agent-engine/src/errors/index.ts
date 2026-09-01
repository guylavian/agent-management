import { ZodError } from "zod";
import type { RuntimeError, RuntimeErrorCode } from "@sre/evidence";

/**
 * Engine error handling.
 *
 * Two rules hold everywhere below. Failures fail CLOSED: an unrecognised error
 * is a failure, never a pass. And messages that leave the engine are SAFE: they
 * say that a source was not authorized, not which policy denied it, so an error
 * string can never be used to enumerate the tool allowlist.
 */

const TRANSIENT_CODES = ["MCP_TIMEOUT", "MCP_UNAVAILABLE", "REQUEST_TIMEOUT", "ECONNRESET"];

/** An error carrying a taxonomy code, which the loop maps to a RuntimeError. */
export function engineError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "TOOL_FAILED";
}

export function isTransient(code: string): boolean {
  return TRANSIENT_CODES.includes(code);
}

/** Narrow an arbitrary thrown code onto the tool-failure taxonomy, defaulting to failure. */
export function toolFailureCode(code: string): RuntimeErrorCode {
  if (code === "MCP_UNAVAILABLE") return "MCP_UNAVAILABLE";
  if (code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT") return "MCP_TIMEOUT";
  if (code === "TOOL_DENIED") return "TOOL_DENIED";
  return "TOOL_FAILED";
}

/**
 * Classify a failure thrown by the Model port onto the model taxonomy.
 *
 * The distinctions matter operationally: MODEL_RATE_LIMITED means wait,
 * MODEL_UNAVAILABLE means the provider is down, MODEL_INVALID_OUTPUT means the
 * model misbehaved, and REQUEST_TIMEOUT means OUR deadline expired. Collapsing
 * them — as this engine once did, relabelling everything MODEL_TIMEOUT — turns
 * an actionable cause into a generic one.
 */
const MODEL_FAILURE_CODES = ["MODEL_RATE_LIMITED", "MODEL_UNAVAILABLE", "MODEL_TIMEOUT", "MODEL_INVALID_OUTPUT"] as const;
type ModelFailureCode = (typeof MODEL_FAILURE_CODES)[number] | "REQUEST_TIMEOUT";

export function modelFailureCode(error: unknown): ModelFailureCode {
  if (error instanceof ZodError || error instanceof SyntaxError) return "MODEL_INVALID_OUTPUT";
  const code = errorCode(error);
  if (code === "REQUEST_TIMEOUT") return "REQUEST_TIMEOUT";
  if ((MODEL_FAILURE_CODES as readonly string[]).includes(code)) return code as ModelFailureCode;
  // an unrecognised failure is the provider's, not the deadline's
  return "MODEL_UNAVAILABLE";
}

/**
 * Which model failures earn the run's SINGLE retry. REQUEST_TIMEOUT never does:
 * the deadline is the caller's budget, and retrying against an expired budget
 * only delays the honest answer.
 */
export function isRetryableModelFailure(code: ModelFailureCode): boolean {
  return code !== "REQUEST_TIMEOUT";
}

export function safeModelMessage(code: string): string {
  if (code === "MODEL_RATE_LIMITED") return "The model provider rate-limited the request";
  if (code === "MODEL_INVALID_OUTPUT") return "The model returned invalid structured output";
  if (code === "MODEL_TIMEOUT") return "The model did not respond in time";
  if (code === "REQUEST_TIMEOUT") return "Specialist deadline exhausted";
  if (code === "CANCELLED") return "Specialist execution was cancelled";
  return "The model provider was unavailable";
}

/** Caller-facing text for a tool failure. Deliberately says nothing about policy. */
export function safeToolMessage(code: string): string {
  if (code === "TOOL_DENIED") return "A required source was not authorized";
  if (code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT") return "A required source timed out";
  return "A required source failed";
}

export type { RuntimeError, RuntimeErrorCode };
