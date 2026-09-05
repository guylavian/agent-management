import { describe, expect, it } from "vitest";
import type { SpecialistResult } from "@sre/evidence";
import { deterministicResponseBuilder } from "../src/synthesis/deterministic-response.ts";
import type { ExecutionContext } from "../src/types.ts";

const ctx = { requestId: "req-1" } as ExecutionContext;

describe("deterministic degraded responses", () => {
  it("exposes the specialist's real failure cause instead of the generic sentence", () => {
    const result: SpecialistResult = {
      agentId: "keycloak", status: "failed", evidence: [],
      errors: [{ code: "MODEL_RATE_LIMITED", message: "Specialist model was rate limited", retryable: true }],
    };
    const response = deterministicResponseBuilder(ctx, result);
    expect(response.answer).toContain("MODEL_RATE_LIMITED");
    expect(response.answer).toContain("Specialist model was rate limited");
    expect(response.answer).not.toContain("No supported answer could be produced");
    expect(response.degraded).toBe(true);
    expect(response.evidenceGaps).toEqual(expect.arrayContaining([{ source: "keycloak", reason: "MODEL_RATE_LIMITED" }]));
  });

  it("keeps the generic sentence only when there is genuinely no cause", () => {
    const result: SpecialistResult = { agentId: "keycloak", status: "failed", evidence: [] };
    const response = deterministicResponseBuilder(ctx, result);
    expect(response.answer).toContain("No supported answer could be produced");
  });

  it("keeps a grounded partial summary and still lists the error as a gap", () => {
    const result: SpecialistResult = {
      agentId: "keycloak", status: "partial",
      summary: "The investigation was interrupted (MODEL_UNAVAILABLE) before a final summary could be produced. 2 evidence item(s) were collected and are cited; they answer the question only as far as they go.",
      evidence: [{ id: "e1", kind: "telemetry", source: "prom/query", system: "prom", environment: "prod", payload: { ok: true }, citation: "tool://prom/query", status: "ok", requestId: "req-1", agentId: "keycloak" }],
      errors: [{ code: "MODEL_UNAVAILABLE", message: "Specialist model unavailable", retryable: true }],
    };
    const response = deterministicResponseBuilder(ctx, result);
    expect(response.answer).toContain("interrupted (MODEL_UNAVAILABLE)");
    expect(response.citations).toHaveLength(1);
    expect(response.evidenceGaps).toEqual(expect.arrayContaining([{ source: "keycloak", reason: "MODEL_UNAVAILABLE" }]));
  });

  it("marks complete-but-ungrounded result as degraded with evidence gap", () => {
    const result: SpecialistResult = {
      agentId: "observability", status: "complete",
      summary: "This is the answer.",
      evidence: [
        { id: "e1", kind: "telemetry", source: "prom", system: "app", environment: "prod", payload: { value: 42 }, citation: "prom://query", status: "ok", requestId: "req-1", agentId: "observability" },
        { id: "e2", kind: "telemetry", source: "prom", system: "app", environment: "prod", payload: { value: 50 }, citation: "prom://query2", status: "ok", requestId: "req-1", agentId: "observability" },
      ],
      grounding: { grounded: false, citedUsable: 0, usableEvidence: 2 },
    };
    const response = deterministicResponseBuilder(ctx, result);
    expect(response.degraded).toBe(true);
    expect(response.evidenceGaps).toEqual(expect.arrayContaining([{ source: "synthesis", reason: "UNGROUNDED_ANSWER" }]));
  });

  it("when grounding is absent, treats complete result as not degraded", () => {
    const result: SpecialistResult = {
      agentId: "observability", status: "complete",
      summary: "This is the answer.",
      evidence: [
        { id: "e1", kind: "telemetry", source: "prom", system: "app", environment: "prod", payload: { value: 42 }, citation: "prom://query", status: "ok", requestId: "req-1", agentId: "observability" },
      ],
      // no grounding field
    };
    const response = deterministicResponseBuilder(ctx, result);
    expect(response.degraded).toBe(false);
  });
});
