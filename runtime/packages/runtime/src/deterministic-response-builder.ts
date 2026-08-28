import { evidenceGaps, renderCitations, type Evidence, type SpecialistResult } from "@sre/evidence";
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

/**
 * Deterministic degraded response when Tier-L synthesis is unavailable after
 * multiple specialists contributed. It preserves EVERY successful specialist's
 * summary and evidence — no new factual prose is generated, and no contributor
 * is dropped in favour of only the first.
 */
export function deterministicMultiSpecialistResponse(ctx: ExecutionContext, results: SpecialistResult[], reason: string): AssistantResponse {
  const allEvidence: Evidence[] = results.flatMap((result) => result.evidence);
  const citations = renderCitations(allEvidence);
  const gaps = evidenceGaps(allEvidence);
  const sections = ["Live synthesis was unavailable; the per-domain findings are shown directly."];
  for (const result of results) {
    const title = result.agentId;
    const body = result.summary ?? (result.status === "failed" ? "No evidence could be collected." : "No summary was produced.");
    sections.push(`${title}:\n${body}`);
  }
  if (citations.length > 0) sections.push(`Sources:\n${citations.map((citation) => `- [${citation.evidenceId}] ${citation.label}`).join("\n")}`);
  if (gaps.length > 0) sections.push(`Evidence gaps:\n${gaps.map((gap) => `- ${gap.source}: ${gap.reason}`).join("\n")}`);
  return {
    requestId: ctx.requestId,
    answer: sections.join("\n\n"),
    citations,
    evidenceGaps: [...gaps, { source: "tier-l", reason }],
    degraded: true,
    metadata: { routedAgents: results.map((result) => result.agentId), tierLUsed: false },
  };
}
