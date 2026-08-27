import { describe, expect, it } from "vitest";
import { MockToolCredentialAuthority, type RequestIdentity } from "@sre/auth";
import { MockToolHiveClient, toolHiveAudience, type ToolInvocation } from "@sre/mcp";

/**
 * Architecture Gate #1 at the Specialist → ToolHive hop: ToolHive verifies a
 * delegated credential ITSELF and derives the effective human from it. No
 * unsigned x-effective-subject header is trusted. This exercises the mock
 * authority + mock gateway with the shared key wired exactly as
 * buildDependencies wires them for a running specialist.
 */
const SECRET = "gate1-tool-credential-shared-secret-32b";
const ISSUER = "https://mock-toolhive-sts.sre.local";

function makeGateway(): { authority: MockToolCredentialAuthority; gateway: MockToolHiveClient } {
  const authority = new MockToolCredentialAuthority({ issuer: ISSUER, secret: SECRET });
  return { authority, gateway: new MockToolHiveClient(authority) };
}

async function invoke(identity: RequestIdentity, gateway: MockToolHiveClient, authority: MockToolCredentialAuthority): Promise<ToolInvocation> {
  const deadline = Date.now() + 30_000;
  const credential = await authority.exchange(identity, toolHiveAudience("active-directory"), deadline);
  const call: ToolInvocation = {
    serverId: "active-directory",
    toolName: "get_replication_status",
    arguments: { sourceDc: "DC-TLV-01", targetDc: "DC-HFA-02", mode: "ok" },
    environment: "prod",
    requestId: identity.requestId,
    identity,
    credential,
    timeoutMs: 5_000,
  };
  await gateway.invoke(call).catch(() => undefined);
  return call;
}

describe("Gate #1 — verified delegated identity to ToolHive", () => {
  it("allows Alice and audits the effective human derived from the credential", async () => {
    const { authority, gateway } = makeGateway();
    const alice: RequestIdentity = { subject: "alice", groups: ["domain-services"], roles: ["infra-read"], requestId: "req-alice-1" };
    await invoke(alice, gateway, authority);
    expect(gateway.backendCalls).toHaveLength(1);
    const audit = gateway.audit.at(-1);
    expect(audit).toMatchObject({ subject: "alice", decision: "allowed", backendCalled: true, requestId: "req-alice-1" });
  });

  it("denies an unauthorized user and never calls the backend", async () => {
    const { authority, gateway } = makeGateway();
    const carol: RequestIdentity = { subject: "carol", groups: ["guests"], roles: ["network-read"], requestId: "req-carol-1" };
    await invoke(carol, gateway, authority);
    expect(gateway.backendCalls).toHaveLength(0);
    const audit = gateway.audit.at(-1);
    expect(audit).toMatchObject({ subject: "carol", decision: "denied", backendCalled: false, requestId: "req-carol-1" });
  });

  it("rejects a credential minted for a different agent audience (no replay)", async () => {
    const { authority, gateway } = makeGateway();
    const alice: RequestIdentity = { subject: "alice", groups: ["domain-services"], roles: ["infra-read"], requestId: "req-alice-2" };
    const wrongAudienceCredential = await authority.exchange(alice, toolHiveAudience("openshift"), Date.now() + 30_000);
    const call: ToolInvocation = {
      serverId: "active-directory",
      toolName: "get_replication_status",
      arguments: { sourceDc: "DC-TLV-01", mode: "ok" },
      environment: "prod",
      requestId: alice.requestId,
      identity: alice,
      credential: wrongAudienceCredential,
      timeoutMs: 5_000,
    };
    await expect(gateway.invoke(call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(gateway.backendCalls).toHaveLength(0);
  });

  it("rejects a missing credential when the gateway enforces verification", async () => {
    const { gateway } = makeGateway();
    const alice: RequestIdentity = { subject: "alice", groups: ["domain-services"], roles: ["infra-read"], requestId: "req-alice-3" };
    const call: ToolInvocation = {
      serverId: "active-directory",
      toolName: "get_replication_status",
      arguments: { sourceDc: "DC-TLV-01", mode: "ok" },
      environment: "prod",
      requestId: alice.requestId,
      identity: alice,
      timeoutMs: 5_000,
    };
    await expect(gateway.invoke(call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(gateway.backendCalls).toHaveLength(0);
  });
});
