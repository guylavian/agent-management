import { z } from "zod";

export const evidenceStatusSchema = z.enum(["ok", "empty", "missing", "failed", "stale", "denied"]);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const evidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["wiki", "telemetry", "config", "missing"]),
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
}).strict();

export type Evidence = z.infer<typeof evidenceSchema>;

export const runtimeErrorCodeSchema = z.enum([
  "AUTHN_FAILED", "AUTHZ_DENIED", "ROUTE_AMBIGUOUS", "ROUTE_INVALID",
  // Why routing failed, rather than only that it did. ROUTE_INVALID used to
  // absorb all five: a malformed model response, a hallucinated agent, an agent
  // this environment does not run, and the provider being down or throttling
  // were one code, so the console could not tell a prompt regression from an
  // outage. None of these names a policy internal — agent ids are on the
  // console's front page.
  "MANAGER_OUTPUT_INVALID", "UNKNOWN_AGENT", "DISABLED_AGENT",
  "MODEL_UNAVAILABLE", "MODEL_RATE_LIMITED",
  "MODEL_TIMEOUT", "MODEL_INVALID_OUTPUT", "RAG_UNAVAILABLE", "RAG_DENIED",
  "MCP_UNAVAILABLE", "MCP_TIMEOUT", "MCP_INVALID_CALL", "TOOL_DENIED",
  "TOOL_FAILED", "EVIDENCE_STALE", "REDACTION_FAILURE", "REQUEST_TIMEOUT",
  "AGENT_UNAVAILABLE", "AGENT_TIMEOUT", "AGENT_UNAUTHORIZED", "AGENT_EXECUTION_FAILED",
  "AGENT_INVALID_RESPONSE", "AGENT_RESPONSE_TOO_LARGE", "AGENT_REQUEST_TOO_LARGE",
]);
export type RuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
}

export const specialistResultSchema = z.object({
  agentId: z.string().min(1),
  status: z.enum(["complete", "partial", "failed"]),
  evidence: z.array(evidenceSchema),
  needsDomain: z.array(z.string().min(1)).max(1).optional(),
  summary: z.string().max(4000).optional(),
  errors: z.array(z.object({
    code: runtimeErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
  }).strict()).optional(),
}).strict();
export type SpecialistResult = z.infer<typeof specialistResultSchema>;

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export const domainHandoffSchema = z.object({
  originalQuestion: z.string().min(1),
  reasonCode: z.string().min(1),
  entities: z.array(z.object({ type: z.string(), value: z.string() }).strict()),
  evidenceRefs: z.array(z.string()),
  sanitizedFacts: z.array(z.object({ key: z.string(), value: scalarSchema }).strict()),
}).strict();
export type DomainHandoff = z.infer<typeof domainHandoffSchema>;
