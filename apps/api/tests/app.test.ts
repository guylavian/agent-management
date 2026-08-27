import { describe, expect, it } from "vitest";
import { MockOidcClient } from "@sre/auth";
import { buildDependencies, createApp } from "../src/app.ts";

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
});
