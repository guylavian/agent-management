import type { Stage1RoutingResult, RequestIntent } from "./schemas.ts";

const RULES: Array<{ agent: string; reasonCode: string; patterns: RegExp[] }> = [
  { agent: "active-directory", reasonCode: "lexicon.ad", patterns: [/\bactive directory\b/iu, /\bdomain controllers?\b/iu, /\bkerberos\b/iu, /\bldap\b/iu, /\bad replication\b/iu, /\bDC-[A-Z0-9-]+\b/u] },
  { agent: "openshift", reasonCode: "lexicon.openshift", patterns: [/\bopenshift\b/iu, /\bcrashloopbackoff\b/iu, /\bocp\b/iu, /\bkubernetes pod\b/iu, /\bnamespace\s+[a-z0-9-]+\b/iu] },
  { agent: "network-observability", reasonCode: "lexicon.network-observability", patterns: [/\bpromql\b/iu, /\bprometheus\b/iu, /\bpacket loss\b/iu, /\bbgp\b/iu, /\binterface errors?\b/iu, /\bsplunk\b/iu, /\bnetwork latency\b/iu] },
];

const DIAGNOSTIC = /\b(?:why|slow|slowness|root cause|intermittent|diagnos(?:e|is|tic)|failure|failing|unhealthy|timeout|latency)\b/iu;
const DIAGNOSTIC_REASON_CODES = new Set(["diagnostic-language", "causal-question", "multi-domain-diagnosis"]);

export function classifyIntent(question: string, reasonCodes: string[] = []): RequestIntent {
  return DIAGNOSTIC.test(question) || reasonCodes.some((code) => DIAGNOSTIC_REASON_CODES.has(code)) ? "diagnostic" : "factual";
}

export function deterministicRoute(question: string, authorizedCandidates: string[]): Stage1RoutingResult {
  const allowed = new Set(authorizedCandidates);
  const matches = RULES.filter((rule) => allowed.has(rule.agent) && rule.patterns.some((pattern) => pattern.test(question)));
  const candidates = [...new Set(matches.map((match) => match.agent))];
  const hostname = question.match(/\b(?:DC|APP|OCP)-[A-Z0-9-]+\b/u)?.[0];
  const entities: Record<string, string> = hostname === undefined ? {} : { hostname };
  if (candidates.length === 1) {
    return { resolved: true, decision: { agents: candidates, reasonCode: matches[0]?.reasonCode ?? "lexicon" }, candidates, entities, intent: classifyIntent(question) };
  }
  return { resolved: false, candidates, entities, intent: classifyIntent(question) };
}
