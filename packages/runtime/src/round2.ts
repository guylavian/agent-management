import type { AgentRegistry } from "@sre/agent-registry";
import { domainHandoffSchema, type DomainHandoff, type Evidence, type SpecialistResult } from "@sre/evidence";
import type { ExecutionContext } from "./types.ts";

export interface Round2Rejection { agentId: string; domain: string; reason: "invalid-domain" | "not-allowed" | "already-ran" | "unauthorized" | "budget-exhausted" }
export interface Round2Plan { request?: { agentId: string; handoff: DomainHandoff }; rejections: Round2Rejection[] }

export function planRound2(options: {
  results: SpecialistResult[];
  alreadyRun: string[];
  ctx: ExecutionContext;
  registry: AgentRegistry;
  entities: Record<string, string>;
  budgetUsed: boolean;
  maxAgentsPerRequest: number;
}): Round2Plan {
  const rejections: Round2Rejection[] = [];
  let request: Round2Plan["request"];
  for (const result of options.results) {
    for (const domain of (result.needsDomain ?? []).slice(0, 1)) {
      const target = options.registry.resolve(domain);
      let reason: Round2Rejection["reason"] | undefined;
      if (target === undefined) reason = "invalid-domain";
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

export function round2RejectionEvidence(rejections: Round2Rejection[], ctx: ExecutionContext): Evidence[] {
  return rejections.map((rejection, index) => ({ id: `round2:${index}:${rejection.domain}`, kind: "missing", source: rejection.domain, system: "round2", environment: ctx.environment, citation: `round2://${rejection.domain}`, status: rejection.reason === "unauthorized" ? "denied" : "missing", requestId: ctx.requestId, agentId: rejection.agentId }));
}
