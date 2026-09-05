import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import {
  KeycloakWorkloadCredentialExchanger,
  PrivateKeyToolCredentialExchanger,
  RealTokenExchangeCredentialExchanger,
  withSubjectToken,
} from "../src/index.ts";
import type { RequestIdentity, WorkloadIdentity } from "../src/index.ts";

/**
 * The tool credential must carry the HUMAN, verifiably.
 *
 * Until this suite existed the specialist obtained a client-credentials token
 * that named only the agent, so ToolHive authorized a workload and the person
 * on whose behalf it acted was decorative. These tests pin the delegation
 * chain: the manager-signed assertion is the subject, the agent is the actor.
 */

const workload: WorkloadIdentity = { clientId: "sre-agent-keycloak", provider: "keycloak", agentId: "keycloak" };
const alice: RequestIdentity = { subject: "alice", groups: ["ops"], roles: ["infra-read"], requestId: "req-1" };
const bob: RequestIdentity = { subject: "bob", groups: [], roles: ["infra-read"], requestId: "req-2" };

/** A stand-in for the manager-signed delegation JWT the specialist already holds and has verified. */
async function delegationAssertion(subject: string): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return new SignJWT({ request_id: "req-1" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://manager.test")
    .setAudience("sre-agent:keycloak")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

describe("RFC 8693 exchange carries the delegated human", () => {
  it("sends the human's IdP token as subject_token and the workload token as actor_token", async () => {
    const assertion = await delegationAssertion("alice");
    let sent: URLSearchParams | undefined;
    const exchanger = new RealTokenExchangeCredentialExchanger(
      {
        tokenEndpoint: "https://idp.test/token",
        issuer: "https://idp.test/realms/agents",
        audiencePrefix: "sre-toolhive:",
        clientSecret: () => "specialist-client-secret",
        actorToken: async () => "specialist-projected-sa-token",
      },
      (async (_url: string, init: RequestInit) => {
        sent = new URLSearchParams(init.body as string);
        return new Response(JSON.stringify({ access_token: "x".repeat(40), expires_in: 60 }), { status: 200 });
      }) as unknown as typeof fetch,
    );

    const credential = await exchanger.exchange(workload, { ...alice, subjectToken: assertion }, "sre-toolhive:keycloak", Date.now() + 30_000);

    expect(sent?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    // the HUMAN, as the token their own IdP issued — proven against Keycloak
    // 26.6, which refuses to exchange an assertion it did not issue
    expect(sent?.get("subject_token")).toBe(assertion);
    expect(sent?.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
    // the AGENT, as the actor of the delegation chain
    expect(sent?.get("actor_token")).toBe("specialist-projected-sa-token");
    expect(sent?.get("actor_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    // the request authenticates as the specialist client
    expect(sent?.get("client_secret")).toBe("specialist-client-secret");
    expect(sent?.get("audience")).toBe("sre-toolhive:keycloak");
    // the issuer is the configured issuer, never the audience prefix
    expect(credential.issuer).toBe("https://idp.test/realms/agents");
    expect(credential.expiresAt).toBeTypeOf("number");
  });

  it("refuses to exchange without a subject token rather than falling back to an agent-only token", async () => {
    const exchanger = new RealTokenExchangeCredentialExchanger(
      { tokenEndpoint: "https://idp.test/token", issuer: "https://idp.test", audiencePrefix: "sre-toolhive:", clientSecret: () => "s", actorToken: async () => "a" },
      (async () => new Response(JSON.stringify({ access_token: "x".repeat(40) }), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(exchanger.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 30_000)).rejects.toMatchObject({ code: "TOOL_DENIED" });
  });

  it("threads the subject token per request without the exchanger holding it", async () => {
    const seen: Array<string | undefined> = [];
    const inner = { mode: "real" as const, exchange: async (_w: WorkloadIdentity, identity: RequestIdentity) => { seen.push(identity.subjectToken); return { token: "t".repeat(20), tokenType: "urn:ietf:params:oauth:token-type:access_token" as const, issuer: "i", audience: "a", subjectHash: "0".repeat(64), workloadClientId: "c" }; } };
    await withSubjectToken(inner, "token-for-alice").exchange(workload, alice, "aud", Date.now() + 1000);
    await withSubjectToken(inner, "token-for-bob").exchange(workload, bob, "aud", Date.now() + 1000);
    expect(seen).toEqual(["token-for-alice", "token-for-bob"]);
  });
});

describe("credential lifetime is visible to the platform", () => {
  it("stamps expiresAt so a long run can refresh before the credential dies", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pkcs8 = await exportPkcs8(privateKey);
    const exchanger = new PrivateKeyToolCredentialExchanger({ issuer: "https://poc.test", privateKeyPkcs8: pkcs8, agentId: "keycloak" });
    const credential = await exchanger.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 300_000);
    expect(credential.expiresAt).toBeTypeOf("number");
    expect(credential.expiresAt as number).toBeGreaterThan(Date.now());
  });

  it("binds the signing key id to the agent so one key cannot silently speak for another", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pkcs8 = await exportPkcs8(privateKey);
    const exchanger = new PrivateKeyToolCredentialExchanger({ issuer: "https://poc.test", privateKeyPkcs8: pkcs8, agentId: "keycloak" });
    const credential = await exchanger.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 60_000);
    const header = JSON.parse(Buffer.from(credential.token.split(".")[0] as string, "base64url").toString()) as { kid?: string };
    expect(header.kid).toBe("sre-keycloak");
  });
});

describe("the workload-client strategy cannot leak one human's token to another", () => {
  it("never serves a cached token stamped with a different subject", async () => {
    let issued = 0;
    const exchanger = new KeycloakWorkloadCredentialExchanger({
      tokenEndpoint: "https://kc.test/token",
      clientId: "sre-agent-keycloak",
      clientSecret: () => "secret",
      issuer: "https://kc.test",
      fetchImplementation: (async () => { issued += 1; return new Response(JSON.stringify({ access_token: `token-${issued}${"x".repeat(30)}`, expires_in: 300 }), { status: 200 }); }) as unknown as typeof fetch,
    });
    const forAlice = await exchanger.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 60_000);
    const forBob = await exchanger.exchange(workload, bob, "sre-toolhive:keycloak", Date.now() + 60_000);
    // a second human must never be handed the first human's token re-stamped
    expect(forBob.token).not.toBe(forAlice.token);
    expect(issued).toBe(2);
  });
});

async function exportPkcs8(key: Parameters<typeof import("jose").exportPKCS8>[0]): Promise<string> {
  const { exportPKCS8 } = await import("jose");
  return exportPKCS8(key);
}

// keeps the unused import honest: jwtVerify/exportJWK are used by sibling suites' helpers
void jwtVerify;
void exportJWK;

describe("the delegated assertion outlives the run it authorizes", () => {
  it("stays valid long enough to be re-exchanged late in a 180s investigation", async () => {
    const { MockDelegationAuthority } = await import("../src/index.ts");
    const authority = new MockDelegationAuthority({ issuer: "https://manager.test", secret: "x".repeat(40) });
    const deadline = Date.now() + 180_000;
    const context = await authority.issue(alice, "sre-agent:keycloak", deadline);
    const claims = JSON.parse(Buffer.from(context.token.split(".")[1] as string, "base64url").toString()) as { exp: number };
    // the credential is refreshed at the ToolProvider boundary using THIS
    // assertion as the subject_token; an assertion that died at 60s would make
    // every refresh after minute one fail against a real STS
    expect(claims.exp * 1000).toBeGreaterThanOrEqual(deadline - 1_000);
  });

  it("never outlives the run's deadline", async () => {
    const { MockDelegationAuthority } = await import("../src/index.ts");
    const authority = new MockDelegationAuthority({ issuer: "https://manager.test", secret: "x".repeat(40) });
    const deadline = Date.now() + 20_000;
    const context = await authority.issue(alice, "sre-agent:keycloak", deadline);
    const claims = JSON.parse(Buffer.from(context.token.split(".")[1] as string, "base64url").toString()) as { exp: number };
    expect(claims.exp * 1000).toBeLessThanOrEqual(deadline + 1_000);
  });
});
