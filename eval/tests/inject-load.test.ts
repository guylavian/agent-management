import { MockOidcClient } from "@sre/auth";
import { buildDependencies, createApp } from "../../runtime/app/src/app.ts";
import { describe, expect, it } from "vitest";

describe("in-process mock load fallback", () => {
  it.each([20, 50])("completes %i concurrent mock requests without rejection", async (concurrency) => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const app = createApp(deps);
    const token = await (deps.oidc as MockOidcClient).issueTestToken("alice");
    const results = await Promise.allSettled(Array.from({ length: concurrency }, () => app.inject({ method: "POST", url: "/v1/query", headers: { authorization: `Bearer ${token}` }, payload: { question: "Is AD replication healthy?", environment: "prod" } })));
    expect(results.every((result) => result.status === "fulfilled" && result.value.statusCode === 200)).toBe(true);
    expect(deps.agentClient.mode).toBe("mock");
    await app.close();
  });
});
