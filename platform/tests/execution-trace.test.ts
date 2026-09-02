import { buildRunRecord, runRecordSchema, type SpecialistResultLike } from "@sre/runtime-host";
import type { RoutingTrace } from "@sre/orchestrator";
import { describe, expect, it } from "vitest";

/**
 * A run trace has to answer nine questions, and it has to refuse a tenth.
 *
 * The nine are the ones an operator actually opens it for: what was asked, who
 * was chosen, what each was told to do, what each tried, whether it was
 * allowed, what ran, what came back, whether there was a handoff, and why the
 * run ended as it did. Each has a test below.
 *
 * The tenth is "what was the model thinking", and the answer must stay no. The
 * last block holds that line: reasoning, payloads, arguments and credentials
 * are absent by construction, not by convention.
 */

const routing: RoutingTrace = {
  question: "Nobody in the Tel Aviv office can sign in this morning",
  offered: ["keycloak", "observability", "openshift"],
  selected: [
    { agent: "keycloak", task: "Check the sre-test realm for sign-in failures.", rationale: "Authentication issue requires the identity specialist." },
    { agent: "openshift", task: "Check cluster health.", rationale: "Rule out an infrastructure cause." },
  ],
  refused: [{ agent: "openshift", reason: "AUTHZ_DENIED" }],
  abstained: false,
  followup: { agent: "observability", reason: "NEEDS_TELEMETRY" },
};

const results: SpecialistResultLike[] = [
  {
    agentId: "keycloak",
    status: "complete",
    summary: "The realm is healthy.",
    needsHandoff: ["observability"],
    evidence: [
      { id: "ev-1", kind: "config", system: "keycloak", tool: "keycloak_health", status: "ok", citation: "tool://keycloak/keycloak_health?request=req-1", observedAt: "2026-08-29T10:00:02.000Z" },
      { id: "ev-2", kind: "missing", system: "prometheus", tool: "query", status: "denied" },
    ],
  },
  { agentId: "observability", status: "partial", evidence: [{ id: "ev-3", kind: "telemetry", system: "prometheus", tool: "list_targets", status: "ok" }] },
];

const build = (overrides: Partial<Parameters<typeof buildRunRecord>[0]> = {}) => buildRunRecord({
  requestId: "req-1",
  userSubjectHash: "a".repeat(64),
  environment: "lab",
  startedAt: new Date("2026-08-29T10:00:00.000Z"),
  durationMs: 2381,
  routedAgents: ["keycloak"],
  results,
  workloadFor: (agentId) => `sre-agent-${agentId}`,
  modelProfileFor: () => "tool-caller",
  status: "partial",
  evidenceCount: 3,
  synthesized: false,
  routing,
  outcomeReason: "degraded — synthesis: MODEL_RATE_LIMITED",
  ...overrides,
});

const find = (kind: string, predicate: (node: ReturnType<typeof build>["nodes"][number]) => boolean = () => true) =>
  build().nodes.find((node) => node.kind === kind && predicate(node));

describe("the trace answers what happened", () => {
  it("what did the user ask", () => {
    expect(build().question).toBe(routing.question);
    expect(find("user.request")?.detail).toBe(routing.question);
  });

  it("who did the Manager select, and why that one", () => {
    const specialist = find("specialist", (node) => node.agentId === "keycloak");
    expect(specialist?.metadata?.rationale).toBe("Authentication issue requires the identity specialist.");
  });

  it("what task did each agent receive", () => {
    expect(find("specialist", (node) => node.agentId === "keycloak")?.detail).toBe("Check the sre-test realm for sign-in failures.");
  });

  it("what did each agent try to do", () => {
    const requested = build().nodes.filter((node) => node.kind === "tool.request").map((node) => node.label);
    expect(requested).toContain("keycloak/keycloak_health");
    // the refused one is listed as an ATTEMPT, which is the point
    expect(requested).toContain("prometheus/query");
  });

  it("was it allowed", () => {
    expect(find("authorization.check", (node) => node.tool === "query")?.status).toBe("denied");
  });

  it("what tool actually ran", () => {
    const ran = build().nodes.filter((node) => node.kind === "toolhive.call").map((node) => node.label);
    expect(ran).toContain("keycloak/keycloak_health");
    expect(ran).not.toContain("prometheus/query");
  });

  it("what evidence came back", () => {
    const evidence = find("evidence", (node) => node.label.includes("ev-1"));
    expect(evidence?.metadata?.citation).toBe("tool://keycloak/keycloak_health?request=req-1");
    // the real observation time, not the run's start, so a timeline can order events
    expect(evidence?.startedAt).toBe("2026-08-29T10:00:02.000Z");
  });

  it("was there a handoff", () => {
    expect(find("domain.escalation")?.label).toBe("needs observability");
    expect(find("followup.route")?.metadata?.reason).toBe("NEEDS_TELEMETRY");
  });

  it("why did the run end as it did", () => {
    const completed = find("run.completed");
    expect(completed?.label).toBe("partial");
    expect(completed?.detail).toBe("degraded — synthesis: MODEL_RATE_LIMITED");
  });
});

describe("a selection the runtime refused is still recorded", () => {
  it("names the agent the Manager chose and the caller could not have", () => {
    // openshift produced no SpecialistResult, so without this node the trace
    // would be silent about it having ever been selected
    const refused = find("authorization.check", (node) => node.agentId === "openshift");
    expect(refused?.status).toBe("denied");
    expect(refused?.metadata?.reason).toBe("AUTHZ_DENIED");
    expect(build().nodes.some((node) => node.kind === "specialist" && node.agentId === "openshift")).toBe(false);
  });

  it("distinguishes a refusal from a timeout", () => {
    const timedOut = build({ results: [{ agentId: "keycloak", status: "partial", evidence: [{ id: "ev-t", kind: "missing", system: "keycloak", tool: "slow_call", status: "missing" }] }] });
    expect(timedOut.nodes.find((node) => node.kind === "toolhive.call" && node.tool === "slow_call")?.status).toBe("timeout");
    expect(timedOut.deniedToolCalls).toBe(0);
  });
});

describe("an agent's outcome is stated in the platform's own vocabulary", () => {
  const outcome = (result: SpecialistResultLike) => build({ results: [result], routedAgents: [result.agentId] }).nodes.find((node) => node.kind === "agent.result");

  it("reports insufficient_evidence when no summary was produced", () => {
    // this is the shape of a rate-limited answering turn: tools ran, evidence
    // exists, and the specialist still concluded nothing
    const node = outcome({ agentId: "keycloak", status: "partial", evidence: [{ id: "ev", kind: "config", system: "keycloak", tool: "keycloak_health", status: "ok" }] });
    expect(node?.label).toBe("insufficient_evidence");
    expect(node?.status).toBe("failed");
  });

  it("reports needs_domain when the specialist handed off", () => {
    expect(outcome({ agentId: "keycloak", status: "complete", summary: "s", needsHandoff: ["observability"], evidence: [] })?.label).toBe("needs_domain");
  });

  it("reports complete when a summary was produced", () => {
    expect(outcome({ agentId: "keycloak", status: "complete", summary: "The realm is healthy.", evidence: [] })?.label).toBe("complete");
  });

  it("reports the error code when the specialist failed", () => {
    const node = outcome({ agentId: "keycloak", status: "failed", evidence: [], errors: [{ code: "AGENT_TIMEOUT", message: "A specialist service timed out" }] });
    expect(node?.label).toBe("failed");
    expect(node?.detail).toContain("AGENT_TIMEOUT");
  });
});

describe("the trace records decisions and actions, never reasoning or payloads", () => {
  it("does not carry the specialist's summary text", () => {
    // "The realm is healthy." is the ANSWER; the trace says a summary exists
    expect(JSON.stringify(build())).not.toContain("The realm is healthy.");
  });

  it("refuses a non-scalar in metadata, so a payload cannot be attached", () => {
    const run = build();
    const forged = { ...run, nodes: [{ ...run.nodes[0], metadata: { payload: { rows: [1, 2, 3] } } }] };
    expect(() => runRecordSchema.parse(forged)).toThrow();
  });

  it("holds the whole record to the schema, so no field can be smuggled in", () => {
    const run = build();
    expect(() => runRecordSchema.parse({ ...run, rawAnswer: "…" })).toThrow();
    expect(() => runRecordSchema.parse(run)).not.toThrow();
  });

  it("survives a caller that reports no routing at all", () => {
    // the orchestrator reports best-effort; a trace that threw here would turn
    // an observability gap into a failed request
    const run = build({ routing: undefined });
    expect(run.question).toBeUndefined();
    expect(run.nodes.find((node) => node.kind === "user.request")?.label).toBe("question not recorded");
    expect(() => runRecordSchema.parse(run)).not.toThrow();
  });

  it("cuts a long question with a visible marker rather than silently", () => {
    const long = "x".repeat(3_000);
    const run = build({ routing: { ...routing, question: long } });
    expect(run.question).toHaveLength(2_000);
    expect(run.question?.endsWith("…")).toBe(true);
  });
});
