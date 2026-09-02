import { describe, expect, it, vi } from "vitest";
import { engineError, runAgent, type Model, type ModelResponse, type Telemetry, type ToolCallRequest, type ToolCallResult } from "../src/index.ts";
import { evidenceIdFor } from "../src/tools/evidence.ts";
import {
  agentDefinition, answerAction, DeafToolProvider, dependencies, FIXTURE_TOOLS,
  FixtureToolProvider, RecordingTelemetry, runContext, ScriptedModel, toolCallAction, toolPolicy,
} from "./harness.ts";

const policy = toolPolicy();

/**
 * Findings from the independent review round (Codex + fresh-eyes adversarial
 * pass) over the hardening diff. Each test failed before its fix landed.
 */
describe("review round — containment", () => {
  it("sanitizes a live tool description before it reaches model context", async () => {
    const tools = new FixtureToolProvider({
      tools: FIXTURE_TOOLS.map((tool) => tool.name === "alpha_status"
        ? { ...tool, description: "Reads status. password=hunter2 and more" }
        : tool),
    });
    const model = new ScriptedModel([answerAction("done")]);
    await runAgent(agentDefinition(), policy, runContext("q"), dependencies(model, tools));
    const offered = model.requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.description)).join("\n");
    expect(offered).not.toContain("hunter2");
    expect(offered).toContain("[REDACTED:password]");
  });

  it("keeps engine-minted evidence ids citable under hostile component lengths", () => {
    const id = evidenceIdFor({ requestId: "r".repeat(300), serverId: "s".repeat(300), toolName: "t".repeat(300), arguments: { q: 1 } });
    // the envelope schema caps a cited id at 200 chars; an engine-minted id must always fit
    expect(id.length).toBeLessThanOrEqual(200);
    // identity still lives in the hash over the FULL components, not the readable prefix
    const other = evidenceIdFor({ requestId: "r".repeat(300), serverId: "s".repeat(300), toolName: `${"t".repeat(299)}x`, arguments: { q: 1 } });
    expect(other).not.toBe(id);
  });

  it("strips an oversized query rather than sinking the whole evidence item", async () => {
    const tools = new FixtureToolProvider();
    const budgets = { ...agentDefinition().budgets, maxEvidenceBytes: 2_000 };
    const longQ = "q".repeat(5_000);
    const result = await runAgent(agentDefinition({ budgets }), policy, runContext("q"), dependencies(new ScriptedModel([
      toolCallAction("docs_search", { q: longQ }),
      answerAction("done"),
    ]), tools));
    // the item survives, truncated and citable — never silently dropped
    expect(result.evidence.filter((item) => item.tool === "docs_search")).toHaveLength(1);
  });

  it("gives credential failures a stage-specific safe message", async () => {
    const credentials = { exchange: () => Promise.reject(engineError("AUTHN_FAILED", "idp internal detail")) };
    const result = await runAgent(agentDefinition(), policy, runContext("q"), {
      ...dependencies(new ScriptedModel([answerAction("done")]), new FixtureToolProvider({ requireCredential: true })),
      credentials,
    });
    const authn = (result.errors ?? []).find((error) => error.code === "AUTHN_FAILED");
    expect(authn).toBeDefined();
    expect(authn?.message).not.toMatch(/model provider/iu);
    expect(authn?.message).not.toContain("idp internal detail");
  });
});

describe("review round — liveness and honesty", () => {
  it("a synchronously-throwing model port resolves typed with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", capture);
    try {
      const model: Model = { chat(): Promise<ModelResponse> { throw engineError("MODEL_UNAVAILABLE", "sync boom"); } };
      const result = await runAgent(agentDefinition(), policy, runContext("q", Date.now() + 50), dependencies(model));
      expect(result.status).toBe("failed");
      // let a leaked deadline timer fire if cleanup were missing
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

  it("a throwing or hanging telemetry port cannot reject or stall the run", async () => {
    const hostile: Telemetry = {
      span: <T>() => new Promise<T>(() => { /* never settles, never runs the action */ }),
      counter: () => { throw new Error("counter boom"); },
    };
    const result = await runAgent(agentDefinition(), policy, runContext("q", Date.now() + 2_000), {
      ...dependencies(new ScriptedModel([answerAction("done")])),
      telemetry: hostile,
    });
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("done");
  }, 8_000);

  it("an adapter that mutates call arguments cannot poison the retry or the evidence", async () => {
    const received: unknown[] = [];
    class Mutating extends FixtureToolProvider {
      attempts = 0;
      override async invoke(call: ToolCallRequest): Promise<ToolCallResult> {
        this.attempts += 1;
        received.push(JSON.parse(JSON.stringify(call.arguments)));
        (call.arguments as Record<string, unknown>).q = { evil: true };
        if (this.attempts === 1) throw engineError("TOOL_TIMEOUT", "transient");
        return { content: { ok: true }, observedAt: new Date().toISOString() };
      }
    }
    const transientPolicy = { tools: toolPolicy().tools.map((tool) => tool.toolName === "docs_search" ? { ...tool, retryPolicy: "transient-once" as const } : tool) };
    const result = await runAgent(agentDefinition(), transientPolicy, runContext("q", Date.now() + 5_000), dependencies(new ScriptedModel([
      toolCallAction("docs_search", { q: "find" }),
      answerAction("done"),
    ]), new Mutating()));
    expect(received).toEqual([{ q: "find" }, { q: "find" }]);
    expect(result.evidence.find((item) => item.tool === "docs_search")?.query).toBe(JSON.stringify({ q: "find" }));
  });

  it("a tool stopped by the run deadline is never reported retryable", async () => {
    vi.useFakeTimers();
    try {
      const run = runAgent(agentDefinition(), policy, runContext("q", Date.now() + 100), dependencies(new ScriptedModel([toolCallAction("docs_search", { q: "x" })]), new DeafToolProvider("invoke")));
      await vi.advanceTimersByTimeAsync(200);
      const result = await run;
      expect((result.errors ?? []).length).toBeGreaterThanOrEqual(1);
      for (const error of result.errors ?? []) expect(error.retryable).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an interrupted run is explicitly ungrounded", async () => {
    vi.useFakeTimers();
    try {
      let turn = 0;
      const model: Model = {
        chat(): Promise<ModelResponse> {
          turn += 1;
          if (turn === 1) return Promise.resolve({ content: JSON.stringify(toolCallAction("docs_search", { q: "x" })) });
          return new Promise<ModelResponse>(() => { /* never settles */ });
        },
      };
      const run = runAgent(agentDefinition(), policy, runContext("q", Date.now() + 100), dependencies(model, new FixtureToolProvider()));
      await vi.advanceTimersByTimeAsync(200);
      const result = await run;
      expect(result.status).toBe("partial");
      expect(result.grounding).toEqual({ grounded: false, citedUsable: 0, usableEvidence: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an invalid provider timestamp instead of silently dropping it", async () => {
    class BadClock extends FixtureToolProvider {
      override async invoke(call: ToolCallRequest): Promise<ToolCallResult> {
        await super.invoke(call);
        return { content: { ok: true }, observedAt: "not-a-timestamp" };
      }
    }
    const telemetry = new RecordingTelemetry();
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(new ScriptedModel([
      toolCallAction("alpha_status", { target: "node-1", mode: "ok" }),
      answerAction("done"),
    ]), new BadClock(), telemetry));
    expect(result.evidence.find((item) => item.tool === "alpha_status")?.observedAt).toBeUndefined();
    expect(telemetry.counters).toContain("evidence.observed_at.invalid");
  });
});
