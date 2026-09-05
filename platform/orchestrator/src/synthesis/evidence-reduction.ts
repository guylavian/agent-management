import type { Evidence, SpecialistResult } from "@sre/evidence";

export interface ReducedEvidence {
  evidence: Evidence[];
  contributingAgents: string[];
  conflicts: Array<{ left: string; right: string; reason: string }>;
}

export function reduceEvidence(results: SpecialistResult[]): ReducedEvidence {
  // first position is kept for citation stability, but a usable observation
  // replaces a failed one: after fan-out, one specialist's settled-first
  // failure must not shadow another's success for the same fact
  const byId = new Map<string, Evidence>();
  const order: string[] = [];
  const usable = (item: Evidence) => item.status === "ok" || item.status === "empty";
  for (const item of results.flatMap((result) => result.evidence)) {
    const existing = byId.get(item.id);
    if (existing === undefined) { byId.set(item.id, item); order.push(item.id); continue; }
    if (usable(existing) && !usable(item)) continue;
    byId.set(item.id, item);
  }
  const evidence = order.map((id) => byId.get(id) as Evidence);
  const conflicts: ReducedEvidence["conflicts"] = [];
  for (let leftIndex = 0; leftIndex < evidence.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < evidence.length; rightIndex += 1) {
      const left = evidence[leftIndex];
      const right = evidence[rightIndex];
      if (left === undefined || right === undefined || left.environment !== right.environment || left.system !== right.system) continue;
      const leftState = extractState(left.payload ?? left.rawExcerpt);
      const rightState = extractState(right.payload ?? right.rawExcerpt);
      if (leftState !== undefined && rightState !== undefined && leftState !== rightState) conflicts.push({ left: left.id, right: right.id, reason: "state-mismatch" });
    }
  }
  return { evidence, contributingAgents: [...new Set(results.filter((result) => result.evidence.some((item) => item.status === "ok" || item.status === "empty")).map((result) => result.agentId))], conflicts };
}

function extractState(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (/\b(unhealthy|failed|down)\b/iu.test(value)) return "unhealthy";
    if (/\b(healthy|running|up)\b/iu.test(value)) return "healthy";
  }
  if (value !== null && typeof value === "object" && "state" in value && typeof value.state === "string") return value.state.toLowerCase();
  return undefined;
}
