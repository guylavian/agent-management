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
