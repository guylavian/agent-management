export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  /** on an assistant message: the native tool calls the model made (replayed to the provider) */
  toolCalls?: ToolCall[];
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
      if (request.guidedJsonSchema.title === "SpecialistAction") {
        const tools = (extractJsonBlock(request.messages, "AVAILABLE_TOOLS") as Array<{ name: string; parameters?: Record<string, string> }> | undefined) ?? [];
        const evidenceItems = (extractJsonBlock(request.messages, "ACCUMULATED_EVIDENCE") as Array<{ id?: string; status?: string }> | undefined) ?? [];
        const okEvidence = evidenceItems.filter((item) => item && item.status === "ok");
        const mode = question.includes("timeout") ? "timeout" : question.includes("failure") ? "failure" : question.includes("empty") ? "empty" : "ok";
        if (okEvidence.length > 0) {
          if (question.includes("network dependency")) {
            return { content: JSON.stringify({ action: "needs_domain", needsDomain: "network-observability", reason: "Live network evidence is required." }), usage: { promptTokens: 48, completionTokens: 16 } };
          }
          const evidenceIds = okEvidence.map((item) => item.id).filter((id): id is string => typeof id === "string").slice(0, 8);
          return { content: JSON.stringify({ action: "answer", summary: "The available evidence reports the requested system state (documented and/or live, as cited).", evidenceIds }), usage: { promptTokens: 48, completionTokens: 20 } };
        }
        if (tools.length > 0) {
          const preferred = tools.find((tool) =>
            (question.includes("replication") && tool.name === "get_replication_status")
            || (question.includes("pod") && tool.name === "get_pod_status")
            || ((question.includes("slow") || question.includes("prometheus")) && tool.name === "query_prometheus")
            || ((question.includes("wiki") || question.includes("documentation") || question.includes("documented") || question.includes("runbook") || question.includes("procedure")) && tool.name === "wiki_search"),
          ) ?? tools[0];
          if (preferred !== undefined) {
            const pseudoSchema = { properties: Object.fromEntries(Object.entries(preferred.parameters ?? {}).map(([key, type]) => [key, { type }])) };
            return { content: JSON.stringify({ action: "tool_call", purpose: "Collect the smallest useful evidence for the task.", tool: preferred.name, arguments: argumentsForSchema(pseudoSchema, mode) }), usage: { promptTokens: 48, completionTokens: 20 } };
          }
        }
        return { content: JSON.stringify({ action: "insufficient_evidence", reason: "No tools are available to investigate the request." }), usage: { promptTokens: 32, completionTokens: 12 } };
      }
      const agents = [
        ...(question.includes("openshift") || question.includes("pod") ? ["openshift"] : []),
        ...(question.includes("network") || question.includes("prometheus") || question.includes("slow") ? ["network-observability"] : []),
        ...(question.includes("active directory") || question.includes("domain controller") || question.includes("ad ") || question.includes("authentication") ? ["active-directory"] : []),
      ];
      const selected = [...new Set(agents)].slice(0, 2);
      const routes = selected.map((agent) => ({ agent, task: managerTask(agent) }));
      return { content: JSON.stringify({ routes, confidence: routes.length ? 0.92 : 0.3, abstain: routes.length === 0, alternates: routes.length === 0 ? ["active-directory", "network-observability"] : undefined, reasonCodes: question.includes("slow") ? ["diagnostic-language"] : ["semantic-match"] }), usage: { promptTokens: 32, completionTokens: 24 } };
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      // native tool-calling convergence: collect once, then answer via the control tool
      const controlNames = new Set(["answer", "need_domain", "insufficient_evidence"]);
      const realTools = request.tools.filter((tool) => !controlNames.has(tool.name));
      const toolResults = request.messages.filter((message) => message.role === "tool");
      const mode = question.includes("timeout") ? "timeout" : question.includes("failure") ? "failure" : question.includes("empty") ? "empty" : "ok";
      if (toolResults.length > 0) {
        if (question.includes("network dependency")) {
          return { toolCalls: [{ id: "mock-need-domain", name: "need_domain", arguments: { needsDomain: "network-observability", reason: "Live network evidence is required." } }], usage: { promptTokens: 48, completionTokens: 16 } };
        }
        const evidenceIds = toolResults.map((message) => extractEvidenceId(message.content)).filter((id): id is string => typeof id === "string").slice(0, 8);
        return { toolCalls: [{ id: "mock-answer", name: "answer", arguments: { summary: "The available evidence reports the requested system state (documented and/or live, as cited).", evidenceIds } }], usage: { promptTokens: 48, completionTokens: 20 } };
      }
      const preferred = realTools.find((tool) =>
        (question.includes("replication") && tool.name === "get_replication_status")
        || (question.includes("pod") && tool.name === "get_pod_status")
        || ((question.includes("slow") || question.includes("prometheus")) && tool.name === "query_prometheus")
        || ((question.includes("wiki") || question.includes("documentation") || question.includes("documented") || question.includes("runbook") || question.includes("procedure")) && tool.name === "wiki_search"),
      ) ?? realTools[0];
      if (preferred !== undefined) {
        return { toolCalls: [{ id: "mock-call-1", name: preferred.name, arguments: argumentsForSchema(preferred.inputSchema, mode) }], usage: { promptTokens: 48, completionTokens: 16 } };
      }
      return { toolCalls: [{ id: "mock-insufficient", name: "insufficient_evidence", arguments: { reason: "No tools are available to investigate the request." } }], usage: { promptTokens: 32, completionTokens: 12 } };
    }
    return { content: "Mock model response grounded in the supplied evidence.", usage: { promptTokens: 32, completionTokens: 12 } };
  }
}

/** Extract the evidence id from a native tool-result message (the loop encodes it as JSON). */
function extractEvidenceId(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/** Extract a JSON block delimited by `<START>\n...\nEND_...` from the mock message set. */
function extractJsonBlock(messages: ReadonlyArray<{ role: string; content: string }>, startsWith: string): unknown {
  const message = messages.find((m) => typeof m.content === "string" && m.content.startsWith(startsWith));
  if (message === undefined) return undefined;
  const nl = message.content.indexOf("\n");
  const end = message.content.lastIndexOf("\nEND");
  if (nl < 0 || end <= nl) return undefined;
  try { return JSON.parse(message.content.slice(nl + 1, end)); } catch { return undefined; }
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
  const sample: Record<string, string> = { sourceDc: "DC-TLV-01", targetDc: "DC-HFA-02", dc: "DC-TLV-01", namespace: "payments", pod: "payments-api-0", query: "latency", device: "core-sw-1", target: "10.0.0.1", pool: "web-pool", site: "TLV", interface: "eth0", route: "payments", deployment: "payments-api", domain: "keycloak", q: "login failures", slug: "kc-login-troubleshooting" };
  const args: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(properties)) {
    if (name === "mode") { args.mode = spec.enum === undefined || spec.enum.includes(mode) ? mode : spec.enum[0]; continue; }
    if (sample[name] !== undefined) args[name] = sample[name];
  }
  if ("mode" in properties && args.mode === undefined) args.mode = mode;
  return args;
}

export interface RealModelClientOptions {
  apiKey?: string;
  /** maps logical profile (manager-router, tool-caller, tier-l-synthesis) → served model id */
  modelMap?: Record<string, string>;
  /** prepended system message (e.g. "/no_think" for local qwen3); usually unset for Groq */
  systemSuffix?: string;
}

export class ModelRequestError extends Error {
  readonly code: "MODEL_RATE_LIMITED" | "MODEL_UNAVAILABLE" | "MODEL_INVALID_OUTPUT";
  readonly status?: number;
  constructor(code: ModelRequestError["code"], message: string, status?: number) {
    super(message);
    this.name = "ModelRequestError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Provider-agnostic OpenAI-compatible client (Groq, Ollama, or an on-prem vLLM
 * endpoint). Logical agent profiles map to served model ids through config, so
 * no provider URL or model name is hardcoded in business logic.
 */
export class RealOpenAiCompatibleClient implements ModelClient {
  readonly mode = "real" as const;
  readonly #baseUrl: string;
  readonly #options: RealModelClientOptions;

  constructor(baseUrl: string, options: RealModelClientOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/u, "");
    this.#options = options;
  }

  #endpoint(): string {
    // Groq base ends with /v1; a bare host (Ollama) does not — normalize either way
    return this.#baseUrl.endsWith("/v1") ? `${this.#baseUrl}/chat/completions` : `${this.#baseUrl}/v1/chat/completions`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const suffixMessages: ChatMessage[] = this.#options.systemSuffix ? [{ role: "system", content: this.#options.systemSuffix }] : [];
    const body = {
      model: this.#options.modelMap?.[request.model] ?? request.model,
      messages: [...suffixMessages, ...request.messages].map(serializeMessage),
      ...(request.tools ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), tool_choice: "auto" } : {}),
      ...(request.guidedJsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "structured_output", schema: request.guidedJsonSchema, strict: true } } } : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    };
    const response = await fetch(this.#endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.#options.apiKey ? { authorization: `Bearer ${this.#options.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (response.status === 429) throw new ModelRequestError("MODEL_RATE_LIMITED", "model provider rate limited the request", 429);
    if (!response.ok) throw new ModelRequestError("MODEL_UNAVAILABLE", `model request failed (${response.status})`, response.status);
    let result: {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      result = await response.json() as typeof result;
    } catch {
      throw new ModelRequestError("MODEL_INVALID_OUTPUT", "model provider returned a non-JSON body");
    }
    const message = result.choices?.[0]?.message;
    if (message === undefined) throw new ModelRequestError("MODEL_INVALID_OUTPUT", "model response has no choice");
    let toolCalls: ToolCall[] | undefined;
    if (message.tool_calls) {
      try {
        toolCalls = message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments || "{}") as Record<string, unknown> }));
      } catch {
        throw new ModelRequestError("MODEL_INVALID_OUTPUT", "model returned unparseable tool-call arguments");
      }
    }
    return {
      ...(message.content ? { content: message.content } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      usage: { promptTokens: result.usage?.prompt_tokens ?? 0, completionTokens: result.usage?.completion_tokens ?? 0 },
    };
  }
}

/** Serialize a ChatMessage to the OpenAI wire shape, including assistant tool_calls and tool results. */
function serializeMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return { role: "assistant", content: message.content || null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}), ...(message.name ? { name: message.name } : {}) };
  }
  return { role: message.role, content: message.content };
}

function structured(response: ChatResponse, schema: Record<string, unknown> | undefined): ChatResponse {
  if (schema === undefined || response.content === undefined) return response;
  JSON.parse(response.content);
  return response;
}
