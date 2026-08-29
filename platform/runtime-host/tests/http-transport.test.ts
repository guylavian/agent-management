import { describe, expect, it } from "vitest";
import { hashDelegatedSubject, type AgentExecutionRequest } from "@sre/agent-protocol";
import { CONFIG_PATHS, deployEnvironmentDir, loadEffectiveAgentCatalog } from "@sre/config";
import { AgentTransportError } from "@sre/agent-protocol";
import { HttpSpecialistTransport } from "../src/index.ts";

const request = (): AgentExecutionRequest => ({
  requestId: "req-client",
  question: "AD health",
  environment: "prod",
  identityContext: {
    token: "x".repeat(32),
    tokenType: "urn:ietf:params:oauth:token-type:jwt",
    issuer: "mock://manager",
    audience: "sre-agent:active-directory",
    subjectHash: hashDelegatedSubject("alice"),
  },
  deadline: new Date(Date.now() + 5_000).toISOString(),
});

describe("agent clients", () => {
  it("maps service authorization failures without retrying", async () => {
    let calls = 0;
    const client = new HttpSpecialistTransport(
      loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("production") }),
      { async getToken() { return "workload-token"; } },
      async () => { calls += 1; return new Response("denied", { status: 403 }); },
    );
    await expect(client.execute("active-directory", request(), new AbortController().signal)).rejects.toMatchObject({ code: "AGENT_UNAUTHORIZED" });
    expect(calls).toBe(1);
  });

  it("retries one transient service failure only", async () => {
    let calls = 0;
    const client = new HttpSpecialistTransport(
      loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("production") }),
      { async getToken() { return "workload-token"; } },
      async () => {
        calls += 1;
        if (calls === 1) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ agentId: "active-directory", status: "failed", evidence: [], errors: [{ code: "TOOL_FAILED", message: "failed", retryable: false }] }), { status: 200 });
      },
    );
    await expect(client.execute("active-directory", request(), new AbortController().signal)).resolves.toMatchObject({ status: "failed" });
    expect(calls).toBe(2);
  });

  it("reports internal specialist failure distinctly and without retrying", async () => {
    let calls = 0;
    const client = new HttpSpecialistTransport(
      loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("production") }),
      { async getToken() { return "workload-token"; } },
      async () => { calls += 1; return new Response(JSON.stringify({ code: "AGENT_EXECUTION_FAILED" }), { status: 500 }); },
    );
    await expect(client.execute("active-directory", request(), new AbortController().signal)).rejects.toMatchObject({ code: "AGENT_EXECUTION_FAILED", retryable: false });
    expect(calls).toBe(1);
  });

  it("treats a specialist's oversized-response 502 as terminal, not transient", async () => {
    let calls = 0;
    const client = new HttpSpecialistTransport(
      loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("production") }),
      { async getToken() { return "workload-token"; } },
      async () => { calls += 1; return new Response(JSON.stringify({ code: "AGENT_RESPONSE_TOO_LARGE" }), { status: 502 }); },
    );
    await expect(client.execute("active-directory", request(), new AbortController().signal)).rejects.toMatchObject({ code: "AGENT_RESPONSE_TOO_LARGE" });
    expect(calls).toBe(1);
  });

  it("exposes typed transport errors", () => {
    expect(new AgentTransportError("AGENT_TIMEOUT", "timeout", false).retryable).toBe(false);
  });
});
