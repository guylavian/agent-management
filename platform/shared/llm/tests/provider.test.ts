import { describe, expect, it } from "vitest";
import { ModelRequestError, RealOpenAiCompatibleClient, type ChatRequest } from "../src/index.ts";

const GROQ = "https://api.groq.com/openai/v1";
const modelMap = { "manager-router": "qwen/qwen3.8-27b", "tool-caller": "qwen/qwen3.8-27b", "tier-l-synthesis": "qwen/qwen3.8-27b" };

// captures the outgoing request and returns a scripted OpenAI-style body
function stubFetch(status: number, body: unknown): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function sentBody(calls: Array<{ url: string; init: RequestInit }>): Record<string, unknown> {
  const call = calls[0];
  if (call === undefined) throw new Error("no request captured");
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => { globalThis.fetch = original; });
}

const toolResult = { choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "wiki_search", arguments: "{\"domain\":\"keycloak\",\"q\":\"login\"}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const textResult = { choices: [{ message: { content: "Final grounded answer." } }], usage: { prompt_tokens: 3, completion_tokens: 4 } };

describe("Groq / OpenAI-compatible provider", () => {
  it("1. uses the configured base URL (Groq /v1 not doubled)", async () => {
    const { fetch: f, calls } = stubFetch(200, textResult);
    await withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat({ model: "tool-caller", messages: [] }));
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  /**
   * Routing determinism is only real if the number reaches the provider. The
   * profile declaring temperature 0 and the client dropping it would look
   * identical from config, and the difference would only show as routes that
   * wobble between identical questions.
   */
  it("sends the profile's declared temperature, including an explicit zero", async () => {
    const { fetch: f, calls } = stubFetch(200, textResult);
    await withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap, temperatureMap: { "manager-router": 0 } }).chat({ model: "manager-router", messages: [] }));
    // a truthiness check would drop 0, which is the one value that matters here
    expect(sentBody(calls).temperature).toBe(0);
  });

  it("omits temperature for a profile that declares none, leaving the provider default", async () => {
    const { fetch: f, calls } = stubFetch(200, textResult);
    await withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap, temperatureMap: { "manager-router": 0 } }).chat({ model: "tool-caller", messages: [] }));
    expect(sentBody(calls)).not.toHaveProperty("temperature");
  });

  it("2. passes the API key as a Bearer token", async () => {
    const { fetch: f, calls } = stubFetch(200, textResult);
    await withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { apiKey: "gsk_test", modelMap }).chat({ model: "tool-caller", messages: [] }));
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gsk_test");
  });

  it("3/4/5. maps manager / tool-caller / synthesis profiles to the configured model", async () => {
    for (const profile of ["manager-router", "tool-caller", "tier-l-synthesis"]) {
      const { fetch: f, calls } = stubFetch(200, textResult);
      await withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat({ model: profile, messages: [] }));
      expect(sentBody(calls).model).toBe("qwen/qwen3.8-27b");
    }
  });

  it("6. parses a native tool call", async () => {
    const { fetch: f } = stubFetch(200, toolResult);
    const res = await withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat({ model: "tool-caller", messages: [] }));
    expect(res.toolCalls?.[0]).toMatchObject({ name: "wiki_search", arguments: { domain: "keycloak", q: "login" } });
  });

  it("7/8. replays an assistant tool_call and a tool result across turns", async () => {
    const { fetch: f, calls } = stubFetch(200, textResult);
    const request: ChatRequest = {
      model: "tool-caller",
      messages: [
        { role: "user", content: "check" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "wiki_search", arguments: { q: "x" } }] },
        { role: "tool", toolCallId: "c1", name: "wiki_search", content: "{\"id\":\"e1\"}" },
      ],
    };
    await withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat(request));
    const sent = sentBody(calls).messages as Array<Record<string, unknown>>;
    expect(sent[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "wiki_search" } }] });
    expect(sent[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "{\"id\":\"e1\"}" });
  });

  it("9. a no-tool response terminates as a plain answer", async () => {
    const { fetch: f } = stubFetch(200, textResult);
    const res = await withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat({ model: "tool-caller", messages: [] }));
    expect(res.content).toBe("Final grounded answer.");
    expect(res.toolCalls).toBeUndefined();
  });

  it("10. an aborted/timed-out request rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = (async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) as typeof fetch;
    await expect(withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat({ model: "tool-caller", messages: [], signal: controller.signal }))).rejects.toThrow();
  });

  it("11. a rate-limit (429) is surfaced safely", async () => {
    const { fetch: f } = stubFetch(429, { error: "rate limited" });
    await expect(withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat({ model: "tool-caller", messages: [] }))).rejects.toMatchObject({ code: "MODEL_RATE_LIMITED" });
  });

  it("12. an invalid API response is rejected", async () => {
    const { fetch: f } = stubFetch(200, "not json");
    await expect(withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat({ model: "tool-caller", messages: [] }))).rejects.toBeInstanceOf(ModelRequestError);
  });

  it("13. a 5xx provider failure throws (runtime never sees a bypassed answer)", async () => {
    const { fetch: f } = stubFetch(503, { error: "down" });
    await expect(withFetch(f, () => new RealOpenAiCompatibleClient(GROQ, { modelMap }).chat({ model: "tool-caller", messages: [] }))).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });

  it("14. the deterministic mock remains usable without any provider", async () => {
    const { MockModelClient } = await import("../src/index.ts");
    const res = await new MockModelClient().chat({ model: "tool-caller", messages: [{ role: "user", content: "check replication" }], tools: [{ name: "get_replication_status", description: "d", inputSchema: { type: "object", properties: { sourceDc: { type: "string" } } } }] });
    expect(res.toolCalls?.[0]?.name).toBe("get_replication_status");
  });
});
