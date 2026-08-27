export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  guidedJsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResponse {
  content?: string;
  toolCalls?: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface ModelClient {
  readonly mode: "mock" | "real";
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export class MockModelClient implements ModelClient {
  readonly mode = "mock" as const;
  readonly #script: ChatResponse[] = [];

  enqueue(...responses: ChatResponse[]): void {
    this.#script.push(...responses);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (request.signal?.aborted) throw request.signal.reason;
    const scripted = this.#script.shift();
    if (scripted !== undefined) return structured(scripted, request.guidedJsonSchema);
    const userContent = request.messages.find((message) => message.role === "user")?.content ?? "";
    let question = userContent.toLowerCase();
    if (request.guidedJsonSchema?.title === "ManagerDecision") {
      try {
        const managerInput = JSON.parse(userContent) as { question?: unknown };
        if (typeof managerInput.question === "string") question = managerInput.question.toLowerCase();
      } catch { /* TypeScript validation at the caller remains fail closed. */ }
    }
    if (request.guidedJsonSchema !== undefined) {
      if (request.guidedJsonSchema.title === "ClaimGrades") {
        return { content: JSON.stringify({ claims: [{ claim: "The answer is grounded in the supplied evidence.", supported: true, supportingEvidenceIds: [], reasonCode: "mock-judge-supported" }] }), usage: { promptTokens: 64, completionTokens: 20 } };
      }
      if (request.guidedJsonSchema.title === "SpecialistControl") {
        return {
          content: JSON.stringify({
            summary: question.includes("failure") || question.includes("timeout") ? "Live evidence could not be fully collected." : "The available evidence reports the requested system state.",
            ...(question.includes("app-prd") ? { followupRagQuery: "APP-PRD-114 runbook" } : {}),
            ...(question.includes("network dependency") ? { needsDomain: ["network-observability"] } : {}),
          }),
          usage: { promptTokens: 64, completionTokens: 24 },
        };
      }
      const agents = [
        ...(question.includes("openshift") || question.includes("pod") ? ["openshift"] : []),
        ...(question.includes("network") || question.includes("prometheus") || question.includes("slow") ? ["network-observability"] : []),
        ...(question.includes("active directory") || question.includes("domain controller") || question.includes("ad ") || question.includes("ad ") || question.includes("authentication") ? ["active-directory"] : []),
      ];
      const selected = [...new Set(agents)].slice(0, 2);
      const routes = selected.map((agent) => ({ agent, task: managerTask(agent) }));
      return { content: JSON.stringify({ routes, confidence: routes.length ? 0.92 : 0.3, abstain: routes.length === 0, alternates: routes.length === 0 ? ["active-directory", "network-observability"] : undefined, reasonCodes: question.includes("slow") ? ["diagnostic-language"] : ["semantic-match"] }), usage: { promptTokens: 32, completionTokens: 24 } };
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      const preferred = request.tools.find((tool) =>
        (question.includes("replication") && tool.name === "get_replication_status")
        || (question.includes("pod") && tool.name === "get_pod_status")
        || (question.includes("slow") && tool.name === "query_prometheus"),
      ) ?? request.tools[0];
      if (preferred !== undefined) {
        const mode = question.includes("timeout") ? "timeout" : question.includes("failure") ? "failure" : question.includes("empty") ? "empty" : "ok";
        // emit only properties the selected tool declares, so schema validation (which is now enforced) passes
        return { toolCalls: [{ id: "mock-call-1", name: preferred.name, arguments: argumentsForSchema(preferred.inputSchema, mode) }], usage: { promptTokens: 48, completionTokens: 16 } };
      }
    }
    return { content: "Mock model response grounded in the supplied evidence.", usage: { promptTokens: 32, completionTokens: 12 } };
  }
}

/** Distinct focused task per specialist for the mock Manager decision. */
function managerTask(agent: string): string {
  if (agent === "active-directory") return "Check AD, domain-controller and authentication-side causes.";
  if (agent === "openshift") return "Check OpenShift workloads, pods, routes and platform events.";
  if (agent === "network-observability") return "Check connectivity, latency, packet loss and network-path evidence.";
  return "Investigate within your domain and return cited evidence.";
}

/** Build valid arguments for exactly the properties a tool declares. */
function argumentsForSchema(inputSchema: Record<string, unknown>, mode: string): Record<string, unknown> {
  const properties = (inputSchema.properties as Record<string, { type?: string; enum?: unknown[] }> | undefined) ?? {};
  const sample: Record<string, string> = { sourceDc: "DC-TLV-01", targetDc: "DC-HFA-02", dc: "DC-TLV-01", namespace: "payments", pod: "payments-api-0", query: "latency", device: "core-sw-1", target: "10.0.0.1", pool: "web-pool", site: "TLV", interface: "eth0", route: "payments", deployment: "payments-api" };
  const args: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(properties)) {
    if (name === "mode") { args.mode = spec.enum === undefined || spec.enum.includes(mode) ? mode : spec.enum[0]; continue; }
    if (sample[name] !== undefined) args[name] = sample[name];
  }
  if ("mode" in properties && args.mode === undefined) args.mode = mode;
  return args;
}

export class RealOpenAiCompatibleClient implements ModelClient {
  readonly mode = "real" as const;
  readonly #baseUrl: string;
  readonly #apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.#baseUrl = baseUrl.replace(/\/$/u, "");
    this.#apiKey = apiKey;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: request.model,
      messages: request.messages.map(({ role, content, toolCallId }) => ({ role, content, ...(toolCallId ? { tool_call_id: toolCallId } : {}) })),
      ...(request.tools ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
      ...(request.guidedJsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "structured_output", schema: request.guidedJsonSchema, strict: true } } } : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    };
    const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`model request failed (${response.status})`);
    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = result.choices?.[0]?.message;
    if (message === undefined) throw new Error("model response has no choice");
    return {
      ...(message.content ? { content: message.content } : {}),
      ...(message.tool_calls ? { toolCalls: message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) as Record<string, unknown> })) } : {}),
      usage: { promptTokens: result.usage?.prompt_tokens ?? 0, completionTokens: result.usage?.completion_tokens ?? 0 },
    };
  }
}

function structured(response: ChatResponse, schema: Record<string, unknown> | undefined): ChatResponse {
  if (schema === undefined || response.content === undefined) return response;
  JSON.parse(response.content);
  return response;
}
