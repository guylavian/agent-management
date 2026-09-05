import { describe, expect, it } from "vitest";
import type { ApprovedCatalog, SpecialistAgentConfig } from "@sre/config";
import { GatewayToolAccessVerifier, KeycloakIdentityVerifier } from "../src/bootstrap/verifiers.ts";

/**
 * The reconciler may only report READY for something it actually verified.
 *
 * These two verifiers decide whether an Agent routes at all, so the cases that
 * matter are the negative ones: a revoked identity, an unreachable IdP, a
 * gateway that answers an unauthenticated call, a grant naming a tool the
 * catalog never approved.
 */

const agent = {
  name: "keycloak",
  metadata: { name: "keycloak" },
  spec: {
    identity: { clientId: "sre-agent-keycloak" },
    access: [{ mcp: "keycloak", tools: ["list_clients"] }],
  },
} as unknown as SpecialistAgentConfig;

const catalog = (overrides: Array<Record<string, unknown>> = []): ApprovedCatalog => ({
  tools: overrides.length > 0 ? overrides : [{ serverId: "keycloak", toolName: "list_clients", readOnlyVerified: true, environments: ["prod"], timeoutMs: 5_000, retryPolicy: "none", evidenceKind: "config" }],
} as unknown as ApprovedCatalog);

const adminFetch = (clients: unknown, tokenOk = true) => (async (input: URL | string) => {
  const url = String(input);
  if (url.includes("/protocol/openid-connect/token")) {
    return tokenOk
      ? new Response(JSON.stringify({ access_token: "admin-token" }), { status: 200 })
      : new Response("nope", { status: 401 });
  }
  return new Response(JSON.stringify(clients), { status: 200 });
}) as unknown as typeof fetch;

const identitySettings = (fetchImplementation: typeof fetch) => ({
  adminUrl: "https://idp.test", realm: "sre-agents", adminRealm: "master",
  clientId: "reconciler", clientSecret: () => "secret", fetchImplementation,
});

describe("identity attestation", () => {
  it("is ready when the workload client exists, is enabled and has a service account", async () => {
    const verifier = new KeycloakIdentityVerifier(identitySettings(adminFetch([{ clientId: "sre-agent-keycloak", enabled: true, serviceAccountsEnabled: true }])));
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(true);
    expect(result.detail).toContain("sre-agent-keycloak");
  });

  it("is NOT ready when the identity was revoked in the IdP", async () => {
    const verifier = new KeycloakIdentityVerifier(identitySettings(adminFetch([{ clientId: "sre-agent-keycloak", enabled: false, serviceAccountsEnabled: true }])));
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/disabled/u);
  });

  it("is NOT ready when the client does not exist at all", async () => {
    const verifier = new KeycloakIdentityVerifier(identitySettings(adminFetch([])));
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/no workload client/u);
  });

  it("is NOT ready when the IdP cannot be reached — never ready by default", async () => {
    const verifier = new KeycloakIdentityVerifier(identitySettings(adminFetch([], false)));
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/could not be reached|refused/u);
  });
});

describe("tool-access attestation", () => {
  const gatewayRefusing = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

  it("verifies what it can, and refuses to attest what it cannot", async () => {
    // this test previously asserted ready:true with the limit merely stated in
    // the detail. `ready` drives ROUTING, and the unverifiable part is exactly
    // the revocation guarantee the operational plane exists for — so stating
    // the limit while attesting anyway was the overclaim.
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: gatewayRefusing });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/approved and read-only verified/u);
    expect(result.detail).toMatch(/cannot be introspected/u);
  });

  it("is NOT ready when the gateway answers an unauthenticated call", async () => {
    const open = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: open });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/not enforcing authorization/u);
  });

  it("is NOT ready when a grant names a tool the approved catalog does not contain", async () => {
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog([{ serverId: "keycloak", toolName: "something_else", readOnlyVerified: true }]), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: gatewayRefusing });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/approved catalog does not contain/u);
  });

  it("is NOT ready when a granted tool is not verified read-only", async () => {
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog([{ serverId: "keycloak", toolName: "list_clients", readOnlyVerified: false }]), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: gatewayRefusing });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/read-only/u);
  });

  it("is NOT ready when the gateway is unreachable", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: down });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/not reachable/u);
  });

  it("is NOT ready when no endpoint is configured for a granted server", async () => {
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map(), fetchImplementation: gatewayRefusing });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/no endpoint configured/u);
  });
});

/**
 * AN ATTESTATION MUST NOT BE READY FOR SOMETHING IT CANNOT SEE.
 *
 * This verifier checks real things — every grant is in the approved catalog and
 * read-only verified, and every gateway refuses an unauthenticated call — and
 * then returns ready:true while its own detail string admits "loaded per-Agent
 * policy is not introspectable". So `tool_access: ready` attests to a WEAKER
 * property than its name claims.
 *
 * That matters for revocation, which is the whole point of the operational
 * plane. The design says disable = routing off + identity revoked + access
 * revoked. Nothing here can show the third: after an Agent is disabled, this
 * verifier would go on attesting tool access exactly as before, because it
 * never asked the proxy what policy it holds.
 *
 * Fail closed by default. An operator who accepts the weaker attestation says
 * so explicitly, and that acknowledgement is recorded in the detail.
 */
describe("tool-access attestation is honest about what it could not verify", () => {
  const gatewayRefusing = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

  it("is NOT ready when the loaded policy cannot be introspected", async () => {
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: gatewayRefusing });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(false);
    expect(result.detail).toMatch(/introspect/iu);
  });

  it("names the setting that would let an operator accept the weaker attestation", async () => {
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: gatewayRefusing });
    expect((await verifier.verify(agent, "prod")).detail).toMatch(/acceptUnintrospectablePolicy/u);
  });

  it("is ready when the operator has explicitly accepted it, and says so", async () => {
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: gatewayRefusing, acceptUnintrospectablePolicy: true });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(true);
    // the acknowledgement travels with the attestation, so a reader of the
    // operational plane can see the weaker basis rather than infer it
    expect(result.detail).toMatch(/accepted/iu);
  });

  it("still fails for the reasons it CAN see, regardless of the acknowledgement", async () => {
    const answering = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: answering, acceptUnintrospectablePolicy: true });
    expect((await verifier.verify(agent, "prod")).ready).toBe(false);
  });
});
