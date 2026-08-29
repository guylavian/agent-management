import type { ChatRequest, ChatResponse, ModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { diagnoseRun, PROMPT_ASSIST_PROFILE, renderRun, RunDiagnosisError } from "../src/management/index.ts";
import type { RunRecord } from "../src/management/index.ts";

class Recorder implements ModelClient {
  readonly mode = "mock" as const;
  request?: ChatRequest;
  readonly reply?: string;
  constructor(reply?: string) { this.reply = reply; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.request = request;
    return { ...(this.reply === undefined ? {} : { content: this.reply }), usage: { promptTokens: 1, completionTokens: 1 } };
  }
}

const run: RunRecord = {
  requestId: "req-1",
  startedAt: "2026-08-29T20:00:00.000Z",
  durationMs: 8100,
  status: "partial",
  question: "Are any pods restarting in the sre-assistant namespace?",
  userSubjectHash: "a".repeat(64),
  environment: "poc",
  agents: ["openshift"],
  workloads: ["sre-agent-openshift"],
  toolCalls: 1,
  deniedToolCalls: 0,
  evidenceCount: 1,
  modelProfiles: ["manager-router", "tool-caller"],
  nodes: [
    { id: "root", kind: "user.request", label: "question received", status: "ok", startedAt: "2026-08-29T20:00:00.000Z", durationMs: 0, actor: "user" },
    { id: "route", kind: "manager.route", label: "routed to openshift", status: "ok", startedAt: "2026-08-29T20:00:01.000Z", durationMs: 900, actor: "manager", detail: "current workload state" },
    { id: "call", kind: "toolhive.call", label: "pods_list", status: "failed", startedAt: "2026-08-29T20:00:02.000Z", durationMs: 40, actor: "runtime", agentId: "openshift", mcp: "kubernetes", tool: "pods_list" },
  ],
};

describe("reading a run trace with a model", () => {
  it("sends the trace and nothing else, on the console-assistance profile", async () => {
    const model = new Recorder("The run routed to openshift and its first tool call failed.");
    await diagnoseRun(model, run);

    // an Agent's own profile is bound to what that Agent may reason over;
    // reading a trace is a management-plane concern and is bound separately
    expect(model.request?.model).toBe(PROMPT_ASSIST_PROFILE);
    // no tool schema travels with it — the diagnosis cannot call anything
    expect(model.request?.tools).toBeUndefined();

    const sent = model.request?.messages.at(-1)?.content ?? "";
    expect(sent).toContain("pods_list");
    expect(sent).toContain("status: partial");
    // the hashed initiator is in the record but is not a fact about the run
    expect(sent).not.toContain(run.userSubjectHash);
  });

  it("refuses an empty answer rather than showing a blank diagnosis", async () => {
    await expect(diagnoseRun(new Recorder(), run)).rejects.toBeInstanceOf(RunDiagnosisError);
    await expect(diagnoseRun(new Recorder("   "), run)).rejects.toBeInstanceOf(RunDiagnosisError);
  });

  it("orders the trace by time, so the earliest failure is the first one visible", () => {
    const shuffled: RunRecord = { ...run, nodes: [...run.nodes].reverse() };
    const rendered = renderRun(shuffled);
    expect(rendered.indexOf("user.request")).toBeLessThan(rendered.indexOf("manager.route"));
    expect(rendered.indexOf("manager.route")).toBeLessThan(rendered.indexOf("toolhive.call"));
  });
});
