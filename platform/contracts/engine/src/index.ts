import { z } from "zod";

/**
 * The engine's own contract — the vocabulary a GENERIC agent engine needs and
 * nothing more.
 *
 * Nothing here names a domain, a product, a protocol or a platform. A host
 * that runs the engine for SRE, for support, for anything else, extends this
 * contract at its own boundary (see @sre/evidence for this platform's
 * extension): it may widen the error-code vocabulary through
 * `resultSchemaWith`, narrow the open evidence taxonomy, and alias the type
 * names into its own language. It cannot change what the engine itself emits.
 */

export const evidenceStatusSchema = z.enum(["ok", "empty", "missing", "failed", "stale", "denied"]);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

/**
 * `kind` is an OPEN taxonomy: the engine copies it from the approved catalog
 * and never branches on it, so a host's own kinds flow through untouched. The
 * engine mints exactly one kind itself — "missing", for calls that produced no
 * observation.
 */
export const evidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  source: z.string().min(1),
  system: z.string().min(1),
  environment: z.string().min(1),
  observedAt: z.string().optional(),
  sourceModifiedAt: z.string().optional(),
  tool: z.string().optional(),
  query: z.string().optional(),
  payload: z.unknown().optional(),
  rawExcerpt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  citation: z.string().min(1),
  status: evidenceStatusSchema,
  requestId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  redaction: z.object({ applied: z.boolean(), categories: z.array(z.string()).optional() }).strict().optional(),
  truncated: z.boolean().optional(),
  originalSizeBytes: z.number().int().nonnegative().optional(),
  /** sha256 (truncated hex) of the canonical payload, minted by the engine for usable evidence */
  payloadDigest: z.string().optional(),
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;

/** Every code the ENGINE itself can emit. A host's transports and routers extend, never replace. */
export const engineErrorCodeSchema = z.enum([
  "AUTHN_FAILED", "AUTHZ_DENIED",
  "MODEL_UNAVAILABLE", "MODEL_RATE_LIMITED", "MODEL_TIMEOUT", "MODEL_INVALID_OUTPUT",
  "TOOL_UNAVAILABLE", "TOOL_TIMEOUT", "TOOL_INVALID_CALL", "TOOL_DENIED", "TOOL_FAILED",
  "EVIDENCE_STALE", "REDACTION_FAILURE", "REQUEST_TIMEOUT", "CANCELLED", "INVALID_BUDGET",
  // the last-resort boundary: something unexpected escaped every inner guard
  "AGENT_EXECUTION_FAILED",
]);
export type EngineErrorCode = z.infer<typeof engineErrorCodeSchema>;

export interface EngineError {
  code: EngineErrorCode;
  message: string;
  retryable: boolean;
}

/**
 * The result schema as a FACTORY over the error-code vocabulary, so the engine
 * validates against exactly its own codes while a host validates the same
 * shape against its wider union — one shape, two vocabularies, no dependency
 * cycle between the contracts.
 */
export function resultSchemaWith<Code extends z.ZodType<string>>(codeSchema: Code) {
  return z.object({
    agentId: z.string().min(1),
    status: z.enum(["complete", "partial", "failed"]),
    evidence: z.array(evidenceSchema),
    /** opaque handoff targets the host interprets; the engine cannot route, so it cannot know what they name */
    needsHandoff: z.array(z.string().min(1)).max(1).optional(),
    summary: z.string().max(4000).optional(),
    /** execution status and grounding are separate: "ran clean" is not "supported by cited usable evidence" */
    grounding: z.object({ grounded: z.boolean(), citedUsable: z.number().int().nonnegative(), usableEvidence: z.number().int().nonnegative() }).strict().optional(),
    errors: z.array(z.object({ code: codeSchema, message: z.string(), retryable: z.boolean() }).strict()).optional(),
  }).strict();
}

export const agentResultSchema = resultSchemaWith(engineErrorCodeSchema);
export type AgentResult = z.infer<typeof agentResultSchema>;

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/** A handoff REQUEST between runs: scalar facts only, schema-enforced, never instructions. */
export const handoffSchema = z.object({
  originalQuestion: z.string().min(1),
  reasonCode: z.string().min(1),
  entities: z.array(z.object({ type: z.string(), value: z.string() }).strict()),
  evidenceRefs: z.array(z.string()),
  sanitizedFacts: z.array(z.object({ key: z.string(), value: scalarSchema }).strict()),
}).strict();
export type HandoffRequest = z.infer<typeof handoffSchema>;
