import type { Evidence } from "@sre/evidence";
import type {
  AgentDefinition,
  CredentialProvider,
  ListToolsOptions,
  Model,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  Principal,
  Sanitizer,
  SpanAttributes,
  Telemetry,
  ToolCallRequest,
  ToolCallResult,
  ToolCredential,
  ToolDescriptor,
  ToolPolicy,
  ToolProvider,
} from "../src/index.ts";
import { engineError } from "../src/index.ts";

/**
 * The engine's tests use a SYNTHETIC host, not the platform's.
 *
 * That is the point of this file. If these tests borrowed a real Agent catalog,
 * a real gateway client or a real redaction implementation, "the engine is
 * generic" would be an assertion in a comment rather than something the test
 * suite demonstrates. Everything below is invented here: neutral server names,
 * neutral tool names, an in-memory provider and a toy sanitizer.
 *
 * Nothing in this directory imports a platform package except @sre/evidence,
 * which is the one neutral contract the engine shares with its hosts.
 */

export const ALICE: Principal = { subject: "alice", roles: ["reader"], groups: ["ops"], requestId: "req-1" };
export const BOB: Principal = { subject: "bob", roles: ["other"], groups: [], requestId: "req-2" };

/** A toy Sanitizer. It exists to prove the engine CALLS one, in the right order. */
export const testSanitizer: Sanitizer = {
  text(input) {
    // deliberately excludes quote and brace so a JSON round-trip stays parseable
    const value = input.replace(/password=[^\s"}]+/giu, "[REDACTED:password]").replace(/Bearer\s+[^\s"}]+/giu, "[REDACTED:token]");
    return { value, categories: value === input ? [] : ["secret"] };
  },
  evidence(input) {
    const redactValue = (value: unknown): unknown => typeof value === "string" ? testSanitizer.text(value).value : value === null || typeof value !== "object" ? value : JSON.parse(testSanitizer.text(JSON.stringify(value)).value) as unknown;
    const rawExcerpt = input.rawExcerpt === undefined ? undefined : testSanitizer.text(input.rawExcerpt).value;
    const payload = input.payload === undefined ? undefined : redactValue(input.payload);
    const applied = rawExcerpt !== input.rawExcerpt || JSON.stringify(payload) !== JSON.stringify(input.payload);
    return { ...input, ...(rawExcerpt === undefined ? {} : { rawExcerpt }), ...(payload === undefined ? {} : { payload }), ...(applied ? { redaction: { applied: true, categories: ["secret"] } } : {}) };
  },
};

export class RecordingTelemetry implements Telemetry {
  readonly spans: Array<{ name: string; attributes: SpanAttributes }> = [];
  readonly counters: string[] = [];
  async span<T>(name: string, attributes: SpanAttributes, action: () => Promise<T>): Promise<T> {
    this.spans.push({ name, attributes });
    return action();
  }
  counter(name: string): void { this.counters.push(name); }
}

/** Returns scripted action envelopes as content (repeating the last), recording every request. */
export class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  readonly #actions: unknown[];
  #index = 0;
  constructor(actions: unknown[]) { this.#actions = actions; }
  async chat(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const action = this.#actions[Math.min(this.#index, this.#actions.length - 1)] ?? { action: "insufficient_evidence", reason: "no script" };
    this.#index += 1;
    return { content: JSON.stringify(action), usage: { promptTokens: 1, completionTokens: 1 } };
  }
}

/** Returns scripted NATIVE tool-call turns, the path a real tool-calling model takes. */
export class NativeModel implements Model {
  readonly requests: ModelRequest[] = [];
  readonly #turns: ModelToolCall[][];
  #index = 0;
  constructor(turns: ModelToolCall[][]) { this.#turns = turns; }
  async chat(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const calls = this.#turns[Math.min(this.#index, this.#turns.length - 1)] ?? [];
    this.#index += 1;
    return { toolCalls: calls, usage: { promptTokens: 1, completionTokens: 1 } };
  }
}

export interface FixtureTool extends ToolDescriptor {
  /** overrides the canned result for this tool */
  result?: (call: ToolCallRequest) => unknown;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/**
 * Tools a fictional host publishes. `mode` drives the failure modes the loop
 * must survive; the names are deliberately meaningless.
 */
export const FIXTURE_TOOLS: FixtureTool[] = [
  { serverId: "docs", name: "docs_search", description: "Search documented procedure", inputSchema: objectSchema({ q: { type: "string" }, mode: { type: "string" } }, ["q"]) },
  { serverId: "docs", name: "docs_read", description: "Read one document", inputSchema: objectSchema({ slug: { type: "string" }, mode: { type: "string" } }, ["slug"]) },
  { serverId: "alpha", name: "alpha_status", description: "Read subsystem status", inputSchema: objectSchema({ target: { type: "string", maxLength: 64 }, peer: { type: "string" }, mode: { type: "string", enum: ["ok", "failure", "timeout", "denied", "empty", "error"] } }, ["target"]) },
  { serverId: "alpha", name: "alpha_health", description: "Read subsystem health", inputSchema: objectSchema({ node: { type: "string" }, mode: { type: "string" } }, ["node"]) },
  // published by the server and approved, but named like a mutation: the read-only backstop must hide it
  { serverId: "alpha", name: "alpha_update_node", description: "Would mutate", inputSchema: objectSchema({ node: { type: "string" } }, ["node"]) },
  // a server the Agent under test has no access entry for
  { serverId: "beta", name: "beta_status", description: "Another subsystem", inputSchema: objectSchema({ target: { type: "string" } }, ["target"]) },
];

/**
 * An in-memory ToolProvider. No MCP, no HTTP, no gateway — which is exactly what
 * the engine's ToolProvider port is supposed to allow.
 */
export class FixtureToolProvider implements ToolProvider {
  readonly calls: ToolCallRequest[] = [];
  readonly listedServers: string[] = [];
  readonly #tools: FixtureTool[];
  readonly #requireCredential: boolean;

  constructor(options: { tools?: FixtureTool[]; requireCredential?: boolean } = {}) {
    this.#tools = options.tools ?? FIXTURE_TOOLS;
    this.#requireCredential = options.requireCredential ?? false;
  }

  async listTools(serverId: string, _principal: Principal, _environment: string, options?: ListToolsOptions): Promise<ToolDescriptor[]> {
    this.listedServers.push(serverId);
    if (this.#requireCredential && options?.credential === undefined) throw engineError("TOOL_DENIED", "discovery requires a credential");
    return this.#tools.filter((tool) => tool.serverId === serverId);
  }

  async invoke(call: ToolCallRequest): Promise<ToolCallResult> {
    if (this.#requireCredential && call.credential === undefined) throw engineError("TOOL_DENIED", "invocation requires a credential");
    const tool = this.#tools.find((item) => item.serverId === call.serverId && item.name === call.toolName);
    if (tool === undefined) throw engineError("TOOL_DENIED", "tool access denied");
    this.calls.push(call);
    const mode = call.arguments.mode;
    if (mode === "denied") throw engineError("TOOL_DENIED", "tool access denied");
    if (mode === "failure") throw engineError("TOOL_FAILED", "backend failure");
    if (mode === "timeout") {
      await new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(engineError("MCP_TIMEOUT", "backend timeout")), Math.min(call.timeoutMs + 5, 50));
        call.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(call.signal?.reason as Error); }, { once: true });
      });
    }
    if (mode === "empty") return { content: [], observedAt: new Date().toISOString() };
    // the provider RETURNED, but the tool itself reports failure — distinct from a thrown transport error
    if (mode === "error") return { content: { tool: call.toolName, error: "backend reported failure" }, isError: true, observedAt: new Date().toISOString() };
    return { content: tool.result ? tool.result(call) : { tool: call.toolName, ...call.arguments }, observedAt: new Date().toISOString() };
  }
}

export const BUDGETS = {
  maxToolCalls: 6,
  maxModelTurns: 6,
  timeoutMs: 10_000,
  maxEvidenceBytes: 65_536,
  maxContextTokens: 8_000,
  maxEvidenceItems: 16,
  maxRawExcerptBytes: 4_096,
};

/** The Agent under test: two servers, an explicit tool grant on each, read-only, active. */
export function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "alpha-agent",
    systemPrompt: "You investigate the alpha subsystem. Cite evidence.",
    modelProfile: "tool-caller",
    budgets: { ...BUDGETS, ...overrides.budgets },
    access: [
      { server: "docs", tools: ["docs_search", "docs_read"], audience: "resource:docs" },
      { server: "alpha", tools: ["alpha_status", "alpha_health", "alpha_update_node"], audience: "resource:alpha" },
    ],
    enabled: true,
    requiredRoles: ["reader"],
    readOnly: true,
    workload: { clientId: "workload-alpha", provider: "test" },
    lifecycleLabel: "active",
    ...overrides,
  };
}

/** The approved catalog. `beta_status` is approved for the host but not granted to this Agent. */
export function toolPolicy(): ToolPolicy {
  const approve = (serverId: string, toolName: string, evidenceKind: "telemetry" | "config" | "wiki" = "telemetry") => ({
    serverId, toolName, readOnlyVerified: true, environments: ["prod"], timeoutMs: 5_000, retryPolicy: "none" as const, evidenceKind,
  });
  return {
    tools: [
      approve("docs", "docs_search", "wiki"),
      approve("docs", "docs_read", "wiki"),
      approve("alpha", "alpha_status"),
      approve("alpha", "alpha_health"),
      approve("alpha", "alpha_update_node"),
      approve("beta", "beta_status"),
    ],
  };
}

export function runContext(question: string, deadline = Date.now() + 10_000, overrides: Record<string, unknown> = {}) {
  return { question, environment: "prod", requestId: ALICE.requestId, principal: ALICE, deadline, ...overrides };
}

export function dependencies(model: Model, tools: ToolProvider = new FixtureToolProvider(), telemetry = new RecordingTelemetry(), sanitizer = testSanitizer, credentials?: CredentialProvider) {
  return { model, tools, sanitizer, telemetry, ...(credentials ? { credentials } : {}) };
}

/** Mirrors the engine's evidence identity: request + tool + args fingerprint. */
export const evidenceId = (tool: string, args: Record<string, unknown>, requestId = ALICE.requestId): string => {
  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
      : JSON.stringify(value) ?? "null";
  let hash = 0x811c9dc5;
  for (const char of canonical(args)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `mcp:${requestId}:${tool}:${hash.toString(16).padStart(8, "0")}`;
};

/**
 * A model double whose script SEES each request, so a test can prove what
 * actually reached model context (containment proofs) and can respond to tool
 * results fed back in — the seam the audit found missing from every loop test.
 */
export class RespondingModel implements Model {
  readonly requests: ModelRequest[] = [];
  readonly #respond: (request: ModelRequest, turn: number) => ModelResponse;
  constructor(respond: (request: ModelRequest, turn: number) => ModelResponse) { this.#respond = respond; }
  async chat(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.#respond(request, this.requests.length - 1);
  }
}

/** Never settles and ignores its signal: deadlines must hold by racing, not cooperation. */
export class DeafModel implements Model {
  chats = 0;
  chat(): Promise<ModelResponse> {
    this.chats += 1;
    return new Promise<never>(() => { /* never settles, deliberately */ });
  }
}

/** Wraps a real provider but never settles at one chosen stage, ignoring its signal. */
export class DeafToolProvider implements ToolProvider {
  readonly #stage: "list" | "invoke";
  readonly #inner: ToolProvider;
  constructor(stage: "list" | "invoke", inner: ToolProvider = new FixtureToolProvider()) {
    this.#stage = stage;
    this.#inner = inner;
  }
  listTools(serverId: string, principal: Principal, environment: string, options?: ListToolsOptions): Promise<ToolDescriptor[]> {
    if (this.#stage === "list") return new Promise<never>(() => { /* never settles */ });
    return this.#inner.listTools(serverId, principal, environment, options);
  }
  invoke(call: ToolCallRequest): Promise<ToolCallResult> {
    if (this.#stage === "invoke") return new Promise<never>(() => { /* never settles */ });
    return this.#inner.invoke(call);
  }
}

/** A credential exchanger that never settles and ignores every input. */
export class DeafCredentialProvider implements CredentialProvider {
  exchanges = 0;
  exchange(): Promise<ToolCredential> {
    this.exchanges += 1;
    return new Promise<never>(() => { /* never settles */ });
  }
}

/** Fails the first N chat calls with a coded error, then behaves like ScriptedModel. */
export class FlakyModel implements Model {
  attempts = 0;
  readonly #failures: number;
  readonly #code: string;
  readonly #inner: ScriptedModel;
  constructor(failures: number, code: string, actions: unknown[]) {
    this.#failures = failures;
    this.#code = code;
    this.#inner = new ScriptedModel(actions);
  }
  async chat(request: ModelRequest): Promise<ModelResponse> {
    this.attempts += 1;
    if (this.attempts <= this.#failures) throw engineError(this.#code, `synthetic ${this.#code}`);
    return this.#inner.chat(request);
  }
}

export const baseEvidence: Evidence = { id: "e1", kind: "telemetry", source: "alpha/alpha_status", system: "alpha", environment: "prod", rawExcerpt: "x".repeat(5000), citation: "mcp://alpha/alpha_status", status: "ok", requestId: "req-1" };

export const toolCallAction = (tool: string, args: Record<string, unknown>) => ({ action: "tool_call", purpose: "p", tool, arguments: args });
export const answerAction = (summary: string, evidenceIds: string[] = []) => ({ action: "answer", summary, evidenceIds });
export const nativeCall = (id: string, name: string, args: Record<string, unknown>): ModelToolCall => ({ id, name, arguments: args });
export const nativeAnswer = (summary: string, evidenceIds: string[] = []): ModelToolCall => ({ id: "ans", name: "answer", arguments: { summary, evidenceIds } });

export type { ToolCredential };
