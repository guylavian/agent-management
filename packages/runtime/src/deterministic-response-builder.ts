import { evidenceGaps, renderCitations, type SpecialistResult } from "@sre/evidence";
import type { AssistantResponse, ExecutionContext } from "./types.ts";

export function deterministicResponseBuilder(ctx: ExecutionContext, result: SpecialistResult): AssistantResponse {
  const gaps = evidenceGaps(result.evidence);
  const citations = renderCitations(result.evidence);
  const summary = result.summary ?? "No supported answer could be produced from the available evidence.";
  const sections = [summary];
  if (citations.length > 0) sections.push(`Sources:\n${citations.map((citation) => `- [${citation.evidenceId}] ${citation.label}`).join("\n")}`);
  if (gaps.length > 0) sections.push(`Evidence gaps:\n${gaps.map((gap) => `- ${gap.source}: ${gap.reason}`).join("\n")}`);
  return { requestId: ctx.requestId, answer: sections.join("\n\n"), citations, evidenceGaps: gaps, degraded: gaps.length > 0 || result.status !== "complete", metadata: { routedAgents: [result.agentId], tierLUsed: false } };
}
