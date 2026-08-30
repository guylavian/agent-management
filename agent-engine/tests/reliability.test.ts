import { describe, expect, it } from "vitest";
import { runAgent } from "../src/runner/run.ts";
import {
  FlakyModel, RecordingTelemetry, ScriptedModel, agentDefinition, answerAction,
  dependencies, evidenceId, runContext, toolCallAction, toolPolicy,
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
