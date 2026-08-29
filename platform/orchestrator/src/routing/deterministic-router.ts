import type { RequestIntent } from "./schemas.ts";

/**
 * What is left of routing once the Manager decides it.
 *
 * A `RoutingRule` used to live here — exact phrases, regexes and overloaded
 * words that code matched against the question to pick an agent. Nothing read
 * it any more once routing became semantic, and a struct describing how to
 * keyword-match agents is an invitation to start keyword-matching agents again.
 *
 * Neither function below chooses anyone. They describe the QUESTION, and the
 * Manager describes the ANSWER.
 */

// intent language is linguistic, not agent-specific, so it stays in code
const DIAGNOSTIC = /\b(?:why|slow|slowness|root cause|intermittent|diagnos(?:e|is|tic)|failure|failing|unhealthy|timeout|latency)\b/iu;
const DIAGNOSTIC_REASON_CODES = new Set(["diagnostic-language", "causal-question", "multi-domain-diagnosis"]);

export function classifyIntent(question: string, reasonCodes: string[] = []): RequestIntent {
  return DIAGNOSTIC.test(question) || reasonCodes.some((code) => DIAGNOSTIC_REASON_CODES.has(code)) ? "diagnostic" : "factual";
}

/**
 * Generic entity extraction, shared by session context and handed to the
 * Manager as trusted context.
 *
 * This is NOT agent selection: the pattern is a hostname shape the platform
 * uses everywhere, not a per-agent lexicon, and what it produces is a fact
 * about the question rather than a decision about who answers it.
 */
export function extractEntities(question: string): Record<string, string> {
  const hostname = question.match(/\b(?:DC|APP|OCP)-[A-Z0-9-]+\b/u)?.[0];
  return hostname === undefined ? {} : { hostname };
}
