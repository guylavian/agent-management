import { describe, expect, it, vi } from "vitest";
import type { SpecialistResult } from "@sre/evidence";
import { deterministicResponseBuilder, deterministicMultiSpecialistResponse } from "../src/synthesis/deterministic-response.ts";
import type { ExecutionContext } from "../src/types.ts";

const ctx = { requestId: "req-1" } as ExecutionContext;

describe("multi-specialist response handling", () => {
  it("includes all specialists' summaries when multiple return evidence", () => {
    const results: SpecialistResult[] = [
      {
        agentId: "agent-a", status: "complete",
        summary: "Agent A found X",
        evidence: [{ id: "e1", kind: "telemetry", source: "sys-a", system: "app", environment: "prod", payload: { ok: true }, citation: "tool://a", status: "ok", requestId: "req-1", agentId: "agent-a" }],
      },
      {
        agentId: "agent-b", status: "complete",
        summary: "Agent B found Y",
        evidence: [{ id: "e2", kind: "telemetry", source: "sys-b", system: "app", environment: "prod", payload: { ok: true }, citation: "tool://b", status: "ok", requestId: "req-1", agentId: "agent-b" }],
      },
    ];
    const response = deterministicMultiSpecialistResponse(ctx, results, "SOME_REASON");
    expect(response.answer).toContain("Agent A found X");
    expect(response.answer).toContain("Agent B found Y");
    expect(response.citations).toHaveLength(2);
    expect(response.metadata.routedAgents).toEqual(["agent-a", "agent-b"]);
  });

  it("includes second specialist even when first has no evidence", () => {
    const results: SpecialistResult[] = [
      {
        agentId: "agent-a", status: "complete",
        summary: "Agent A found nothing",
        evidence: [],
      },
      {
        agentId: "agent-b", status: "complete",
        summary: "Agent B found Y",
        evidence: [{ id: "e2", kind: "telemetry", source: "sys-b", system: "app", environment: "prod", payload: { ok: true }, citation: "tool://b", status: "ok", requestId: "req-1", agentId: "agent-b" }],
      },
    ];
    const response = deterministicMultiSpecialistResponse(ctx, results, "SOME_REASON");
    expect(response.answer).toContain("Agent A found nothing");
    expect(response.answer).toContain("Agent B found Y");
    expect(response.citations).toHaveLength(1);
    expect(response.metadata.routedAgents).toEqual(["agent-a", "agent-b"]);
  });
});
