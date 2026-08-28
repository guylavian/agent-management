import type { AgentCatalog } from "@sre/config";
import { domainHandoffSchema, type DomainHandoff, type Evidence, type SpecialistResult } from "@sre/evidence";
import type { ExecutionContext } from "../types.ts";

export interface FollowupRejection { agentId: string; domain: string; reason: "invalid-domain" | "not-allowed" | "not-in-manager-allowlist" | "already-ran" | "unauthorized" | "budget-exhausted" }
export interface FollowupPlan { request?: { agentId: string; handoff: DomainHandoff }; rejections: FollowupRejection[] }

export function planFollowup(options: {
  results: SpecialistResult[];
  alreadyRun: string[];
  ctx: ExecutionContext;
  registry: AgentCatalog;
  entities: Record<string, string>;
  budgetUsed: boolean;
  maxAgentsPerRequest: number;
  /** manager.spec.agents.allowed — a discovered domain outside it is never selectable */
  allowedManagerAgents: string[];
}): FollowupPlan {
  const rejections: FollowupRejection[] = [];
  const managerAllowlist = new Set(options.allowedManagerAgents);
  let request: FollowupPlan["request"];
  for (const result of options.results) {
    for (const domain of (result.needsDomain ?? []).slice(0, 1)) {
      const target = options.registry.resolve(domain);
      let reason: FollowupRejection["reason"] | undefined;
      if (target === undefined) reason = "invalid-domain";
      else if (!managerAllowlist.has(domain)) reason = "not-in-manager-allowlist";
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
