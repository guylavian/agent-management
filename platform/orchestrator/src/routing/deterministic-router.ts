import type { Stage1RoutingResult, RequestIntent } from "./schemas.ts";

/**
 * Generic, config-driven routing rule for one agent. The agent-specific
 * vocabulary lives in the Agent Service Registry, not in this file — onboarding
 * a new specialist is a config change, never a code change.
 */
export interface RoutingRule {
  agentId: string;
  exactTerms: string[];
  entityPatterns: string[];
  ambiguousTerms: string[];
}

// intent language is linguistic, not agent-specific, so it stays in code
const DIAGNOSTIC = /\b(?:why|slow|slowness|root cause|intermittent|diagnos(?:e|is|tic)|failure|failing|unhealthy|timeout|latency)\b/iu;
const DIAGNOSTIC_REASON_CODES = new Set(["diagnostic-language", "causal-question", "multi-domain-diagnosis"]);

export function classifyIntent(question: string, reasonCodes: string[] = []): RequestIntent {
  return DIAGNOSTIC.test(question) || reasonCodes.some((code) => DIAGNOSTIC_REASON_CODES.has(code)) ? "diagnostic" : "factual";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function phraseMatches(question: string, term: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "iu").test(question);
}

/** Generic entity extraction shared by session context; registry entityPatterns extend this. */
export function extractEntities(question: string): Record<string, string> {
  const hostname = question.match(/\b(?:DC|APP|OCP)-[A-Z0-9-]+\b/u)?.[0];
  return hostname === undefined ? {} : { hostname };
}

/**
 * Precision-biased Stage-1 routing. A rule matches only on an exact term or an
 * entity-pattern hit; overloaded/ambiguous terms never resolve on their own.
 * Resolves only when exactly one agent matches.
 */
export function deterministicRoute(question: string, rules: RoutingRule[]): Stage1RoutingResult {
  const entities = extractEntities(question);
  const matched: Array<{ agentId: string }> = [];
  for (const rule of rules) {
    const exactHit = rule.exactTerms.some((term) => phraseMatches(question, term));
    let patternHit = false;
    for (const pattern of rule.entityPatterns) {
      const found = safeMatch(question, pattern);
      if (found !== undefined) { patternHit = true; entities[`${rule.agentId}.entity`] = found; }
    }
    if (exactHit || patternHit) matched.push({ agentId: rule.agentId });
  }
  const candidates = [...new Set(matched.map((match) => match.agentId))];
  if (candidates.length === 1) {
    return { resolved: true, decision: { agents: candidates, reasonCode: "registry-lexicon" }, candidates, entities, intent: classifyIntent(question) };
  }
  return { resolved: false, candidates, entities, intent: classifyIntent(question) };
}

function safeMatch(question: string, pattern: string): string | undefined {
  try {
    return question.match(new RegExp(pattern, "iu"))?.[0];
  } catch {
    return undefined;
  }
}
