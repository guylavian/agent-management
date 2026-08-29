import type { ReducedEvidence } from "./evidence-reduction.ts";
import type { ExecutionContext } from "../types.ts";

export function shouldEscalate(ctx: ExecutionContext, reduced: ReducedEvidence): boolean {
  return reduced.contributingAgents.length > 1
    || reduced.conflicts.length > 0
    || reduced.evidence.some((item) => ["missing", "failed", "stale", "denied"].includes(item.status))
    || ctx.intent === "diagnostic";
}
