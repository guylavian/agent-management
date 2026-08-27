import { context, propagation } from "@opentelemetry/api";
import { readFile } from "node:fs/promises";
import {
  AGENT_EXECUTION_PATH,
  MAX_AGENT_REQUEST_BYTES,
  MAX_AGENT_RESPONSE_BYTES,
  agentExecutionResponseSchema,
  assertSerializedLimit,
  serializedBytes,
  type AgentExecutionRequest,
  type AgentExecutionResponse,
} from "@sre/agent-protocol";
import type { AgentRegistry } from "@sre/agent-registry";

export interface AgentClient {
  readonly mode: "mock" | "real";
  execute(agentId: string, request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResponse>;
}

export interface WorkloadTokenProvider {
  getToken(audience: string): Promise<string>;
}

/** Reads a short-lived projected ServiceAccount/OIDC token for every call so rotation is observed. */
export class ProjectedWorkloadTokenProvider implements WorkloadTokenProvider {
  readonly tokenFile: string;
  constructor(tokenFile: string) { this.tokenFile = tokenFile; }
  async getToken(_audience: string): Promise<string> {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (token.length < 32) throw new AgentTransportError("AGENT_UNAUTHORIZED", "Workload identity token is unavailable", false);
    return token;
  }
}

export class MockWorkloadTokenProvider implements WorkloadTokenProvider {
  async getToken(_audience: string): Promise<string> { return "mock-manager-workload-token-for-local-tests"; }
}

export type AgentTransportErrorCode =
  | "AGENT_UNAVAILABLE"
  | "AGENT_TIMEOUT"
  | "AGENT_UNAUTHORIZED"
  | "AGENT_EXECUTION_FAILED"
  | "AGENT_INVALID_RESPONSE"
  | "AGENT_RESPONSE_TOO_LARGE";

export class AgentTransportError extends Error {
  readonly code: AgentTransportErrorCode;
  readonly retryable: boolean;
  constructor(code: AgentTransportErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "AgentTransportError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class HttpAgentClient implements AgentClient {
  readonly mode = "real" as const;
  readonly registry: AgentRegistry;
  readonly tokens: WorkloadTokenProvider;
  readonly fetchImplementation: typeof fetch;
  constructor(
    registry: AgentRegistry,
    tokens: WorkloadTokenProvider,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.registry = registry;
    this.tokens = tokens;
    this.fetchImplementation = fetchImplementation;
  }

  async execute(agentId: string, request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResponse> {
    const entry = this.registry.resolve(agentId);
    if (entry === undefined || !entry.enabled) throw new AgentTransportError("AGENT_UNAVAILABLE", "Agent service is unavailable", false);
    assertSerializedLimit(request, MAX_AGENT_REQUEST_BYTES, "agent request");
    const deadlineMs = Date.parse(request.deadline) - Date.now();
    if (deadlineMs <= 0) throw new AgentTransportError("AGENT_TIMEOUT", "Agent request deadline expired", false);
    const timeoutSignal = AbortSignal.timeout(deadlineMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${await this.tokens.getToken(`sre-agent:${agentId}`)}`,
          "content-type": "application/json",
          "x-request-id": request.requestId,
        };
        propagation.inject(context.active(), headers);
        const response = await this.fetchImplementation(new URL(AGENT_EXECUTION_PATH, `${entry.endpoint}/`), {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: combined,
        });
        if (response.status === 401 || response.status === 403) throw new AgentTransportError("AGENT_UNAUTHORIZED", "Agent service denied the request", false);
        if (response.status === 500) throw new AgentTransportError("AGENT_EXECUTION_FAILED", "Agent service failed internally", false);
        if ([502, 503, 504].includes(response.status)) {
          // a specialist's own 502 carries AGENT_RESPONSE_TOO_LARGE — terminal, not a transport blip
          const body = await response.text().catch(() => "");
          if (body.includes("AGENT_RESPONSE_TOO_LARGE")) throw new AgentTransportError("AGENT_RESPONSE_TOO_LARGE", "Agent response exceeds the size limit", false);
          if (attempt === 0) continue;
          throw new AgentTransportError("AGENT_UNAVAILABLE", "Agent service is unavailable", true);
        }
        if (!response.ok) throw new AgentTransportError("AGENT_INVALID_RESPONSE", "Agent service returned an invalid status", false);
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > MAX_AGENT_RESPONSE_BYTES) throw new AgentTransportError("AGENT_RESPONSE_TOO_LARGE", "Agent response exceeds the size limit", false);
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_AGENT_RESPONSE_BYTES) throw new AgentTransportError("AGENT_RESPONSE_TOO_LARGE", "Agent response exceeds the size limit", false);
        return agentExecutionResponseSchema.parse(JSON.parse(text));
      } catch (error) {
        if (error instanceof AgentTransportError) throw error;
        lastError = error;
        if (combined.aborted) throw new AgentTransportError("AGENT_TIMEOUT", "Agent service timed out", false);
        if (attempt === 0) continue;
      }
    }
    void lastError;
    throw new AgentTransportError("AGENT_UNAVAILABLE", "Agent service is unavailable", true);
  }
}

export class MockAgentClient implements AgentClient {
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
  const needsDomain = agentId === "active-directory" && /network dependency/iu.test(request.question) ? ["network-observability"] : undefined;
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
        id: `mcp:${source}:${request.requestId}`,
        kind: "telemetry",
        source: `${agentId}-live`,
        system: agentId,
        environment: request.environment,
        observedAt: new Date().toISOString(),
        citation: `mcp://${agentId}/health`,
        status: "ok",
        requestId: request.requestId,
        agentId,
        payload: { state: "healthy" },
        redaction: { applied: false },
      },
    ],
    ...(needsDomain ? { needsDomain } : {}),
  };
}
