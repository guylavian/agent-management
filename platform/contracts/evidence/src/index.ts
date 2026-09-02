import { z } from "zod";
import {
  engineErrorCodeSchema,
  evidenceSchema,
  evidenceStatusSchema,
  handoffSchema,
  resultSchemaWith,
} from "@sre/engine-contract";
import type { Evidence, EvidenceStatus, HandoffRequest } from "@sre/engine-contract";

/**
 * This platform's contract = the ENGINE's neutral base + the platform's own
 * vocabulary layered on top.
 *
 * The base (@sre/engine-contract) carries everything a generic agent engine
 * needs: evidence with an OPEN kind taxonomy, the engine's own error codes,
 * the result shape as a factory over the code vocabulary, and a neutral
 * handoff. This file adds what only THIS platform knows — routing, Manager,
 * RAG and transport error codes — and keeps the platform's historical names
 * (`SpecialistResult`, `DomainHandoff`) as aliases so its own components keep
 * their language. The SRE evidence-kind narrowing lives where the kinds are
 * authored: the Agent catalog schema (contracts/agent-schema), not here.
 */

export { evidenceSchema, evidenceStatusSchema };
export type { Evidence, EvidenceStatus };

export const runtimeErrorCodeSchema = z.enum([
  // ── the engine's own codes; must remain a superset of engineErrorCodeSchema
  //    (pinned by tests/contract-composition.test.ts) ────────────────────────
  "AUTHN_FAILED", "AUTHZ_DENIED",
  "MODEL_UNAVAILABLE", "MODEL_RATE_LIMITED", "MODEL_TIMEOUT", "MODEL_INVALID_OUTPUT",
  "TOOL_UNAVAILABLE", "TOOL_TIMEOUT", "TOOL_INVALID_CALL", "TOOL_DENIED", "TOOL_FAILED",
  "EVIDENCE_STALE", "REDACTION_FAILURE", "REQUEST_TIMEOUT", "CANCELLED", "INVALID_BUDGET",
  // ── platform plane: routing and Manager ────────────────────────────────────
  // Why routing failed, rather than only that it did. ROUTE_INVALID used to
  // absorb all five: a malformed model response, a hallucinated agent, an agent
  // this environment does not run, and the provider being down or throttling
  // were one code, so the console could not tell a prompt regression from an
  // outage. None of these names a policy internal — agent ids are on the
  // console's front page.
  "ROUTE_AMBIGUOUS", "ROUTE_INVALID", "MANAGER_OUTPUT_INVALID", "UNKNOWN_AGENT", "DISABLED_AGENT",
  // ── platform plane: knowledge retrieval ────────────────────────────────────
  "RAG_UNAVAILABLE", "RAG_DENIED",
  // ── platform plane: the MCP-branded tool codes this platform's adapters
  //    emitted before the engine's vocabulary went neutral; kept for stored
  //    results and dashboards, no longer emitted by the engine ───────────────
  "MCP_UNAVAILABLE", "MCP_TIMEOUT", "MCP_INVALID_CALL",
  // ── platform plane: the Orchestrator→Specialist transport ─────────────────
  "AGENT_UNAVAILABLE", "AGENT_TIMEOUT", "AGENT_UNAUTHORIZED", "AGENT_EXECUTION_FAILED",
  "AGENT_INVALID_RESPONSE", "AGENT_RESPONSE_TOO_LARGE", "AGENT_REQUEST_TOO_LARGE",
]);
export type RuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
}

/** The engine's result shape validated against this platform's wider code union. */
export const specialistResultSchema = resultSchemaWith(runtimeErrorCodeSchema);
export type SpecialistResult = z.infer<typeof specialistResultSchema>;

export const domainHandoffSchema = handoffSchema;
export type DomainHandoff = HandoffRequest;

export { engineErrorCodeSchema };
