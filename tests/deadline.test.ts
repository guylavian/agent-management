import { AuthorizationService } from "@sre/auth";
import { loadAgentRegistry } from "@sre/config";
import { loadAgentCatalog } from "@sre/config";
import type { ChatRequest, ChatResponse, ModelClient } from "@sre/llm";
import { MockModelClient } from "@sre/llm";
import { MockToolHiveClient, type ToolInvocation, type ToolResult } from "@sre/agent-engine";
import { describe, expect, it } from "vitest";
import { runSpecialist, type SpecialistExecutionContext } from "@sre/agent-engine";
import { inProcessRuntimeDependencies } from "@sre/runtime-host";
import { executeRequest } from "@sre/orchestrator";

const registry = loadAgentRegistry({ agentsDir: "agents", promptsDir: "prompts", approvedCatalogFile: "policies/approved-tools.yaml" });
const serviceRegistry = loadAgentCatalog("agents/registry.yaml");
const alice = { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-deadline" };
const context = (deadline: number): SpecialistExecutionContext => ({ request: { question: "AD replication", identity: alice }, identity: alice, environment: "prod", requestId: alice.requestId, deadline });

/** A gateway whose backend never resolves unless cancelled — proves the deadline, not the backend, ends the wait. */
class HangingGateway extends MockToolHiveClient {
  resolvedLate = false;
  override async invoke(call: ToolInvocation): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.resolvedLate = true; resolve({ content: { late: true }, observedAt: new Date().toISOString() }); }, 10_000);
      call.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { code: "REQUEST_TIMEOUT" })); }, { once: true });
    });
  }
}

describe("absolute deadline and cancellation", () => {
  it("returns on the specialist deadline and never accepts a late MCP response", async () => {
    const gateway = new HangingGateway();
    const deps = { registry, authorization: new AuthorizationService(registry), model: new MockModelClient(), toolhive: gateway };
    const started = Date.now();
    const result = await runSpecialist("active-directory", context(Date.now() + 150), deps);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(gateway.resolvedLate).toBe(false);
    // the hung call becomes a visible missing/timeout gap, never an "ok" evidence
    expect(result.evidence.every((item) => item.tool !== "get_replication_status" || item.status !== "ok")).toBe(true);
  });

  it("counts routing time against the one absolute request deadline", async () => {
    // a Manager LLM that stalls until aborted; the deadline signal must cancel it
    class StallingModel implements ModelClient {
      readonly mode = "mock" as const;
      aborted = false;
      async chat(request: ChatRequest): Promise<ChatResponse> {
        if (request.guidedJsonSchema?.title !== "ManagerDecision") return new MockModelClient().chat(request);
        return new Promise<ChatResponse>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => { this.aborted = true; reject(request.signal?.reason ?? new Error("aborted")); }, { once: true });
        });
      }
    }
    const model = new StallingModel();
    const deps = inProcessRuntimeDependencies({ registry, serviceRegistry, authorization: new AuthorizationService(registry), model, toolhive: new MockToolHiveClient(), requestDeadlineMs: 120 });
    // a cross-domain question forces the Manager LLM (Stage-1 cannot resolve it)
    const response = await executeRequest({ question: "why is everything slow across domains", identity: { ...alice, roles: ["infra-read", "network-read"] } }, deps);
    expect(model.aborted).toBe(true);
    expect(response.error?.code).toBe("REQUEST_TIMEOUT");
  });
});
