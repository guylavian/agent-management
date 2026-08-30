import type { AgentCatalog } from "@sre/config";
import { domainHandoffSchema, type DomainHandoff, type Evidence, type SpecialistResult } from "@sre/evidence";
import type { ExecutionContext } from "../types.ts";

export interface FollowupRejection { agentId: string; domain: string; reason: "invalid-domain" | "not-allowed" | "not-enabled" | "not-available" | "already-ran" | "unauthorized" | "budget-exhausted" }
export interface FollowupPlan { request?: { agentId: string; handoff: DomainHandoff }; rejections: FollowupRejection[] }

export function planFollowup(options: {
  results: SpecialistResult[];
  alreadyRun: string[];
  ctx: ExecutionContext;
  registry: AgentCatalog;
  entities: Record<string, string>;
  budgetUsed: boolean;
  maxAgentsPerRequest: number;
}): FollowupPlan {
  const rejections: FollowupRejection[] = [];
  /*
   * A discovered domain must clear the SAME gate as a Round-1 route: the
   * effective catalog for this environment. Round 2 used to consult a separate
   * hand-written manager allowlist, so the two rounds could disagree about who
   * was reachable — and only one of them was derived from Git desired state.
   */
  const enabledHere = new Set(options.registry.listEnabled(options.ctx.environment).map((entry) => entry.agentId));
  let request: FollowupPlan["request"];
  for (const result of options.results) {
    for (const domain of (result.needsDomain ?? []).slice(0, 1)) {
      const target = options.registry.resolve(domain);
      let reason: FollowupRejection["reason"] | undefined;
      if (target === undefined) reason = "invalid-domain";
      /*
       * Three different answers, because they send an operator to three
       * different places: a name that is not an Agent, an Agent this
       * environment has turned off, and an Agent that is enabled but whose pod
       * is not answering. Collapsing the last two would have someone editing a
       * deployment overlay to fix a crash-looping container.
       */
      else if (!enabledHere.has(domain)) reason = target.enabled ? "not-available" : "not-enabled";
      else if (!options.registry.mayRequestDomain(result.agentId, domain)) reason = "not-allowed";
      else if (options.alreadyRun.includes(domain)) reason = "already-ran";
      else if (options.registry.filterAuthorized([domain], options.ctx.identity.roles, options.ctx.environment).length === 0) reason = "unauthorized";
      else if (options.budgetUsed || request !== undefined || options.alreadyRun.length >= options.maxAgentsPerRequest) reason = "budget-exhausted";
      if (reason !== undefined) {
        rejections.push({ agentId: result.agentId, domain, reason });
        continue;
      }
      const handoff = buildDomainHandoff(options.ctx.request.question, result, options.entities);
      request = { agentId: domain, handoff };
    }
  }
  return { ...(request ? { request } : {}), rejections };
}

export function buildDomainHandoff(originalQuestion: string, result: SpecialistResult, entities: Record<string, string>): DomainHandoff {
  const facts = result.evidence.slice(0, 8).flatMap((item) => [
    { key: `${item.id}.status`, value: item.status },
    { key: `${item.id}.environment`, value: item.environment },
    ...(item.tool ? [{ key: `${item.id}.tool`, value: item.tool }] : []),
  ]);
  return domainHandoffSchema.parse({ originalQuestion, reasonCode: "specialist-needs-domain", entities: Object.entries(entities).map(([type, value]) => ({ type, value })), evidenceRefs: result.evidence.map((item) => item.id).slice(0, 16), sanitizedFacts: facts });
}

export function followupRejectionEvidence(rejections: FollowupRejection[], ctx: ExecutionContext): Evidence[] {
  return rejections.map((rejection, index) => ({ id: `round2:${index}:${rejection.domain}`, kind: "missing", source: rejection.domain, system: "round2", environment: ctx.environment, citation: `round2://${rejection.domain}`, status: rejection.reason === "unauthorized" ? "denied" : "missing", requestId: ctx.requestId, agentId: rejection.agentId }));
}
