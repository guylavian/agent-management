import type { ToolSchema } from "@sre/llm";
import { z } from "zod";

/**
 * The one structured action a specialist may take per model turn.
 *
 * Native tool-calling models express this through `tool_calls`; deterministic
 * mocks and models without native support may return the same envelope as
 * content. Both paths converge here so the runtime validates exactly one shape.
 */
const specialistActionSchema = z
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
export type SpecialistAction = z.infer<typeof specialistActionSchema>;

const CONTROL_TOOL_NAMES = ["answer", "need_domain", "insufficient_evidence"] as const;

// virtual control tools: the model calls these to finish; they never execute through ToolHive
export const CONTROL_TOOLS: ToolSchema[] = [
  { name: "answer", description: "Provide the final answer once collected evidence is sufficient.", inputSchema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } } } } },
  { name: "need_domain", description: "Request one additional domain when another specialist is genuinely required.", inputSchema: { type: "object", additionalProperties: false, required: ["needsDomain", "reason"], properties: { needsDomain: { type: "string" }, reason: { type: "string" } } } },
  { name: "insufficient_evidence", description: "Stop when the remaining question cannot be proven from available tools.", inputSchema: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" } } } },
];

export function isControlTool(name: string): boolean {
  return (CONTROL_TOOL_NAMES as readonly string[]).includes(name);
}

/** deterministic mocks may return a SpecialistAction envelope as content instead of native tool_calls */
export function parseEnvelope(content: string | undefined): SpecialistAction | undefined {
  if (content === undefined) return undefined;
  try {
    return specialistActionSchema.parse(JSON.parse(content));
  } catch {
    return undefined;
  }
}

export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
