import { describe, expect, it } from "vitest";
import { runAgent, type CredentialProvider, type ToolCredential } from "../src/index.ts";
import { agentDefinition, ALICE, answerAction, dependencies, FixtureToolProvider, RecordingTelemetry, runContext, ScriptedModel, toolCallAction, toolPolicy } from "./harness.ts";

const policy = toolPolicy();

class RecordingExchanger implements CredentialProvider {
  readonly exchanges: Array<{ audience: string; workloadClientId?: string; subject: string }> = [];
  readonly #fail: Set<string>;
  constructor(failAudiences: string[] = []) { this.#fail = new Set(failAudiences); }
  async exchange(workload: { clientId: string; provider: string } | undefined, principal: typeof ALICE, audience: string, _deadline: number): Promise<ToolCredential> {
    if (this.#fail.has(audience)) throw new Error("exchange failed");
    this.exchanges.push({ audience, workloadClientId: workload?.clientId, subject: principal.subject });
    return { token: `token-for-${audience}`, audience, workloadClientId: workload?.clientId ?? "none" };
  }
}

describe("credential lifecycle", () => {
  it("obtains one credential per configured server before discovery", async () => {
    const exchanger = new RecordingExchanger();
    const tools = new FixtureToolProvider({ requireCredential: true });
    const result = await runAgent(agentDefinition(), policy, runContext("q"), { ...dependencies(new ScriptedModel([answerAction("done")]), tools), credentials: exchanger });
    expect(exchanger.exchanges.map((item) => item.audience).sort()).toEqual(["resource:alpha", "resource:docs"]);
    expect(result.status).toBe("complete");
  });

  it("presents each server the credential bound to that server's audience", async () => {
    const tools = new FixtureToolProvider({ requireCredential: true });
    await runAgent(agentDefinition(), policy, runContext("q"), { ...dependencies(new ScriptedModel([toolCallAction("alpha_status", { target: "node-1" }), answerAction("done")]), tools), credentials: new RecordingExchanger() });
    expect(tools.calls[0]?.credential?.audience).toBe("resource:alpha");
  });

  it("carries the Agent's workload identity, distinct from the delegated subject", async () => {
    const exchanger = new RecordingExchanger();
    await runAgent(agentDefinition(), policy, runContext("q"), { ...dependencies(new ScriptedModel([answerAction("done")])), credentials: exchanger });
    expect(exchanger.exchanges[0]).toMatchObject({ workloadClientId: "workload-alpha", subject: "alice" });
  });

  it("lets a failed exchange remove one server's tools rather than failing the run", async () => {
    const tools = new FixtureToolProvider({ requireCredential: true });
    const model = new ScriptedModel([answerAction("done")]);
    const result = await runAgent(agentDefinition(), policy, runContext("q"), { ...dependencies(model, tools), credentials: new RecordingExchanger(["resource:docs"]) });
    const offered = (model.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(offered).toEqual(expect.arrayContaining(["alpha_status", "alpha_health"]));
    expect(offered).not.toContain("docs_search");
    expect(result.status).toBe("complete");
  });

  it("never records a token in a span attribute", async () => {
    const telemetry = new RecordingTelemetry();
    await runAgent(agentDefinition(), policy, runContext("q"), { ...dependencies(new ScriptedModel([toolCallAction("alpha_status", { target: "node-1" }), answerAction("done")]), new FixtureToolProvider(), telemetry), credentials: new RecordingExchanger() });
    const serialized = JSON.stringify(telemetry.spans);
    expect(serialized).not.toContain("token-for-");
    expect(serialized).toContain("resource:alpha");
    expect(telemetry.spans.some((span) => span.name === "workload.token")).toBe(true);
  });

  it("never places the raw subject in a span attribute", async () => {
    const telemetry = new RecordingTelemetry();
    await runAgent(agentDefinition(), policy, runContext("q"), dependencies(new ScriptedModel([answerAction("done")]), new FixtureToolProvider(), telemetry));
    const execute = telemetry.spans.find((span) => span.name === "agent.alpha-agent.execute");
    expect(execute?.attributes["user.subject_hash"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(telemetry.spans)).not.toContain('"alice"');
  });

  it("denies a server whose access entry declares no audience when credentials are in use", async () => {
    const agent = agentDefinition({ access: [{ server: "alpha", tools: ["alpha_status"] }] });
    const tools = new FixtureToolProvider();
    const result = await runAgent(agent, policy, runContext("q"), { ...dependencies(new ScriptedModel([toolCallAction("alpha_status", { target: "node-1" }), answerAction("done")]), tools), credentials: new RecordingExchanger() });
    expect(tools.calls).toHaveLength(0);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TOOL_DENIED" })]));
  });

  it("runs without a credential provider at all", async () => {
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(new ScriptedModel([toolCallAction("alpha_status", { target: "node-1" }), answerAction("done")])));
    expect(result.status).toBe("complete");
  });
});
