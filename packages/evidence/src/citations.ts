import type { Evidence } from "./evidence.ts";

export function renderCitations(evidence: Evidence[]): Array<{ evidenceId: string; label: string }> {
  return evidence.filter((item) => item.status !== "missing").map((item) => ({ evidenceId: item.id, label: item.citation }));
}

export function evidenceGaps(evidence: Evidence[]): Array<{ source: string; reason: string }> {
  return evidence
    .filter((item) => item.status !== "ok")
    .map((item) => ({ source: item.source, reason: item.status }));
}
