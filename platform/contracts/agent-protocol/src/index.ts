import { createHash } from "node:crypto";
import { domainHandoffSchema, specialistResultSchema } from "@sre/evidence";
import { z } from "zod";

export const AGENT_PROTOCOL_VERSION = "internal/v1" as const;
export const AGENT_EXECUTION_PATH = "/internal/v1/execute" as const;
export const MAX_AGENT_REQUEST_BYTES = 64 * 1024;
export const MAX_AGENT_RESPONSE_BYTES = 512 * 1024;

export const delegatedIdentityContextSchema = z.object({
  token: z.string().min(32),
  tokenType: z.literal("urn:ietf:params:oauth:token-type:jwt"),
  issuer: z.string().min(1),
  audience: z.string().min(1),
  subjectHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type DelegatedIdentityContext = z.infer<typeof delegatedIdentityContextSchema>;

export const agentExecutionRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  question: z.string().min(1).max(8_000),
  // focused investigation task assigned by the Manager to this specialist (optional)
  task: z.string().min(1).max(2_000).optional(),
  environment: z.string().min(1).max(128),
  identityContext: delegatedIdentityContextSchema,
  /**
   * The delegated human's own IdP access token, carried ONLY so the specialist
   * can present it as the RFC 8693 `subject_token`.
   *
   * It is not what proves who the human is — `identityContext` does that, and
   * is bound to one agent and one request. This exists because an identity
   * provider will not exchange an assertion it did not issue, and because the
   * exchange is what puts the human's `sub` on the tool credential.
   *
   * Its blast radius is bounded by the IdP, not by us: a specialist can only
   * exchange a token whose audience already names it, so which agents may act
   * for a user is the IdP's decision.
   */
  subjectToken: z.string().min(16).max(8_192).optional(),
  conversationContext: z.object({
    resolvedEntities: z.record(z.string(), z.string().max(512)).optional(),
  }).strict().optional(),
  handoff: domainHandoffSchema.optional(),
  deadline: z.iso.datetime({ offset: true }),
}).strict();
export type AgentExecutionRequest = z.infer<typeof agentExecutionRequestSchema>;

export const agentExecutionResponseSchema = specialistResultSchema;
export type AgentExecutionResponse = z.infer<typeof agentExecutionResponseSchema>;

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assertSerializedLimit(value: unknown, maximum: number, label: string): void {
  const actual = serializedBytes(value);
  if (actual > maximum) {
    throw Object.assign(new Error(`${label} exceeds the protocol size limit`), {
      code: label === "agent request" ? "AGENT_REQUEST_TOO_LARGE" : "AGENT_RESPONSE_TOO_LARGE",
      actualBytes: actual,
      maximumBytes: maximum,
    });
  }
}

export function hashDelegatedSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}

/**
 * The Manager→Specialist transport boundary.
 *
 * The orchestrator depends on this interface and on nothing else about how a
 * specialist is reached. Implementations (HTTP, in-process) are constructed by
 * the composition root, which is the only layer permitted to see both sides.
 * That is what keeps `orchestrator ✕→ agent-engine` true even when a single
 * process runs both.
 */
export interface SpecialistTransport {
  readonly mode: "mock" | "real";
  execute(agentId: string, request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResponse>;
}

export type AgentTransportErrorCode =
  | "AGENT_UNAVAILABLE"
  | "AGENT_TIMEOUT"
  | "AGENT_UNAUTHORIZED"
  | "AGENT_EXECUTION_FAILED"
  | "AGENT_INVALID_RESPONSE"
  | "AGENT_RESPONSE_TOO_LARGE";

/** Transport-level failure. Carries a protocol error code, never a provider message. */
export class AgentTransportError extends Error {
  readonly code: AgentTransportErrorCode;
  readonly retryable: boolean;
  constructor(code: AgentTransportErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "AgentTransportError";
    this.code = code;
    this.retryable = retryable;
  }
}
