import { describe, expect, it } from "vitest";
import { MockToolCredentialAuthority, type RequestIdentity, type WorkloadIdentity } from "@sre/auth";
import { MockToolHiveClient, toolHiveAudience } from "@sre/runtime-host";
import { type ToolCallRequest } from "@sre/agent-engine";

/** the Agent's own workload identity — the actor, distinct from the human subject */
const AD_WORKLOAD: WorkloadIdentity = { clientId: "sre-agent-active-directory", provider: "keycloak", agentId: "active-directory" };

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

async function invoke(identity: RequestIdentity, gateway: MockToolHiveClient, authority: MockToolCredentialAuthority): Promise<ToolCallRequest> {
  const deadline = Date.now() + 30_000;
  const credential = await authority.exchange(AD_WORKLOAD, identity, toolHiveAudience("active-directory"), deadline);
  const call: ToolCallRequest = {
    serverId: "active-directory",
    toolName: "get_replication_status",
    arguments: { sourceDc: "DC-TLV-01", targetDc: "DC-HFA-02", mode: "ok" },
    environment: "prod",
    requestId: identity.requestId,
    principal: identity,
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
    // the audit chain records BOTH actors: initiated by the human, executed by the Agent workload
    expect(audit?.workloadClientId).toBe("sre-agent-active-directory");
  });

  it("rejects a credential whose workload actor was swapped after signing", async () => {
    const { authority, gateway } = makeGateway();
    const alice: RequestIdentity = { subject: "alice", groups: ["domain-services"], roles: ["infra-read"], requestId: "req-alice-4" };
    const credential = await authority.exchange(AD_WORKLOAD, alice, toolHiveAudience("active-directory"), Date.now() + 30_000);
    const call: ToolCallRequest = {
      serverId: "active-directory",
      toolName: "get_replication_status",
      arguments: { sourceDc: "DC-TLV-01", mode: "ok" },
      environment: "prod",
      requestId: alice.requestId,
      principal: alice,
      // the signed `act` claim still says active-directory; the envelope lies
      credential: { ...credential, workloadClientId: "sre-agent-openshift" },
      timeoutMs: 5_000,
    };
    await expect(gateway.invoke(call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(gateway.backendCalls).toHaveLength(0);
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
    const wrongAudienceCredential = await authority.exchange(AD_WORKLOAD, alice, toolHiveAudience("openshift"), Date.now() + 30_000);
    const call: ToolCallRequest = {
      serverId: "active-directory",
      toolName: "get_replication_status",
      arguments: { sourceDc: "DC-TLV-01", mode: "ok" },
      environment: "prod",
      requestId: alice.requestId,
      principal: alice,
      credential: wrongAudienceCredential,
      timeoutMs: 5_000,
    };
    await expect(gateway.invoke(call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(gateway.backendCalls).toHaveLength(0);
  });

  it("rejects a missing credential when the gateway enforces verification", async () => {
    const { gateway } = makeGateway();
    const alice: RequestIdentity = { subject: "alice", groups: ["domain-services"], roles: ["infra-read"], requestId: "req-alice-3" };
    const call: ToolCallRequest = {
      serverId: "active-directory",
      toolName: "get_replication_status",
      arguments: { sourceDc: "DC-TLV-01", mode: "ok" },
      environment: "prod",
      requestId: alice.requestId,
      principal: alice,
      timeoutMs: 5_000,
    };
    await expect(gateway.invoke(call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(gateway.backendCalls).toHaveLength(0);
  });
});
