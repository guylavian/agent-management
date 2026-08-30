import type { Evidence, SpecialistResult } from "@sre/evidence";
import { evidenceGaps, renderCitations } from "./citations.ts";
import type { AssistantResponse, ExecutionContext } from "../types.ts";

/**
 * A missing summary is not a missing cause. When a specialist ends without one
 * its errors say exactly why, so the user reads the actual failure — rate
 * limit, invalid output, timeout — instead of the generic sentence this used
 * to emit for every one of them.
 */
function causeSummary(result: SpecialistResult): string {
  const error = result.errors?.[0];
  if (error === undefined) return "No supported answer could be produced from the available evidence.";
  return `The investigation could not be completed: ${error.message} (${error.code}).`;
}

export function deterministicResponseBuilder(ctx: ExecutionContext, result: SpecialistResult): AssistantResponse {
  const gaps = evidenceGaps(result.evidence);
  const citations = renderCitations(result.evidence);
  const summary = result.summary ?? causeSummary(result);
  const sections = [summary];
  if (citations.length > 0) sections.push(`Sources:\n${citations.map((citation) => `- [${citation.evidenceId}] ${citation.label}`).join("\n")}`);
  const errorGaps = (result.errors ?? []).map((error) => ({ source: result.agentId, reason: error.code }));
  const allGaps = [...gaps, ...errorGaps.filter((gap) => !gaps.some((existing) => existing.reason === gap.reason))];
  if (allGaps.length > 0) sections.push(`Evidence gaps:\n${allGaps.map((gap) => `- ${gap.source}: ${gap.reason}`).join("\n")}`);
  return { requestId: ctx.requestId, answer: sections.join("\n\n"), citations, evidenceGaps: allGaps, degraded: allGaps.length > 0 || result.status !== "complete", metadata: { routedAgents: [result.agentId], tierLUsed: false } };
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
