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

/** Caller-facing text for a tool failure. Deliberately says nothing about policy. */
export function safeToolMessage(code: string): string {
  if (code === "TOOL_DENIED") return "A required source was not authorized";
  if (code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT") return "A required source timed out";
  return "A required source failed";
}

export type { RuntimeError, RuntimeErrorCode };
