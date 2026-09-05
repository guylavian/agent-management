import { describe, expect, it } from "vitest";
import { MockOidcClient } from "@sre/auth";
import { buildDependencies, createApp } from "../src/index.ts";

/**
 * THE CALLER DOES NOT CHOOSE THE TRUST ENVIRONMENT.
 *
 * `environment` arrived in the request body, won over the deployment's own
 * configuration, was used for catalog and tool authorization, and was forwarded
 * to ToolHive as `x-sre-environment`. Agents and tools declare `prod`, `dr` and
 * `lab`, so an authenticated caller with a single read role could post
 * `{"environment":"dr"}` to a production Manager and have that assertion carried
 * all the way to the data plane. `authorizeAgent` even receives the value and
 * deliberately ignores it, so nothing downstream re-derived it from anything
 * trustworthy.
 *
 * A deployment serves exactly one environment — `deploy/environments/<env>` is
 * chosen when the pod is built, not per request. The configured environment is
 * therefore the authority, and a request that names a different one is refused
 * rather than quietly coerced: silently downgrading `dr` to `prod` would answer
 * a question the caller did not ask.
 */
describe("the deployment's environment is authoritative, not the request body", () => {
  async function query(environment?: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const deps = buildDependencies({ SRE_DEFAULT_ENVIRONMENT: "prod" });
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const oidc = deps.oidc as MockOidcClient;
    const app = createApp(deps);
    const response = await app.inject({
      method: "POST",
      url: "/v1/query",
      headers: { authorization: `Bearer ${await oidc.issueTestToken("alice")}` },
      payload: { question: "Is AD replication healthy?", ...(environment === undefined ? {} : { environment }) },
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  it("refuses an environment the deployment does not serve", async () => {
    // the escalation: prod caller asserting dr, which agents and tools declare
    const { statusCode, body } = await query("dr");
    expect(statusCode).toBe(422);
    expect((body.error as { code?: string })?.code ?? body.code).toBe("ROUTE_INVALID");
  });

  it("refuses lab for the same reason", async () => {
    expect((await query("lab")).statusCode).toBe(422);
  });

  it("accepts the environment this deployment actually serves", async () => {
    expect((await query("prod")).statusCode).toBe(200);
  });

  it("defaults to the configured environment when the caller names none", async () => {
    expect((await query()).statusCode).toBe(200);
  });

  it("does not disclose which other environments exist", async () => {
    // naming them would hand an attacker the map
    const { body } = await query("dr");
    const message = JSON.stringify(body);
    expect(message).not.toContain("lab");
    expect(message).not.toContain("prod");
  });
});
