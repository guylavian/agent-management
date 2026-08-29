import type { RequestIdentity } from "@sre/auth";
import type { Evidence, RuntimeError, SpecialistResult } from "@sre/evidence";
import type { RequestIntent } from "./routing/index.ts";

export type { RequestIntent } from "./routing/index.ts";

export interface UserRequest {
  question: string;
  environment?: string;
  identity: RequestIdentity;
  conversation?: { resolvedEntities?: Record<string, string>; previousRequestId?: string };
}

export interface ExecutionContext {
  request: UserRequest;
  identity: RequestIdentity;
  environment: string;
  intent: RequestIntent;
  requestId: string;
  deadline: number;
  signal?: AbortSignal;
  /** Manager-assigned focused task for this specialist, if any */
  task?: string;
}

export type { ManagerDecision } from "./routing/index.ts";

export interface AssistantResponse {
  requestId: string;
  answer: string;
  citations: Array<{ evidenceId: string; label: string }>;
  evidenceGaps: Array<{ source: string; reason: string }>;
  degraded: boolean;
  metadata: { routedAgents: string[]; tierLUsed: boolean };
  error?: RuntimeError;
}

export interface ExecutionRecord {
  requestId: string;
  routedAgents: string[];
  toolCalls: string[];
  modelCalls: number;
  specialistResults: SpecialistResult[];
  evidence: Evidence[];
  errors: RuntimeError[];
  latencyMs: number;
  tierLUsed: boolean;
}

/**
 * What the orchestrator knows and nobody downstream can reconstruct.
 *
 * The run record is assembled in the runtime host from the specialist results,
 * but three things never appear in those results: the question as the model
 * saw it, the task each specialist was given, and — most importantly — the
 * agents the Manager chose that were then REFUSED. A refused route leaves no
 * SpecialistResult behind, so without this it is invisible, and "the Manager
 * picked an agent you may not use" reads identically to "the Manager never
 * picked it". Those are very different answers to an auditor.
 */
export interface RoutingTrace {
  /** the question after redaction — the same string the Manager was given */
  question: string;
  /** every agent offered to the Manager: enabled ∩ allowlisted */
  offered: string[];
  /** what the Manager asked for, before the runtime had its say */
  selected: Array<{ agent: string; task: string; rationale?: string }>;
  /** selections the runtime refused, and why */
  refused: Array<{ agent: string; reason: string }>;
  /** the Manager declined to choose and the runtime fanned out to alternates */
  abstained: boolean;
  /** the one bounded Round 2 hop, if a specialist handed off to another domain */
  followup?: { agent: string; reason: string };
}
