import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { engineError, runAgent } from "../src/index.ts";
import {
  FlakyModel, RecordingTelemetry, ScriptedModel, agentDefinition, answerAction,
  dependencies, evidenceId, runContext, toolCallAction, toolPolicy, FixtureToolProvider,
  DeafModel, DeafToolProvider, DeafCredentialProvider, ALICE,
} from "./harness.ts";

const policy = toolPolicy();
const docsArgs = { q: "documented procedure" };
const script = [toolCallAction("docs_search", docsArgs), answerAction("Per docs.", [evidenceId("docs_search", docsArgs)])];

describe("model failure handling", () => {
  it("retries ONE transient model failure and completes the run", async () => {
    const model = new FlakyModel(1, "MODEL_RATE_LIMITED", script);
    const telemetry = new RecordingTelemetry();
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(model, undefined, telemetry));
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("Per docs.");
    expect(telemetry.counters.filter((name) => name === "model.retries")).toHaveLength(1);
  });

  it("fails with the REAL cause after the single retry is spent — never a third attempt", async () => {
    const model = new FlakyModel(99, "MODEL_RATE_LIMITED", script);
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(model));
    expect(model.attempts).toBe(2);
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((error) => error.code)).toContain("MODEL_RATE_LIMITED");
  });

  it("keeps MODEL_UNAVAILABLE distinct from MODEL_TIMEOUT", async () => {
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(new FlakyModel(99, "MODEL_UNAVAILABLE", script)));
    expect((result.errors ?? []).map((error) => error.code)).toContain("MODEL_UNAVAILABLE");
    expect((result.errors ?? []).map((error) => error.code)).not.toContain("MODEL_TIMEOUT");
  });

  it("treats an empty model response as invalid output and retries once", async () => {
    // first turn proposes nothing at all; the retry answers properly
    const inner = new ScriptedModel([answerAction("Recovered.")]);
    let calls = 0;
    const model = { async chat(request: never) { calls += 1; return calls === 1 ? { content: "  " } : inner.chat(request); } };
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(model as never));
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("Recovered.");
  });

  it("produces a grounded degraded result when evidence exists but the model then dies", async () => {
    // turn 1 gathers evidence, turn 2 (and its retry) fail
    const model = new FlakyModel(0, "MODEL_UNAVAILABLE", [toolCallAction("docs_search", docsArgs)]);
    let turns = 0;
    const dying = { async chat(request: never) { turns += 1; if (turns > 1) throw Object.assign(new Error("boom"), { code: "MODEL_UNAVAILABLE" }); return model.chat(request); } };
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(dying as never));
    // partial, not failed: the evidence gathered before the failure survives
    expect(result.status).toBe("partial");
    expect((result.errors ?? []).map((error) => error.code)).toContain("MODEL_UNAVAILABLE");
    // the summary reports the interruption and cites the evidence; it claims nothing beyond it
    expect(result.summary).toMatch(/interrupted \(MODEL_UNAVAILABLE\)/u);
    expect(result.summary).toMatch(/1 evidence item/u);
    expect(result.evidence).toHaveLength(1);
  });

  it("never retries a deadline expiry — REQUEST_TIMEOUT is not a model fault", async () => {
    const model = new FlakyModel(99, "REQUEST_TIMEOUT", script);
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(model));
    expect(model.attempts).toBe(1);
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((error) => error.code)).toContain("REQUEST_TIMEOUT");
  });
});

describe("budget validation", () => {
  it("rejects Infinity in maxToolCalls with INVALID_BUDGET before any port invoked", async () => {
    const model = new ScriptedModel([toolCallAction("docs_search", docsArgs)]);
    const tools = new FixtureToolProvider();
    const agent = agentDefinition({ budgets: { ...agentDefinition().budgets, maxToolCalls: Infinity } });
    const result = await runAgent(agent, policy, runContext("q"), dependencies(model, tools));
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((e) => e.code)).toContain("INVALID_BUDGET");
    expect(model.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });

  it("rejects NaN in maxModelTurns with INVALID_BUDGET before any port invoked", async () => {
    const model = new ScriptedModel([toolCallAction("docs_search", docsArgs)]);
    const tools = new FixtureToolProvider();
    const agent = agentDefinition({ budgets: { ...agentDefinition().budgets, maxModelTurns: NaN } });
    const result = await runAgent(agent, policy, runContext("q"), dependencies(model, tools));
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((e) => e.code)).toContain("INVALID_BUDGET");
    expect(model.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });

  it("rejects -1 in timeoutMs with INVALID_BUDGET before any port invoked", async () => {
    const model = new ScriptedModel([toolCallAction("docs_search", docsArgs)]);
    const tools = new FixtureToolProvider();
    const agent = agentDefinition({ budgets: { ...agentDefinition().budgets, timeoutMs: -1 } });
    const result = await runAgent(agent, policy, runContext("q"), dependencies(model, tools));
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((e) => e.code)).toContain("INVALID_BUDGET");
    expect(model.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });

  it("rejects 1.5 in maxEvidenceBytes with INVALID_BUDGET before any port invoked", async () => {
    const model = new ScriptedModel([toolCallAction("docs_search", docsArgs)]);
    const tools = new FixtureToolProvider();
    const agent = agentDefinition({ budgets: { ...agentDefinition().budgets, maxEvidenceBytes: 1.5 } });
    const result = await runAgent(agent, policy, runContext("q"), dependencies(model, tools));
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((e) => e.code)).toContain("INVALID_BUDGET");
    expect(model.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });

  it("rejects string budget value with INVALID_BUDGET before any port invoked", async () => {
    const model = new ScriptedModel([toolCallAction("docs_search", docsArgs)]);
    const tools = new FixtureToolProvider();
    const agent = agentDefinition({ budgets: { ...agentDefinition().budgets, maxContextTokens: "6" as unknown as number } });
    const result = await runAgent(agent, policy, runContext("q"), dependencies(model, tools));
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((e) => e.code)).toContain("INVALID_BUDGET");
    expect(model.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });

  it("accepts maxEvidenceItems: 0 as a valid budget", async () => {
    const model = new ScriptedModel([answerAction("OK")]);
    const agent = agentDefinition({ budgets: { ...agentDefinition().budgets, maxEvidenceItems: 0 } });
    const result = await runAgent(agent, policy, runContext("q"), dependencies(model));
    expect(result.status).toBe("complete");
    expect((result.errors ?? []).filter((e) => e.code === "INVALID_BUDGET")).toHaveLength(0);
  });

  it("rejects infinite deadline with INVALID_BUDGET before any port invoked", async () => {
    const model = new ScriptedModel([toolCallAction("docs_search", docsArgs)]);
    const tools = new FixtureToolProvider();
    const result = await runAgent(agentDefinition(), policy, runContext("q", Infinity), dependencies(model, tools));
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((e) => e.code)).toContain("INVALID_BUDGET");
    expect(model.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });

  it("rejects NaN deadline with INVALID_BUDGET before any port invoked", async () => {
    const model = new ScriptedModel([toolCallAction("docs_search", docsArgs)]);
    const tools = new FixtureToolProvider();
    const result = await runAgent(agentDefinition(), policy, runContext("q", NaN), dependencies(model, tools));
    expect(result.status).toBe("failed");
    expect((result.errors ?? []).map((e) => e.code)).toContain("INVALID_BUDGET");
    expect(model.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });

  it("stops the loop when model reports usage exceeding maxContextTokens", async () => {
    let turn = 0;
    const model = {
      async chat(): Promise<any> {
        turn += 1;
        return { content: "answer", usage: { promptTokens: 20000, completionTokens: 100 } };
      },
    };
    const agent = agentDefinition({ budgets: { ...agentDefinition().budgets, maxContextTokens: 8000 } });
    const result = await runAgent(agent, policy, runContext("q"), dependencies(model as never));
    expect(result.summary).toMatch(/Context budget exhausted/u);
    expect(turn).toBe(1);
  });

  describe("H1 — deadlines: racing withDeadline, setup under deadline", () => {
    it("never-settling model.chat times out at deadline with REQUEST_TIMEOUT (fake timers)", async () => {
      vi.useFakeTimers();
      try {
        const result = await Promise.race([
          runAgent(agentDefinition(), policy, runContext("q", Date.now() + 100), dependencies(new DeafModel())),
          (async () => { await vi.advanceTimersByTimeAsync(150); })(),
        ]);
        expect(result?.status).toBe("failed");
        expect((result?.errors ?? []).map((e) => e.code)).toContain("REQUEST_TIMEOUT");
      } finally {
        vi.useRealTimers();
      }
    });

    it("never-settling listTools (discovery) times out at deadline with REQUEST_TIMEOUT (fake timers)", async () => {
      vi.useFakeTimers();
      try {
        const tools = new DeafToolProvider("list");
        const result = await Promise.race([
          runAgent(agentDefinition(), policy, runContext("q", Date.now() + 100), dependencies(new ScriptedModel([answerAction("done")]), tools)),
          (async () => { await vi.advanceTimersByTimeAsync(150); })(),
        ]);
        expect(result?.status).toBe("failed");
        expect((result?.errors ?? []).map((e) => e.code)).toContain("REQUEST_TIMEOUT");
      } finally {
        vi.useRealTimers();
      }
    });

    it("never-settling exchange (credential provider) times out at deadline with REQUEST_TIMEOUT (fake timers)", async () => {
      vi.useFakeTimers();
      try {
        const creds = new DeafCredentialProvider();
        const tools = new FixtureToolProvider({ requireCredential: true });
        const result = await Promise.race([
          runAgent(agentDefinition(), policy, runContext("q", Date.now() + 100), dependencies(new ScriptedModel([answerAction("done")]), tools, undefined, undefined, creds)),
          (async () => { await vi.advanceTimersByTimeAsync(150); })(),
        ]);
        expect(result?.status).toBe("failed");
        expect((result?.errors ?? []).map((e) => e.code)).toContain("REQUEST_TIMEOUT");
      } finally {
        vi.useRealTimers();
      }
    });

    it("never-settling tool invoke times out at deadline with REQUEST_TIMEOUT (fake timers)", async () => {
      vi.useFakeTimers();
      try {
        const tools = new DeafToolProvider("invoke");
        const result = await Promise.race([
          runAgent(agentDefinition(), policy, runContext("q", Date.now() + 100), dependencies(new ScriptedModel([toolCallAction("docs_search", { q: "test" })]), tools)),
          (async () => { await vi.advanceTimersByTimeAsync(150); })(),
        ]);
        // the timed-out call leaves its failure evidence behind, so the run is
        // partial — the deadline still terminated it and is recorded
        expect(result?.status).toBe("partial");
        expect((result?.errors ?? []).map((e) => e.code)).toContain("REQUEST_TIMEOUT");
      } finally {
        vi.useRealTimers();
      }
    });

    it("deadline > 2^31 ms does NOT spuriously abort", async () => {
      // Timer delay clamped to Math.min(remaining, 2**31 - 1) so very large deadline doesn't overflow
      const veryLargeDeadline = Date.now() + (2 ** 32); // larger than 2^31 ms
      const result = await runAgent(agentDefinition(), policy, runContext("q", veryLargeDeadline), dependencies(new ScriptedModel([answerAction("Done.")])));
      expect(result.status).toBe("complete");
      expect(result.summary).toBe("Done.");
    });

    it("run-deadline expiry during a transient tool failure is not retried", async () => {
      vi.useFakeTimers();
      try {
        let invokes = 0;
        class SlowFailing extends FixtureToolProvider {
          override async invoke(): Promise<never> {
            invokes += 1;
            // consumes the whole run deadline before failing transiently
            await new Promise((resolve) => setTimeout(resolve, 30));
            throw engineError("MCP_TIMEOUT", "backend timeout");
          }
        }
        const transientPolicy = { tools: toolPolicy().tools.map((tool) => tool.toolName === "docs_search" ? { ...tool, retryPolicy: "transient-once" as const } : tool) };
        const run = runAgent(agentDefinition(), transientPolicy, runContext("q", Date.now() + 20), dependencies(new ScriptedModel([toolCallAction("docs_search", docsArgs), answerAction("done")]), new SlowFailing()));
        await vi.advanceTimersByTimeAsync(100);
        const result = await run;
        // the run deadline expired during attempt 1: a "transient" code must not earn attempt 2
        expect(invokes).toBe(1);
        expect((result.errors ?? []).map((e) => e.code)).toContain("REQUEST_TIMEOUT");
      } finally {
        vi.useRealTimers();
      }
    });

    it("pre-expired deadline → typed failure with no port invoked", async () => {
      const model = new ScriptedModel([toolCallAction("docs_search", { q: "test" })]);
      const tools = new FixtureToolProvider();
      const result = await runAgent(agentDefinition(), policy, runContext("q", Date.now() - 100), dependencies(model, tools));
      expect(result.status).toBe("failed");
      expect((result.errors ?? []).map((e) => e.code)).toContain("REQUEST_TIMEOUT");
      expect(model.requests).toHaveLength(0);
      expect(tools.calls).toHaveLength(0);
    });
  });
});
