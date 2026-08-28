import type { AuthorizationService, RequestIdentity, ToolCredentialExchanger } from "@sre/auth";
import type { ModelClient } from "@sre/llm";
import type { ToolHiveClient } from "./tools/index.ts";

/**
 * Everything one bounded specialist investigation needs to know.
 *
 * Deliberately narrower than the Manager's execution context: the engine is
 * generic, so it carries no routing decision, no intent classification and no
 * knowledge of which other agents exist. It receives a question, an identity,
 * a deadline and an optional assigned task, and it investigates within its own
 * configured domain.
 */
export interface SpecialistExecutionContext {
  request: {
    question: string;
    environment?: string;
    identity: RequestIdentity;
    conversation?: { resolvedEntities?: Record<string, string>; previousRequestId?: string };
  };
  identity: RequestIdentity;
  environment: string;
  requestId: string;
  deadline: number;
  signal?: AbortSignal;
  /** Manager-assigned focused task for this specialist, if any */
  task?: string;
}

export interface SpecialistEngineDependencies {
  authorization: AuthorizationService;
  model: ModelClient;
  toolhive: ToolHiveClient;
  credentialExchanger?: ToolCredentialExchanger;
}
