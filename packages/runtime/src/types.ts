import type { RequestIdentity } from "@sre/auth";
import type { Evidence, RuntimeError, SpecialistResult } from "@sre/evidence";
import type { RequestIntent } from "@sre/routing";

export type { RequestIntent } from "@sre/routing";

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

export type { ManagerDecision } from "@sre/routing";

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
