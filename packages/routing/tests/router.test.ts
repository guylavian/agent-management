import { loadAgentServiceRegistry } from "@sre/agent-registry";
import { loadAgentInstance, type ManagerAgentConfig } from "@sre/config";
import type { ChatRequest, ChatResponse, ModelClient } from "@sre/llm";
import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { classifyIntent, deterministicRoute, ManagerRouter } from "../src/index.ts";

const registry = loadAgentServiceRegistry("agents/registry.yaml");
const manager = loadAgentInstance({ configFile: "agents/manager.yaml" }) as ManagerAgentConfig;
const ids = ["active-directory", "openshift", "network-observability"];
// routing rules are sourced entirely from registry config, never from code
const rules = registry.listEnabled().map((entry) => ({ agentId: entry.agentId, ...entry.routing }));

describe("Stage-1 routing", () => {
  it.each([
    ["Check AD replication between DC-TLV-01 and DC-HFA-02", "active-directory"],
    ["Why is this OpenShift pod in CrashLoopBackOff?", "openshift"],
    ["Show packet loss from Prometheus", "network-observability"],
  ])("routes precise vocabulary", (question, expected) => {
    expect(deterministicRoute(question, rules)).toMatchObject({ resolved: true, decision: { agents: [expected] } });
  });

  it.each(["cluster status", "replication status", "certificate policy", "gateway node"])("does not guess from ambiguous phrase %s", (question) => {
    expect(deterministicRoute(question, rules).resolved).toBe(false);
  });

  it("extracts trusted entity syntax and classifies intent deterministically", () => {
    const result = deterministicRoute("Why is DC-TLV-01 intermittently slow?", rules);
    expect(result.entities).toMatchObject({ hostname: "DC-TLV-01" });
    expect(result.intent).toBe("diagnostic");
    expect(classifyIntent("Show current status", ["causal-question"])).toBe("diagnostic");
    expect(classifyIntent("Show current status")).toBe("factual");
  });

  it("onboards a new specialist from config alone — no routing code change", () => {
    // an Exchange specialist added purely as a registry rule routes immediately
    const withExchange = [...rules, { agentId: "exchange", exactTerms: ["exchange", "mailbox", "outlook"], entityPatterns: [], ambiguousTerms: [] }];
    expect(deterministicRoute("Is the Exchange mailbox database mounted?", withExchange)).toMatchObject({ resolved: true, decision: { agents: ["exchange"] } });
  });
});

describe("Manager", () => {
  it("receives authorized descriptors but no tool schemas or payloads", async () => {
    class InspectingModel implements ModelClient {
      readonly mode = "mock" as const;
      request?: ChatRequest;
      async chat(request: ChatRequest): Promise<ChatResponse> { this.request = request; return { content: JSON.stringify({ routes: [{ agent: "active-directory", task: "Check AD-side causes." }], confidence: 0.9, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } }; }
    }
    const model = new InspectingModel();
    await new ManagerRouter(model, registry, manager).selectAgents("certificate issue", ["active-directory"], {});
    expect(model.request?.tools).toBeUndefined();
    expect(model.request?.messages.at(-1)?.content).toContain("authorizedSpecialists");
    expect(model.request?.messages.at(-1)?.content).not.toContain("allowedTools");
  });

  it("supplies the dynamic catalog with capabilities, not hardcoded names in the prompt", async () => {
    class InspectingModel implements ModelClient {
      readonly mode = "mock" as const;
      request?: ChatRequest;
      async chat(request: ChatRequest): Promise<ChatResponse> { this.request = request; return { content: JSON.stringify({ routes: [{ agent: "active-directory", task: "t" }], confidence: 0.9, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } }; }
    }
    const model = new InspectingModel();
    await new ManagerRouter(model, registry, manager).selectAgents("AD question", ["active-directory", "network-observability"], {});
    const systemPrompt = model.request?.messages[0]?.content ?? "";
    expect(systemPrompt).not.toContain("active-directory");
    const userPayload = model.request?.messages.at(-1)?.content ?? "";
    expect(userPayload).toContain("active-directory");
    expect(userPayload).toContain("capabilities");
  });

  it("returns a distinct task per selected agent and enforces bounds", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "active-directory", task: "Check AD-side causes." }, { agent: "network-observability", task: "Check network path." }], confidence: 0.9, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const decision = await new ManagerRouter(model, registry, manager).selectAgents("auth failing from site B", ids, {});
    expect(decision.routes.map((route) => route.agent)).toEqual(["active-directory", "network-observability"]);
    expect(decision.routes[0]?.task).not.toEqual(decision.routes[1]?.task);
  });

  it("rejects unknown or unauthorized agent IDs", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "unknown", task: "x" }], confidence: 1, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    await expect(new ManagerRouter(model, registry, manager).selectAgents("unknown", ids, {})).rejects.toMatchObject({ code: "ROUTE_INVALID" });
  });
});
