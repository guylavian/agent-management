import { AgentTransportError, type AgentClient } from "@sre/agent-client";
import {
  agentExecutionResponseSchema,
  assertSerializedLimit,
  MAX_AGENT_REQUEST_BYTES,
  MAX_AGENT_RESPONSE_BYTES,
  type AgentExecutionRequest,
  type AgentExecutionResponse,
} from "@sre/agent-protocol";
import type { AgentRegistry as AgentServiceRegistry } from "@sre/agent-registry";
import { MockDelegationAuthority, type AuthorizationService, type DelegatedIdentityVerifier } from "@sre/auth";
import type { AgentRegistry as ConfigAgentRegistry } from "@sre/config";
import { redactText } from "@sre/evidence";
import type { ModelClient } from "@sre/llm";
import type { ToolHiveClient } from "@sre/mcp";
import type { RagClient } from "@sre/rag";
import { classifyIntent } from "@sre/routing";
import type { RuntimeDependencies } from "./execute-request.ts";
import { runSpecialistInstance } from "./specialist-runner.ts";
import type { ExecutionContext } from "./types.ts";

export interface InProcessSpecialistDependencies {
  authorization: AuthorizationService;
  model: ModelClient;
  toolhive: ToolHiveClient;
  rag: RagClient;
}

/**
 * Runs the real specialist stack in the current process behind the distributed
 * AgentClient contract, enforcing the same admission semantics as the HTTP
 * specialist server: protocol size limits, delegated-identity verification,
 * deadline expiry and question redaction. Used by dev/local, the evaluation
 * harness and tests, where no TCP listener is available or wanted.
 */
export class InProcessAgentClient implements AgentClient {
  readonly mode = "mock" as const;
  readonly #registry: ConfigAgentRegistry;
  readonly #deps: InProcessSpecialistDependencies;
  readonly #verifier: DelegatedIdentityVerifier;

  constructor(registry: ConfigAgentRegistry, deps: InProcessSpecialistDependencies, verifier: DelegatedIdentityVerifier) {
    this.#registry = registry;
    this.#deps = deps;
    this.#verifier = verifier;
  }

  async execute(agentId: string, request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResponse> {
    assertSerializedLimit(request, MAX_AGENT_REQUEST_BYTES, "agent request");
    const specialist = this.#registry.getSpecialist(agentId);
    if (specialist === undefined) throw new AgentTransportError("AGENT_UNAVAILABLE", "Agent service is unavailable", false);
    let identity;
    try {
      identity = await this.#verifier.verify(request.identityContext, `sre-agent:${agentId}`, request.requestId);
    } catch {
      throw new AgentTransportError("AGENT_UNAUTHORIZED", "Agent service denied the request", false);
    }
    const deadline = Date.parse(request.deadline);
    if (deadline <= Date.now()) throw new AgentTransportError("AGENT_TIMEOUT", "Agent request deadline expired", false);
    const safeQuestion = redactText(request.question).value;
    const ctx: ExecutionContext = {
      request: {
        question: safeQuestion,
        environment: request.environment,
        identity,
        ...(request.conversationContext ? { conversation: request.conversationContext } : {}),
      },
      identity,
      environment: request.environment,
      intent: classifyIntent(safeQuestion),
      requestId: request.requestId,
      deadline,
      signal,
    };
    const result = await runSpecialistInstance(specialist, this.#registry.catalog, ctx, this.#deps, request.handoff);
    try {
      assertSerializedLimit(result, MAX_AGENT_RESPONSE_BYTES, "agent response");
    } catch {
      throw new AgentTransportError("AGENT_RESPONSE_TOO_LARGE", "Agent response exceeds the size limit", false);
    }
    return agentExecutionResponseSchema.parse(result);
  }
}

export interface InProcessRuntimeOptions {
  registry: ConfigAgentRegistry;
  serviceRegistry: AgentServiceRegistry;
  authorization: AuthorizationService;
  model: ModelClient;
  synthesisModel?: ModelClient;
  toolhive: ToolHiveClient;
  rag: RagClient;
  requestDeadlineMs?: number;
  defaultEnvironment?: string;
  onResults?: RuntimeDependencies["onResults"];
}

/** Full distributed RuntimeDependencies wired over the in-process client — one delegation authority signs and verifies. */
export function inProcessRuntimeDependencies(options: InProcessRuntimeOptions): RuntimeDependencies {
  const authority = new MockDelegationAuthority({
    issuer: "https://in-process.sre.local",
    secret: "in-process-delegation-secret-32-bytes-minimum",
  });
  return {
    manager: options.registry.manager,
    registry: options.serviceRegistry,
    agentClient: new InProcessAgentClient(
      options.registry,
      { authorization: options.authorization, model: options.model, toolhive: options.toolhive, rag: options.rag },
      authority,
    ),
    identityIssuer: authority,
    model: options.model,
    synthesisModel: options.synthesisModel ?? options.model,
    requestDeadlineMs: options.requestDeadlineMs ?? 5_000,
    defaultEnvironment: options.defaultEnvironment ?? "prod",
    ...(options.onResults ? { onResults: options.onResults } : {}),
  };
}
