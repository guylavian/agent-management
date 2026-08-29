import { MockModelClient, type ChatRequest, type ChatResponse, type ModelClient } from "@sre/llm";
import { buildModelMap, draftSystemPrompt, PROMPT_ASSIST_PROFILE, PromptAssistError, safeContext } from "@sre/runtime-host";
import { loadAppConfig } from "@sre/config";
import { describe, expect, it } from "vitest";

/**
 * Drafting a system prompt with a model.
 *
 * Two things are being defended here, and neither is the quality of the prose:
 * what leaves the process, and which model is asked. Both are properties of the
 * code rather than of the caller, so both are tested against a hostile body.
 */

/** Captures exactly what was sent, so the assertions can be made against the wire. */
class RecordingModel implements ModelClient {
  readonly mode = "real" as const;
  readonly requests: ChatRequest[] = [];
  readonly #reply: ChatResponse | Error;
  constructor(reply: ChatResponse | Error) { this.#reply = reply; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    if (this.#reply instanceof Error) throw this.#reply;
    return this.#reply;
  }
}

const FORM = {
  name: "check-point",
  displayName: "Check Point Agent",
  description: "Firewall policy and rule-base investigation.",
  owner: "network-security",
  routing: {
    capabilities: ["firewall policy", "rule base"],
    exclusions: ["kubernetes", "identity"],
    exactTerms: ["checkpoint"],
    entityPatterns: ["fw-\\d+"],
    ambiguousTerms: ["policy"],
  },
  crossDomainAllowed: ["observability"],
  environments: ["prod"],
  requiredRoles: ["infra-read"],
  access: [{ mcp: "network", tools: ["get_interface_status", "get_bgp_status"] }],
  limits: { maxToolCalls: 6, maxModelTurns: 6 },
};

const reply = (content: string): ChatResponse => ({ content, usage: { promptTokens: 1, completionTokens: 1 } });

describe("only allowlisted form context reaches the model", () => {
  it("rebuilds the context field by field, so an unknown key cannot travel", async () => {
    const model = new RecordingModel(reply("You are the Check Point specialist."));
    // a body carrying exactly the things that must never leave the process
    await draftSystemPrompt(model, safeContext({
      ...FORM,
      apiKey: "sk-live-must-not-travel",
      SRE_LLM_API_KEY: "groq-secret-must-not-travel",
      authorization: "Bearer must-not-travel",
      clientSecret: "must-not-travel",
      identity: { clientId: "sre-agent-check-point", clientSecret: "must-not-travel" },
      access: [{ mcp: "network", tools: ["get_bgp_status"], audience: "sre-toolhive:network", credential: "must-not-travel" }],
    }));

    const wire = JSON.stringify(model.requests);
    expect(wire).not.toMatch(/must-not-travel/u);
    expect(wire).not.toMatch(/sk-live|groq-secret|Bearer/u);
    // and the legitimate context did survive, so this is not passing by sending nothing
    expect(wire).toContain("check-point");
    expect(wire).toContain("get_bgp_status");
  });

  it("keeps only scalars and string arrays, dropping nested objects wholesale", () => {
    const context = safeContext({ ...FORM, routing: { capabilities: [{ nested: "object" }, "firewall policy"], exclusions: "not-an-array" } });
    expect(context.capabilities).toEqual(["firewall policy"]);
    expect(context.exclusions).toEqual([]);
    expect(Object.keys(context)).not.toContain("apiKey");
  });

  it("pins read-only regardless of what the caller claims", () => {
    // the platform supports no writing Agent; a draft must never suggest one
    expect(safeContext({ ...FORM, readOnly: false }).readOnly).toBe(true);
  });

  it("refuses a body with no agent name rather than drafting something generic", () => {
    expect(() => safeContext({ description: "something" })).toThrow(PromptAssistError);
  });

  it("bounds the lists and the existing prompt so one request cannot be unbounded", () => {
    const context = safeContext({
      ...FORM,
      routing: { capabilities: Array.from({ length: 500 }, (_v, index) => `cap-${index}`) },
      access: Array.from({ length: 200 }, (_v, index) => ({ mcp: `mcp-${index}`, tools: ["x"] })),
      prompt: "y".repeat(50_000),
    });
    expect(context.capabilities).toHaveLength(64);
    expect(context.access).toHaveLength(32);
    expect(context.existingPrompt?.length).toBe(8_000);
  });
});

describe("the platform profile is used, never the Agent's own", () => {
  it("asks for prompt-assist", async () => {
    const model = new RecordingModel(reply("drafted"));
    await draftSystemPrompt(model, safeContext(FORM));
    expect(model.requests[0]?.model).toBe(PROMPT_ASSIST_PROFILE);
    expect(model.requests[0]?.model).toBe("prompt-assist");
  });

  it("names no vendor or provider anywhere in the request", async () => {
    const model = new RecordingModel(reply("drafted"));
    await draftSystemPrompt(model, safeContext(FORM));
    // the environment's bindings resolve the profile; this code must not care
    expect(JSON.stringify(model.requests)).not.toMatch(/groq|openai|anthropic|azure|bedrock|ollama|vllm/iu);
  });

  it("carries no tool schemas: drafting is a text task, not an agent run", async () => {
    const model = new RecordingModel(reply("drafted"));
    await draftSystemPrompt(model, safeContext(FORM));
    expect(model.requests[0]?.tools).toBeUndefined();
  });
});

describe("the draft instructs the contract the runtime actually enforces", () => {
  it("asks for the control vocabulary, evidence discipline and read-only posture", async () => {
    const model = new RecordingModel(reply("drafted"));
    await draftSystemPrompt(model, safeContext(FORM));
    const system = model.requests[0]?.messages[0]?.content ?? "";
    expect(system).toContain("insufficient_evidence");
    expect(system).toContain("needs_domain");
    expect(system).toMatch(/read-only/u);
    expect(system).toMatch(/forbid inventing/iu);
  });

  it("passes the exclusions and the selected tools, and nothing that was not selected", async () => {
    const model = new RecordingModel(reply("drafted"));
    await draftSystemPrompt(model, safeContext(FORM));
    const user = model.requests[0]?.messages[1]?.content ?? "";
    expect(user).toContain("out of scope: kubernetes, identity");
    expect(user).toContain("network: get_interface_status, get_bgp_status");
    expect(user).not.toContain("get_path_health");
  });

  it("sends the current prompt for an improvement, and not for a first draft", async () => {
    const improve = new RecordingModel(reply("drafted"));
    await draftSystemPrompt(improve, safeContext({ ...FORM, prompt: "You are the existing prompt." }));
    expect(improve.requests[0]?.messages[1]?.content).toContain("You are the existing prompt.");

    const fresh = new RecordingModel(reply("drafted"));
    await draftSystemPrompt(fresh, safeContext(FORM));
    expect(fresh.requests[0]?.messages[1]?.content).not.toMatch(/wants it improved/u);
  });
});

describe("failure never silently replaces the operator's prompt", () => {
  it("throws when the provider fails, so the caller can leave the field alone", async () => {
    const model = new RecordingModel(new Error("connection refused to some-internal-host:8000"));
    await expect(draftSystemPrompt(model, safeContext(FORM))).rejects.toThrow();
  });

  it("throws rather than returning empty text when the model answers with nothing", async () => {
    const empty = new RecordingModel({ content: "   ", usage: { promptTokens: 1, completionTokens: 0 } });
    await expect(draftSystemPrompt(empty, safeContext(FORM))).rejects.toThrow(PromptAssistError);
  });

  it("works against any ModelClient, which is what makes an air-gapped binding possible", async () => {
    // MockModelClient is the same port an internal OpenAI-compatible endpoint
    // implements; nothing in the drafter knows which one it has
    const mock = new MockModelClient();
    mock.enqueue(reply("You are the Check Point specialist."));
    await expect(draftSystemPrompt(mock, safeContext(FORM))).resolves.toContain("Check Point");
  });
});

/**
 * The profile has to reach the provider as a SERVED model id.
 *
 * It did not, at first: the map only fell back to `llm.model`, so a deployment
 * that binds the three agent profiles and nothing else — which is what the PoC
 * does — left `prompt-assist` out of the map and sent the literal string to the
 * provider as though it were a model. The unit tests above never caught it
 * because they inject a ModelClient and skip the map entirely.
 */
describe("the prompt-assist profile resolves to a served model", () => {
  const config = (env: Record<string, string>) =>
    loadAppConfig({ SRE_LLM_BASE_URL: "http://model.internal/v1", ...env } as NodeJS.ProcessEnv);

  it("uses an explicit binding when the environment gives one", () => {
    const map = buildModelMap(config({ SRE_MODEL_PROMPT_ASSIST: "internal-drafting-model", SRE_MODEL_TOOL_CALLER: "tool-model" }));
    expect(map["prompt-assist"]).toBe("internal-drafting-model");
  });

  it("degrades to a configured profile rather than leaving the map without an entry", () => {
    const map = buildModelMap(config({ SRE_MODEL_MANAGER: "m", SRE_MODEL_TOOL_CALLER: "tool-model", SRE_MODEL_SYNTHESIS: "s" }));
    expect(map["prompt-assist"]).toBe("tool-model");
  });

  it("never leaves the literal profile name to travel as a model id", () => {
    const map = buildModelMap(config({ SRE_MODEL_MANAGER: "m", SRE_MODEL_TOOL_CALLER: "t", SRE_MODEL_SYNTHESIS: "s" }));
    expect(map["prompt-assist"]).not.toBe(PROMPT_ASSIST_PROFILE);
  });

  it("can be bound to a DIFFERENT endpoint from the Agents' provider", () => {
    // the point of a platform profile: drafting may run somewhere the Agents do
    // not, which is what makes both a local-agents dev box and an air-gapped
    // deployment work without changing a line of code
    const separate = config({
      SRE_LLM_PROMPT_ASSIST_URL: "https://hosted.example/v1",
      SRE_MODEL_PROMPT_ASSIST: "hosted-drafting-model",
      SRE_MODEL_TOOL_CALLER: "local-agent-model",
    });
    expect(separate.llm.promptAssistBaseUrl).toBe("https://hosted.example/v1");
    expect(separate.llm.baseUrl).toBe("http://model.internal/v1");
    // the Agents' own profile is untouched by the platform binding
    expect(buildModelMap(separate)["tool-caller"]).toBe("local-agent-model");
  });

  it("stays a DISTINCT profile, so an environment can point it elsewhere", () => {
    const map = buildModelMap(config({ SRE_MODEL_TOOL_CALLER: "agent-model", SRE_MODEL_PROMPT_ASSIST: "air-gapped-local-model" }));
    expect(map["prompt-assist"]).toBe("air-gapped-local-model");
    expect(map["tool-caller"]).toBe("agent-model");
  });
});
