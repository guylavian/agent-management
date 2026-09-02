import {
  AgentTransportError,
  MAX_AGENT_REQUEST_BYTES,
  MAX_AGENT_RESPONSE_BYTES,
  agentExecutionResponseSchema,
  assertSerializedLimit,
  serializedBytes,
  type AgentExecutionRequest,
  type AgentExecutionResponse,
  type SpecialistTransport,
} from "@sre/agent-protocol";

/**
 * A scripted SpecialistTransport for tests and the mock evaluation track.
 *
 * It is a transport, not an engine: it enforces the same protocol size limits
 * and returns protocol-shaped responses without running an investigation. That
 * is what lets the orchestrator be tested end to end without importing
 * agent-engine, which it is forbidden to do.
 */
export class MockSpecialistTransport implements SpecialistTransport {
  readonly mode = "mock" as const;
  readonly calls: Array<{ agentId: string; request: AgentExecutionRequest }> = [];
  readonly #scripts = new Map<string, Array<AgentExecutionResponse | AgentTransportError>>();

  enqueue(agentId: string, result: AgentExecutionResponse | AgentTransportError): void {
    const queue = this.#scripts.get(agentId) ?? [];
    queue.push(result);
    this.#scripts.set(agentId, queue);
  }

  async execute(agentId: string, request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResponse> {
    if (signal.aborted) throw new AgentTransportError("AGENT_TIMEOUT", "Agent service timed out", false);
    assertSerializedLimit(request, MAX_AGENT_REQUEST_BYTES, "agent request");
    this.calls.push({ agentId, request: structuredClone(request) });
    const scripted = this.#scripts.get(agentId)?.shift();
    if (scripted instanceof AgentTransportError) throw scripted;
    const response = scripted ?? mockResponse(agentId, request);
    if (serializedBytes(response) > MAX_AGENT_RESPONSE_BYTES) throw new AgentTransportError("AGENT_RESPONSE_TOO_LARGE", "Agent response exceeds the size limit", false);
    return agentExecutionResponseSchema.parse(response);
  }
}

function mockResponse(agentId: string, request: AgentExecutionRequest): AgentExecutionResponse {
  const source = agentId === "active-directory" ? "ad" : agentId === "openshift" ? "os" : "net";
  const needsHandoff = agentId === "active-directory" && /network dependency/iu.test(request.question) ? ["network-observability"] : undefined;
  return {
    agentId,
    status: "complete",
    summary: `${agentId} completed the bounded investigation.`,
    evidence: [
      {
        id: `rag:${source}:${request.requestId}`,
        kind: "wiki",
        source: `${agentId}-wiki`,
        system: agentId,
        environment: request.environment,
        citation: `wiki://${agentId}/runbook`,
        status: "ok",
        requestId: request.requestId,
        agentId,
        rawExcerpt: `Approved ${agentId} runbook evidence.`,
        redaction: { applied: false },
      },
      {
        id: `tool:${source}:${request.requestId}`,
        kind: "telemetry",
        source: `${agentId}-live`,
        system: agentId,
        environment: request.environment,
        observedAt: new Date().toISOString(),
        citation: `tool://${agentId}/health`,
        status: "ok",
        requestId: request.requestId,
        agentId,
        payload: { state: "healthy" },
        redaction: { applied: false },
      },
    ],
    ...(needsHandoff ? { needsHandoff } : {}),
  };
}
