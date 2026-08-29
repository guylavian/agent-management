import { CONFIG_PATHS, deployEnvironmentDir, loadEffectiveAgentCatalog } from "@sre/config";
import { loadAgentInstance, type ManagerAgentConfig } from "@sre/config";
import type { ChatRequest, ChatResponse, ModelClient } from "@sre/llm";
import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { classifyIntent, extractEntities, managerRouteSchema, ManagerRouter } from "../src/index.ts";

const registry = loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("production") });
const manager = loadAgentInstance({ configFile: "config/agents/manager.yaml" }) as ManagerAgentConfig;
const ids = ["active-directory", "openshift", "network-observability"];

/**
 * Stage-1 keyword routing is gone.
 *
 * It matched exact phrases and regexes from each agent's config and chose a
 * specialist before any model was asked. What replaces it is described in the
 * Manager block below: the catalog is handed to the model as description, and
 * the model decides.
 *
 * What survives here is the part that was never about choosing an agent.
 */
describe("request context", () => {
  it("extracts a trusted entity from the question without choosing anyone", () => {
    // a hostname shape the platform uses everywhere, not a per-agent lexicon
    expect(extractEntities("Why is DC-TLV-01 intermittently slow?")).toMatchObject({ hostname: "DC-TLV-01" });
    expect(extractEntities("why is everything slow")).toEqual({});
  });

  it("classifies intent linguistically, which shapes the answer and not the routing", () => {
    expect(classifyIntent("Show current status", ["causal-question"])).toBe("diagnostic");
    expect(classifyIntent("Show current status")).toBe("factual");
  });
});

/**
 * A specialist becomes routable by being in the catalog and the Manager's
 * allowlist. There is no vocabulary to curate and no code to change — which is
 * the whole point of moving routing to the model.
 */
describe("onboarding", () => {
  it("offers a new specialist to the Manager from config alone", async () => {
    class InspectingModel implements ModelClient {
      readonly mode = "mock" as const;
      request?: ChatRequest;
      async chat(request: ChatRequest): Promise<ChatResponse> { this.request = request; return { content: JSON.stringify({ routes: [{ agent: "openshift", task: "Check the workload." }], confidence: 0.9, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } }; }
    }
    const model = new InspectingModel();
    await new ManagerRouter(model, registry, manager).selectAgents("Is the mailbox database mounted?", ids, {});
    const sent = JSON.parse((model.request?.messages.at(-1)?.content ?? "{}") as string) as { authorizedSpecialists: Array<{ id: string; capabilities?: string[] }> };

    // every authorized agent reaches the model with its own description; none of
    // them had to declare a phrase to be considered
    expect(sent.authorizedSpecialists.map(agent => agent.id).sort()).toEqual([...ids].sort());
    for (const agent of sent.authorizedSpecialists) expect(Object.keys(agent)).not.toContain("exactTerms");
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
    const responseSchema = model.request?.guidedJsonSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(new Set(responseSchema.required)).toEqual(new Set(Object.keys(responseSchema.properties ?? {})));
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

  /**
   * The provider validates the response against this schema DURING generation
   * and rejects the whole thing if a required field is missing. A model that
   * spends its budget on a long `task` never reaches `confidence`/`abstain`,
   * the call 400s, and the request fails with nothing routed. Bound what may be
   * generated; stay permissive about what may arrive.
   */
  it("asks the model for a shorter task than it is willing to accept", async () => {
    class InspectingModel implements ModelClient {
      readonly mode = "mock" as const;
      request?: ChatRequest;
      async chat(request: ChatRequest): Promise<ChatResponse> { this.request = request; return { content: JSON.stringify({ routes: [{ agent: "active-directory", task: "t" }], confidence: 0.9, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } }; }
    }
    const model = new InspectingModel();
    await new ManagerRouter(model, registry, manager).selectAgents("q", ids, {});
    const schema = model.request?.guidedJsonSchema as { properties: { routes: { items: { properties: { task: { maxLength: number } } } } } };
    const generated = schema.properties.routes.items.properties.task.maxLength;
    expect(generated).toBeLessThanOrEqual(400);

    // and the receiving schema still accepts a longer one, so a task written by
    // anything other than this prompt is not rejected at the boundary
    const received = managerRouteSchema.safeParse({ agent: "a", task: "x".repeat(generated + 100) });
    expect(received.success).toBe(true);
  });

  it("rejects unknown or unauthorized agent IDs", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "unknown", task: "x" }], confidence: 1, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    await expect(new ManagerRouter(model, registry, manager).selectAgents("unknown", ids, {})).rejects.toMatchObject({ code: "ROUTE_INVALID" });
  });

  /**
   * Withholding an agent from the catalog is not the same as refusing it.
   *
   * A disabled agent is authorized — the human may invoke it, the environment
   * simply is not running it. Checking the selection against the authorized set
   * would therefore wave it through the moment the model named it from context
   * or its own prior, and the request would be dispatched to a specialist that
   * is not deployed. The offered set is the only honest thing to check.
   */
  it("rejects an agent that is authorized but disabled in this environment", async () => {
    const localRegistry = loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("local") });
    expect(localRegistry.listEnabled().map(agent => agent.agentId)).not.toContain("keycloak");

    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "keycloak", task: "Check the realm." }], confidence: 1, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    await expect(
      new ManagerRouter(model, localRegistry, manager).selectAgents("realm question", [...ids, "keycloak"], {}),
    ).rejects.toMatchObject({ code: "ROUTE_INVALID" });
  });

  it("does not offer a disabled agent in the first place", async () => {
    const localRegistry = loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("local") });
    class InspectingModel implements ModelClient {
      readonly mode = "mock" as const;
      request?: ChatRequest;
      async chat(request: ChatRequest): Promise<ChatResponse> { this.request = request; return { content: JSON.stringify({ routes: [], confidence: 0.2, abstain: true }), usage: { promptTokens: 1, completionTokens: 1 } }; }
    }
    const model = new InspectingModel();
    await new ManagerRouter(model, localRegistry, manager).selectAgents("realm question", [...ids, "keycloak"], {});
    const sent = JSON.parse((model.request?.messages.at(-1)?.content ?? "{}") as string) as { authorizedSpecialists: Array<{ id: string }> };
    expect(sent.authorizedSpecialists.map(agent => agent.id)).not.toContain("keycloak");
  });
});
