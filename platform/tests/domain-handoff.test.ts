import type { AgentRunContext } from "@sre/agent-engine";
import { MockToolHiveClient, runSpecialist } from "@sre/runtime-host";
import { CONFIG_PATHS, loadAgentRegistry } from "@sre/config";
import { domainHandoffSchema, type SpecialistResult } from "@sre/evidence";
import type { ChatRequest, ChatResponse, ModelClient } from "@sre/llm";
import { buildDomainHandoff, type ExecutionContext } from "@sre/orchestrator";
import { describe, expect, it } from "vitest";

/**
 * The cross-domain handoff crosses the orchestrator→engine boundary, so it is
 * asserted here rather than inside either component: the Manager builds it, a
 * specialist consumes it, and neither may leak the other's transcript.
 */
const registry = loadAgentRegistry(CONFIG_PATHS);
const identity = { subject: "alice", groups: [], roles: ["infra-read", "network-read"], requestId: "req-handoff" };
const ctx: ExecutionContext = { request: { question: "AD replication has a network dependency", identity }, identity, environment: "prod", intent: "diagnostic", requestId: identity.requestId, deadline: Date.now() + 5000 };
const result = (agentId: string, needsHandoff: string, secret: string): SpecialistResult => ({ agentId, status: "complete", summary: secret, needsHandoff: [needsHandoff], evidence: [{ id: `${agentId}-e`, kind: "telemetry", source: agentId, system: agentId, environment: "prod", rawExcerpt: secret, payload: { secret }, citation: `tool://${agentId}`, status: "ok", requestId: identity.requestId, agentId }] });

describe("domain handoff", () => {
  it("builds a scalar-only handoff without summaries, payloads, excerpts, or transcripts", async () => {
    const source = result("active-directory", "network-observability", "TOP_SECRET_TRANSCRIPT");
    const handoff = buildDomainHandoff(ctx.request.question, source, { hostname: "DC-TLV-01" });
    const serialized = JSON.stringify(handoff);
    expect(serialized).not.toContain("TOP_SECRET_TRANSCRIPT");
    expect(serialized).not.toMatch(/summary|payload|rawExcerpt/iu);
    expect(() => domainHandoffSchema.parse({ ...handoff, sanitizedFacts: [{ key: "bad", value: { nested: true } }] })).toThrow();

    class InspectingModel implements ModelClient {
      readonly mode = "mock" as const;
      requests: ChatRequest[] = [];
      async chat(request: ChatRequest): Promise<ChatResponse> { this.requests.push(request); return request.guidedJsonSchema ? { content: JSON.stringify({ summary: "Checked." }), usage: { promptTokens: 1, completionTokens: 1 } } : { usage: { promptTokens: 1, completionTokens: 1 } }; }
    }
    const model = new InspectingModel();
    const runCtx: AgentRunContext = { question: ctx.request.question, principal: identity, environment: "prod", requestId: identity.requestId, deadline: ctx.deadline };
    await runSpecialist("network-observability", runCtx, { registry, model, toolhive: new MockToolHiveClient() }, handoff);
    expect(JSON.stringify(model.requests)).not.toContain("TOP_SECRET_TRANSCRIPT");
  });
});
