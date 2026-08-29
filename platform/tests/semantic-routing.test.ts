import { readFileSync, readdirSync } from "node:fs";
import { loadAgentInstance, loadEffectiveAgentCatalog, CONFIG_PATHS, deployEnvironmentDir, type ManagerAgentConfig } from "@sre/config";
import { MockModelClient, type ChatRequest, type ChatResponse, type ModelClient } from "@sre/llm";
import { ManagerRouter } from "@sre/orchestrator";
import { describe, expect, it } from "vitest";

/**
 * Routing is a judgement; authorization is not.
 *
 * The Manager decides WHO should investigate and WHAT each specialist is asked.
 * Everything about whether that may actually happen is decided by code, and
 * these tests exist to keep that line where it is — the model proposes, and no
 * proposal it can make widens what the caller is entitled to.
 */

const registry = loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("production") });
const manager = loadAgentInstance({ configFile: "config/agents/manager.yaml" }) as ManagerAgentConfig;

class Recorder implements ModelClient {
  readonly mode = "mock" as const;
  request?: ChatRequest;
  readonly #answer: unknown;
  constructor(answer: unknown) { this.#answer = answer; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.request = request;
    return { content: JSON.stringify(this.#answer), usage: { promptTokens: 1, completionTokens: 1 } };
  }
}

const sent = (model: Recorder) =>
  JSON.parse((model.request?.messages.at(-1)?.content ?? "{}") as string) as {
    question: string;
    authorizedSpecialists: Array<{ id: string; description?: string; capabilities?: string[]; exclusions?: string[] }>;
  };

describe("the Manager is given a catalog, not a lexicon", () => {
  it("hands over description, capabilities and exclusions — and nothing to match on", async () => {
    const model = new Recorder({ routes: [{ agent: "active-directory", task: "t" }], confidence: 0.9, abstain: false });
    await new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory", "observability"], {});

    const catalog = sent(model).authorizedSpecialists;
    expect(catalog.length).toBeGreaterThan(1);
    for (const entry of catalog) {
      expect(entry.id).toBeTruthy();
      // the fields a keyword router needed are gone from the wire entirely
      for (const removed of ["exactTerms", "entityPatterns", "ambiguousTerms"]) {
        expect(Object.keys(entry)).not.toContain(removed);
      }
    }
    // exclusions travel, so the Manager can rule an agent OUT on meaning
    expect(catalog.some(entry => (entry.exclusions ?? []).length > 0)).toBe(true);
    expect(catalog.some(entry => (entry.capabilities ?? []).length > 0)).toBe(true);
  });

  it("names no specialist in the system prompt, so onboarding one needs no prompt edit", async () => {
    const model = new Recorder({ routes: [{ agent: "active-directory", task: "t" }], confidence: 0.9, abstain: false });
    await new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory"], {});
    const system = model.request?.messages[0]?.content ?? "";
    for (const id of registry.listEnabled().map(agent => agent.agentId)) {
      expect(system, `the prompt hardcodes ${id}`).not.toContain(id);
    }
  });

  it("carries no tool schema: the Manager routes and never calls anything", async () => {
    const model = new Recorder({ routes: [{ agent: "active-directory", task: "t" }], confidence: 0.9, abstain: false });
    await new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory"], {});
    expect(model.request?.tools).toBeUndefined();
    expect(JSON.stringify(model.request)).not.toMatch(/allowedTools|audience|clientSecret/u);
  });
});

describe("no answer the model can give widens what may run", () => {
  const route = (agents: string[]) => ({ routes: agents.map(agent => ({ agent, task: "t" })), confidence: 1, abstain: false });

  it("refuses an agent that was not offered, however confident the model is", async () => {
    const model = new Recorder({ ...route(["openshift"]), confidence: 1 });
    // openshift exists but was not offered to this caller, so the refusal says
    // DISABLED_AGENT rather than pretending the name is unknown
    await expect(new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory"], {}))
      .rejects.toMatchObject({ code: "DISABLED_AGENT" });
  });

  it("refuses an agent that does not exist", async () => {
    const model = new Recorder(route(["not-a-real-agent"]));
    await expect(new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory"], {}))
      .rejects.toMatchObject({ code: "UNKNOWN_AGENT" });
  });

  it("refuses more specialists than the Manager's own fan-out bound", async () => {
    const offered = registry.listEnabled().map(agent => agent.agentId);
    const tooMany = offered.slice(0, manager.spec.execution.maxAgentsPerRequest + 1);
    expect(tooMany.length).toBeGreaterThan(manager.spec.execution.maxAgentsPerRequest);

    const model = new Recorder(route(tooMany));
    await expect(new ManagerRouter(model, registry, manager).selectAgents("q", offered, {}))
      .rejects.toMatchObject({ code: "ROUTE_INVALID" });
  });

  it("refuses the same specialist twice, which would double its budget", async () => {
    const model = new Recorder(route(["active-directory", "active-directory"]));
    await expect(new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory"], {}))
      .rejects.toMatchObject({ code: "ROUTE_INVALID" });
  });

  it("refuses an answer that is not the agreed shape", async () => {
    const model = new Recorder({ routes: "everyone", confidence: "high" });
    await expect(new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory"], {})).rejects.toThrow();
  });

  it("passes the deadline signal through, so routing cannot outlive the request", async () => {
    const controller = new AbortController();
    const model = new Recorder(route(["active-directory"]));
    await new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory"], {}, controller.signal);
    expect(model.request?.signal).toBe(controller.signal);
  });
});

describe("abstention is an answer, not a failure", () => {
  it("is carried through rather than turned into a route", async () => {
    const model = new Recorder({ routes: [], confidence: 0.2, alternates: ["active-directory", "observability"], abstain: true });
    const decision = await new ManagerRouter(model, registry, manager).selectAgents("something vague", ["active-directory", "observability"], {});
    expect(decision.abstain).toBe(true);
    expect(decision.routes).toEqual([]);
  });

  it("holds alternates to the same offered set as routes", async () => {
    const model = new Recorder({ routes: [], confidence: 0.2, alternates: ["openshift"], abstain: true });
    await expect(new ManagerRouter(model, registry, manager).selectAgents("q", ["active-directory"], {}))
      .rejects.toMatchObject({ code: "DISABLED_AGENT" });
  });
});

describe("a specialist never reaches another specialist directly", () => {
  it("has no transport to one: the only path back is the Manager's allowlist", () => {
    // planFollowup is the whole cross-domain path, and it checks the MANAGER's
    // allowlist, the requesting agent's own grant, and the caller's roles before
    // a second specialist runs. `orchestrator/tests/followup.test.ts` exercises
    // each rejection; what is asserted here is that the config makes it possible
    // for one to exist at all, so those tests are not vacuous.
    const withGrants = registry.listEnabled().filter(agent => agent.allowedNeedsDomains.length > 0);
    expect(withGrants.length).toBeGreaterThan(0);
    for (const agent of withGrants) {
      for (const target of agent.allowedNeedsDomains) {
        // a grant names a domain; it does not name an endpoint, a credential or
        // a transport, because the Manager performs the call
        expect(typeof target).toBe("string");
        expect(registry.mayRequestDomain(agent.agentId, target)).toBe(true);
      }
    }
    expect(registry.mayRequestDomain("active-directory", "openshift")).toBe(false);
  });
});

describe("routing needs no vocabulary maintenance", () => {
  it("offers every enabled specialist even when the question shares no word with any of them", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "active-directory", task: "Investigate sign-in failures." }], confidence: 0.8, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const offered = registry.listEnabled().map(agent => agent.agentId);
    const decision = await new ManagerRouter(model, registry, manager).selectAgents("nobody in the Tel Aviv office can sign in", offered, {});
    // the old keyword stage would have matched nothing in that sentence
    expect(decision.routes.map(route => route.agent)).toEqual(["active-directory"]);
  });

  /**
   * A structural guard, because the tempting fix for a mis-route is always the
   * same: special-case it. One `if (question.includes(...))` in this module and
   * routing is no longer semantic — it is semantic EXCEPT for the cases someone
   * decided in code, which is the worst of both and invisible from the outside.
   *
   * The routing module may not name a specialist at all. Every agent it knows
   * arrives from the catalog at runtime.
   */
  it("names no specialist anywhere in the routing module", () => {
    const specialists = registry.listEnabled().map(agent => agent.agentId);
    expect(specialists.length).toBeGreaterThan(0);
    const dir = "orchestrator/src/routing";
    for (const file of readdirSync(dir).filter(name => name.endsWith(".ts"))) {
      const source = readFileSync(`${dir}/${file}`, "utf8");
      for (const id of specialists) expect(source, `${file} names ${id}`).not.toContain(id);
    }
  });
});
