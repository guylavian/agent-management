import { describe, expect, it } from "vitest";
import { MockSpecialistTransport } from "@sre/orchestrator";
import { MockDelegationAuthority, MockOidcClient } from "@sre/auth";
import { buildDependencies, createApp } from "../src/index.ts";

describe("local API", () => {
  it("exposes mock token issuance only in local mock mode", async () => {
    const app = createApp(buildDependencies({}));
    const token = await app.inject({ method: "POST", url: "/dev/token/alice" });
    expect(token.statusCode).toBe(200);
    expect(token.json().token).toEqual(expect.any(String));
    await app.close();
  });

  it("rejects a missing bearer token in middleware", async () => {
    const app = createApp(buildDependencies({}));
    const response = await app.inject({ method: "POST", url: "/v1/query", payload: { question: "AD replication" } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHN_FAILED" });
    await app.close();
  });

  it("serves a cited AD answer through the authenticated pipeline", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const oidc = deps.oidc as MockOidcClient;
    const app = createApp(deps);
    const response = await app.inject({ method: "POST", url: "/v1/query", headers: { authorization: `Bearer ${await oidc.issueTestToken("alice")}` }, payload: { question: "Is AD replication healthy?", environment: "prod" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ degraded: false, metadata: { routedAgents: ["active-directory"], tierLUsed: false } });
    expect(response.json().citations.length).toBeGreaterThan(0);
    await app.close();
  });

  it("carries bounded session entities into follow-up fan-out requests", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const oidc = deps.oidc as MockOidcClient;
    const client = deps.agentClient as MockSpecialistTransport;
    const app = createApp(deps);
    const headers = { authorization: `Bearer ${await oidc.issueTestToken("alice")}` };
    const first = await app.inject({ method: "POST", url: "/v1/query", headers, payload: { question: "Is AD replication healthy on DC-TLV-99?", environment: "prod", sessionId: "s-1" } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/v1/query", headers, payload: { question: "Is AD replication healthy?", environment: "prod", sessionId: "s-1" } });
    expect(second.statusCode).toBe(200);
    const lastCall = client.calls.at(-1);
    expect(lastCall?.request.conversationContext?.resolvedEntities).toMatchObject({ "DC-TLV-99": "DC-TLV-99" });
    await app.close();
  });
});

describe("specialist internal API", () => {
  const specialistEnv = { AGENT_CONFIG: "agents/active-directory.yaml" };
  const identity = { subject: "alice", groups: ["domain-services", "platform"], roles: ["infra-read"], requestId: "req-spec-1" };

  function buildSpecialist() {
    const deps = buildDependencies(specialistEnv);
    if (deps.mode !== "specialist") throw new Error("expected specialist mode");
    const delegation = new MockDelegationAuthority({ issuer: deps.config.delegation.issuer, secret: deps.config.delegation.mockSecret });
    return { deps, app: createApp(deps), delegation };
  }

  it("rejects an invalid workload identity as unauthorized without execution detail", async () => {
    const { app, delegation } = buildSpecialist();
    const identityContext = await delegation.issue(identity, "sre-agent:active-directory", Date.now() + 30_000);
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/execute",
      headers: { authorization: "Bearer wrong-workload-token" },
      payload: { requestId: identity.requestId, question: "Is AD replication healthy?", environment: "prod", identityContext, deadline: new Date(Date.now() + 30_000).toISOString() },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "AGENT_UNAUTHORIZED", message: "Internal agent request rejected" });
    await app.close();
  });

  it("rejects an expired deadline with a timeout, not an authorization error", async () => {
    const { app, delegation } = buildSpecialist();
    const identityContext = await delegation.issue(identity, "sre-agent:active-directory", Date.now() + 30_000);
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/execute",
      headers: { authorization: "Bearer mock-manager-workload-token-for-local-tests" },
      payload: { requestId: identity.requestId, question: "Is AD replication healthy?", environment: "prod", identityContext, deadline: new Date(Date.now() - 1_000).toISOString() },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().code).toBe("AGENT_TIMEOUT");
    await app.close();
  });

  it("executes a delegated request end to end over HTTP", async () => {
    const { app, delegation } = buildSpecialist();
    const identityContext = await delegation.issue(identity, "sre-agent:active-directory", Date.now() + 30_000);
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/execute",
      headers: { authorization: "Bearer mock-manager-workload-token-for-local-tests" },
      payload: { requestId: identity.requestId, question: "Is AD replication healthy?", environment: "prod", identityContext, deadline: new Date(Date.now() + 30_000).toISOString() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agentId).toBe("active-directory");
    expect(response.json().evidence.length).toBeGreaterThan(0);
    await app.close();
  });
});
