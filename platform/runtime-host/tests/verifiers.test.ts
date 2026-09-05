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

  it("is ready when every grant is approved and the gateway refuses an unauthenticated call", async () => {
    const verifier = new GatewayToolAccessVerifier({ catalog: catalog(), endpoints: new Map([["keycloak", "https://toolhive.test/mcp"]]), fetchImplementation: gatewayRefusing });
    const result = await verifier.verify(agent, "prod");
    expect(result.ready).toBe(true);
    // the limit is stated rather than implied
    expect(result.detail).toMatch(/not introspectable/u);
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
