import { z } from "zod";
import type { ModelToolSchema } from "../model/port.ts";

/**
 * The one structured action an Agent may take per model turn.
 *
 * Native tool-calling models express this through tool calls; deterministic
 * mocks and models without native support may return the same envelope as
 * content. Both paths converge here so the runtime validates exactly one shape,
 * and anything that does not match it is treated as invalid model output rather
 * than being interpreted generously.
 */
const agentActionSchema = z
  .object({
    action: z.enum(["tool_call", "answer", "needs_domain", "insufficient_evidence"]),
    // short operational fields only — never chain-of-thought
    purpose: z.string().max(500).optional(),
    tool: z.string().max(200).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    summary: z.string().max(4000).optional(),
    evidenceIds: z.array(z.string().max(200)).max(64).optional(),
    needsDomain: z.string().max(100).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type AgentAction = z.infer<typeof agentActionSchema>;

export const CONTROL_TOOL_NAMES = ["answer", "need_domain", "insufficient_evidence"] as const;

/**
 * Virtual control tools. The model calls one of these to finish; they terminate
 * the loop inside the engine and are never dispatched to a ToolProvider, so a
 * model cannot reach a backend by naming one.
 */
export const CONTROL_TOOLS: ModelToolSchema[] = [
  { name: "answer", description: "Provide the final answer once collected evidence is sufficient.", inputSchema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } } } } },
  { name: "need_domain", description: "Request one additional domain when another specialist is genuinely required.", inputSchema: { type: "object", additionalProperties: false, required: ["needsDomain", "reason"], properties: { needsDomain: { type: "string" }, reason: { type: "string" } } } },
  { name: "insufficient_evidence", description: "Stop when the remaining question cannot be proven from available tools.", inputSchema: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" } } } },
];

export function isControlTool(name: string): boolean {
  return (CONTROL_TOOL_NAMES as readonly string[]).includes(name);
}

/** Deterministic mocks may return an action envelope as content instead of native tool calls.
 *
 * Returns a discriminated result:
 * - undefined: content is not valid JSON or not an object (treat as plain text answer)
 * - {valid: true, ...AgentAction}: valid action envelope
 * - {valid: false, reason}: JSON object with an `action` key that fails schema validation
 */
export function parseEnvelope(
  content: string | undefined,
): { valid: true } & AgentAction | { valid: false; reason: string } | undefined {
  if (content === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Not valid JSON → treat as plain text answer
    return undefined;
  }
  // Not an object → treat as plain text answer
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  // Object with possible `action` key: validate against schema
  const result = agentActionSchema.safeParse(parsed);
  if (result.success) {
    return { valid: true, ...result.data };
  }
  // Invalid action: this is a model error, not a plain answer
  return { valid: false, reason: result.error.message };
}

export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
