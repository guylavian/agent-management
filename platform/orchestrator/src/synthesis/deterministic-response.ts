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

/**
 * An answer the engine reports as UNGROUNDED cited no usable evidence, so the
 * evidence it happens to have collected is not support for what it said.
 * Presenting that list under "Sources" is the misleading part, so an ungrounded
 * result gets no Sources section — the gap says why.
 */
function isUngrounded(result: SpecialistResult): boolean {
  return result.status === "complete" && result.grounding?.grounded === false;
}

const UNGROUNDED_GAP = { source: "synthesis", reason: "UNGROUNDED_ANSWER" };

export function deterministicResponseBuilder(ctx: ExecutionContext, result: SpecialistResult, extraEvidence: Evidence[] = []): AssistantResponse {
  const evidence = [...result.evidence, ...extraEvidence];
  const gaps = evidenceGaps(evidence);
  const ungrounded = isUngrounded(result);
  const citations = ungrounded ? [] : renderCitations(evidence);
  const summary = result.summary ?? causeSummary(result);
  const sections = [summary];
  if (citations.length > 0) sections.push(`Sources:\n${citations.map((citation) => `- [${citation.evidenceId}] ${citation.label}`).join("\n")}`);
  const errorGaps = (result.errors ?? []).map((error) => ({ source: result.agentId, reason: error.code }));
  const groundingGaps = ungrounded ? [UNGROUNDED_GAP] : [];
  const allGaps = [...gaps, ...errorGaps.filter((gap) => !gaps.some((existing) => existing.reason === gap.reason)), ...groundingGaps];
  if (allGaps.length > 0) sections.push(`Evidence gaps:\n${allGaps.map((gap) => `- ${gap.source}: ${gap.reason}`).join("\n")}`);
  const isDegraded = allGaps.length > 0 || result.status !== "complete";
  return { requestId: ctx.requestId, answer: sections.join("\n\n"), citations, evidenceGaps: allGaps, degraded: isDegraded, metadata: { routedAgents: [result.agentId], tierLUsed: false } };
}

/**
 * Deterministic response when several specialists contributed. It preserves
 * EVERY successful specialist's summary and evidence — no new factual prose is
 * generated, and no contributor is dropped in favour of only the first.
 *
 * `reason` is supplied only when Tier-L synthesis was expected and could not
 * run; a plain multi-specialist answer passes none and is therefore not
 * labelled as a synthesis failure it did not suffer.
 */
export function deterministicMultiSpecialistResponse(ctx: ExecutionContext, results: SpecialistResult[], reason?: string, extraEvidence: Evidence[] = []): AssistantResponse {
  const allEvidence: Evidence[] = [...results.flatMap((result) => result.evidence), ...extraEvidence];
  const grounded = results.filter((result) => !isUngrounded(result));
  // sources come only from results whose answers are actually supported
  const citations = renderCitations(grounded.flatMap((result) => result.evidence).concat(extraEvidence));
  const gaps = evidenceGaps(allEvidence);
  const opening = reason === undefined
    ? "Findings from each domain are shown directly."
    : "Live synthesis was unavailable; the per-domain findings are shown directly.";
  const sections = [opening];
  for (const result of results) {
    const title = result.agentId;
    const body = result.summary ?? (result.status === "failed" ? "No evidence could be collected." : "No summary was produced.");
    sections.push(`${title}:\n${body}`);
  }
  if (citations.length > 0) sections.push(`Sources:\n${citations.map((citation) => `- [${citation.evidenceId}] ${citation.label}`).join("\n")}`);
  const ungroundedGaps = results.filter(isUngrounded).map((result) => ({ source: result.agentId, reason: UNGROUNDED_GAP.reason }));
  const allGaps = [...gaps, ...ungroundedGaps, ...(reason === undefined ? [] : [{ source: "tier-l", reason }])];
  if (allGaps.length > 0) sections.push(`Evidence gaps:\n${allGaps.map((gap) => `- ${gap.source}: ${gap.reason}`).join("\n")}`);
  return {
    requestId: ctx.requestId,
    answer: sections.join("\n\n"),
    citations,
    evidenceGaps: allGaps,
    degraded: allGaps.length > 0 || results.some((result) => result.status !== "complete"),
    metadata: { routedAgents: results.map((result) => result.agentId), tierLUsed: false },
  };
}
