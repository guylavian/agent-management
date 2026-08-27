import { describe, expect, it } from "vitest";
import { HttpAgentClient, MockWorkloadTokenProvider } from "@sre/agent-client";
import { MockOidcClient } from "@sre/auth";
import type { MockToolHiveClient } from "@sre/mcp";
import { buildDependencies, createApp } from "../src/app.ts";

/**
 * End-to-end Architecture Gate #1 through the real distributed path, socketless:
 *   Alice → Manager (Express) → AD Specialist (Express, over an injected HTTP
 *   transport) → ToolHive (credential-verified) → read-only backend.
 * The manager and specialist run from the same buildDependencies wiring with a
 * shared mock delegation secret, so the delegated user JWT the manager mints is
 * verified by the specialist, and the tool credential is verified by ToolHive.
 */
function buildDistributed() {
  const managerDeps = buildDependencies({});
  if (managerDeps.mode !== "manager") throw new Error("expected manager");
  const specialistDeps = buildDependencies({ AGENT_CONFIG: "agents/active-directory.yaml" });
  if (specialistDeps.mode !== "specialist") throw new Error("expected specialist");
  const specialistApp = createApp(specialistDeps);

  // route the manager's HTTP agent client into the specialist app by path, ignoring the DNS host
  const dispatch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const res = await specialistApp.inject({
      method: (init?.method ?? "POST") as "POST",
      url: url.pathname,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string,
    });
    return new Response(res.payload, { status: res.statusCode, headers: { "content-type": "application/json" } });
  };
  const agentClient = new HttpAgentClient(managerDeps.registry, new MockWorkloadTokenProvider(), dispatch);
  const managerApp = createApp({ ...managerDeps, agentClient });
  return { managerApp, oidc: managerDeps.oidc as MockOidcClient, toolhive: specialistDeps.toolhive as MockToolHiveClient };
}

describe("Gate #1 end-to-end (Manager → Specialist → ToolHive)", () => {
  it("allows Alice through the full chain with the effective human preserved", async () => {
    const { managerApp, oidc, toolhive } = buildDistributed();
    const response = await managerApp.inject({
      method: "POST",
      url: "/v1/query",
      headers: { authorization: `Bearer ${await oidc.issueTestToken("alice")}` },
      payload: { question: "Is AD replication healthy?", environment: "prod" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metadata.routedAgents).toEqual(["active-directory"]);
    expect(body.citations.length).toBeGreaterThan(0);
    // ToolHive verified the credential and audited the effective human, not a header
    const audit = toolhive.audit.find((event) => event.decision === "allowed");
    expect(audit).toMatchObject({ subject: "alice", backendCalled: true });
    // same requestId spans the manager response and the ToolHive audit
    expect(toolhive.backendCalls.every((call) => call.requestId === audit?.requestId)).toBe(true);
    await managerApp.close();
  });

  it("denies an unauthorized user before any backend call", async () => {
    const { managerApp, oidc, toolhive } = buildDistributed();
    // bob holds network-read only; the AD specialist requires infra-read
    const response = await managerApp.inject({
      method: "POST",
      url: "/v1/query",
      headers: { authorization: `Bearer ${await oidc.issueTestToken("bob")}` },
      payload: { question: "Is AD replication healthy?", environment: "prod" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("AUTHZ_DENIED");
    expect(toolhive.backendCalls).toHaveLength(0);
    await managerApp.close();
  });
});
