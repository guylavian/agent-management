import { AuthorizationService } from "@sre/auth";
import { loadAgentRegistry } from "@sre/config";
import type { ModelClient, ChatRequest, ChatResponse } from "@sre/llm";
import { MockModelClient } from "@sre/llm";
import { MockToolHiveClient, type ToolInvocation, type ToolResult } from "@sre/mcp";
import { MockRagClient, type RagClient, type RetrievalRequest, type RetrievalHit } from "@sre/rag";
import { describe, expect, it } from "vitest";
import { deterministicResponseBuilder, runSpecialist, type ExecutionContext } from "../src/index.ts";

const registry = loadAgentRegistry({ agentsDir: "agents", promptsDir: "prompts", approvedCatalogFile: "policies/approved-tools.yaml" });
const identity = { subject: "alice", groups: ["domain-services"], roles: ["infra-read"], requestId: "req-ad" };
const context = (question: string, deadline = Date.now() + 5000): ExecutionContext => ({ request: { question, identity }, identity, environment: "prod", intent: question.includes("Why") ? "diagnostic" : "factual", requestId: identity.requestId, deadline });
const deps = (model: ModelClient = new MockModelClient(), toolhive = new MockToolHiveClient(), rag: RagClient = new MockRagClient()) => ({ registry, authorization: new AuthorizationService(registry), model, toolhive, rag });

describe("T2 AD specialist", () => {
  it("produces a cited summary from RAG and live evidence", async () => {
    const result = await runSpecialist("active-directory", context("Is AD replication healthy between DC1 and DC2?"), deps());
    expect(result.status).toBe("complete");
    expect(result.evidence.some((item) => item.kind === "wiki")).toBe(true);
    expect(result.evidence.some((item) => item.tool === "get_replication_status")).toBe(true);
    const response = deterministicResponseBuilder(context("Is AD replication healthy?"), result);
    expect(response.answer).toContain("Sources:");
    expect(response.citations.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["failure", "timeout", "empty"])("keeps %s source state visible", async (mode) => {
    const result = await runSpecialist("active-directory", context(`AD replication ${mode}`), deps());
    const live = result.evidence.find((item) => item.tool === "get_replication_status");
    expect(live?.status).toBe(mode === "empty" ? "empty" : mode === "timeout" ? "missing" : "failed");
    expect(deterministicResponseBuilder(context("AD replication"), result).evidenceGaps.length).toBeGreaterThan(0);
  });

  it("rejects malformed final structured output", async () => {
    const model = new MockModelClient();
    model.enqueue({ usage: { promptTokens: 1, completionTokens: 1 } }, { content: "not-json", usage: { promptTokens: 1, completionTokens: 1 } });
    const result = await runSpecialist("active-directory", context("AD health"), deps(model));
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MODEL_INVALID_OUTPUT" })]));
  });

  it("enforces the tool-call and model-turn bounds", async () => {
    const toolhive = new MockToolHiveClient();
    class CountingModel implements ModelClient {
      readonly mode = "mock" as const;
      calls = 0;
      async chat(request: ChatRequest): Promise<ChatResponse> {
        this.calls += 1;
        if (request.guidedJsonSchema) return { content: JSON.stringify({ summary: "Bounded." }), usage: { promptTokens: 1, completionTokens: 1 } };
        return { toolCalls: Array.from({ length: 10 }, (_, index) => ({ id: `${index}`, name: "get_dc_health", arguments: { dc: `DC${index}` } })), usage: { promptTokens: 1, completionTokens: 1 } };
      }
    }
    const model = new CountingModel();
    await runSpecialist("active-directory", context("AD health"), deps(model, toolhive));
    expect(toolhive.backendCalls).toHaveLength(6);
    expect(model.calls).toBeLessThanOrEqual(3);
  });

  it("retries an eligible transient failure at most once", async () => {
    class FlakyGateway extends MockToolHiveClient {
      attempts = 0;
      override async invoke(call: ToolInvocation): Promise<ToolResult> {
        this.attempts += 1;
        if (this.attempts === 1) throw Object.assign(new Error("reset"), { code: "MCP_UNAVAILABLE" });
        return super.invoke(call);
      }
    }
    const gateway = new FlakyGateway();
    const success = await runSpecialist("active-directory", context("AD replication"), deps(new MockModelClient(), gateway));
    expect(gateway.attempts).toBe(2);
    expect(success.evidence.some((item) => item.tool === "get_replication_status" && item.status === "ok")).toBe(true);

    class AlwaysFailGateway extends FlakyGateway {
      override async invoke(_call: ToolInvocation): Promise<ToolResult> { this.attempts += 1; throw Object.assign(new Error("reset"), { code: "MCP_UNAVAILABLE" }); }
    }
    const failedGateway = new AlwaysFailGateway();
    await runSpecialist("active-directory", context("AD replication"), deps(new MockModelClient(), failedGateway));
    expect(failedGateway.attempts).toBe(2);
  });

  it("never calls the backend when model arguments fail schema validation", async () => {
    const toolhive = new MockToolHiveClient();
    class BadArgsModel implements ModelClient {
      readonly mode = "mock" as const;
      async chat(request: ChatRequest): Promise<ChatResponse> {
        if (request.guidedJsonSchema) return { content: JSON.stringify({ summary: "Bounded." }), usage: { promptTokens: 1, completionTokens: 1 } };
        // unknown property + missing required "dc" for get_dc_health
        return { toolCalls: [{ id: "1", name: "get_dc_health", arguments: { wrongKey: true } }], usage: { promptTokens: 1, completionTokens: 1 } };
      }
    }
    const result = await runSpecialist("active-directory", context("AD health"), deps(new BadArgsModel(), toolhive));
    expect(toolhive.backendCalls).toHaveLength(0);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MCP_INVALID_CALL" })]));
  });

  it("bounds follow-up RAG to one", async () => {
    class CountingRag implements RagClient {
      readonly mode = "mock" as const;
      calls = 0;
      async retrieve(_request: RetrievalRequest): Promise<RetrievalHit[]> { this.calls += 1; return []; }
    }
    const rag = new CountingRag();
    await runSpecialist("active-directory", context("Check APP-PRD-114 replication"), deps(new MockModelClient(), new MockToolHiveClient(), rag));
    expect(rag.calls).toBe(2);
  });

  it("enforces an exhausted deadline", async () => {
    const result = await runSpecialist("active-directory", context("AD health", Date.now() - 1), deps());
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REQUEST_TIMEOUT" })]));
  });
});
