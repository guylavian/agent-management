import { describe, expect, it } from "vitest";
import type { ListToolsOptions, Principal, ToolCallRequest, ToolCallResult, ToolCredential, ToolDescriptor } from "@sre/agent-engine";
import { withCredentialRefresh, type ToolHiveClient } from "../src/adapters/toolhive.ts";

/**
 * A 120s investigation outlives a 60s credential.
 *
 * The engine acquires one credential per server at setup and caches it for the
 * whole run, so nothing asks the platform for a fresh one mid-run. Every tool
 * call after the token dies would fail with an unexplained authorization error.
 * The refresh happens at the ToolProvider boundary, which IS crossed per call.
 */

const principal: Principal = { subject: "alice", roles: ["infra-read"], groups: [], requestId: "req-1" };

const credential = (token: string, expiresAt: number): ToolCredential =>
  ({ token, audience: "sre-toolhive:keycloak", subjectHash: "a".repeat(64), workloadClientId: "sre-agent-keycloak", expiresAt } as ToolCredential);

class RecordingClient implements ToolHiveClient {
  readonly mode = "real" as const;
  readonly tokensSeen: Array<string | undefined> = [];
  async listTools(_serverId: string, _principal: Principal, _environment: string, options?: ListToolsOptions): Promise<ToolDescriptor[]> {
    this.tokensSeen.push(options?.credential?.token);
    return [];
  }
  async invoke(call: ToolCallRequest): Promise<ToolCallResult> {
    this.tokensSeen.push(call.credential?.token);
    return { content: { ok: true }, observedAt: new Date().toISOString() };
  }
}

const call = (cred: ToolCredential): ToolCallRequest => ({
  serverId: "keycloak", toolName: "list_clients", arguments: {}, environment: "prod",
  requestId: "req-1", principal, credential: cred, timeoutMs: 5_000, attempt: 1, idempotencyKey: "k",
});

describe("a run outliving its credential", () => {
  it("completes a 120s run that crosses the 60s expiry with a valid token throughout", async () => {
    const start = 1_000_000;
    let now = start;
    const issued = [credential("token-first", start + 60_000), credential("token-second", start + 120_000)];
    let exchanges = 0;
    const inner = new RecordingClient();
    const tools = withCredentialRefresh(inner, async () => { exchanges += 1; return issued[1] as ToolCredential; }, () => now);

    // t=0: the credential the engine acquired at setup is used as-is
    await tools.invoke(call(issued[0] as ToolCredential));
    // t=90s: the engine still hands over its cached, now-dead credential
    now = start + 90_000;
    await tools.invoke(call(issued[0] as ToolCredential));
    // t=110s: still within the run
    now = start + 110_000;
    await tools.invoke(call(issued[0] as ToolCredential));

    expect(inner.tokensSeen).toEqual(["token-first", "token-second", "token-second"]);
    // refreshed only when it had to be, not on every call
    expect(exchanges).toBe(2);
  });

  it("refreshes within the skew guard, before the token is actually rejected", async () => {
    const start = 1_000_000;
    let now = start;
    const inner = new RecordingClient();
    const tools = withCredentialRefresh(inner, async () => credential("token-fresh", start + 200_000), () => now);
    // 4s before expiry: inside the 5s guard, so it must not be presented
    now = start + 56_000;
    await tools.invoke(call(credential("token-old", start + 60_000)));
    expect(inner.tokensSeen).toEqual(["token-fresh"]);
  });

  it("does not present a token it knows is dead when the refresh fails", async () => {
    const inner = new RecordingClient();
    const tools = withCredentialRefresh(inner, async () => { throw Object.assign(new Error("idp down"), { code: "TOOL_DENIED" }); }, () => 2_000_000);
    await expect(tools.invoke(call(credential("token-dead", 1_000_000)))).rejects.toMatchObject({ code: "TOOL_DENIED" });
    // the dead token never reached the gateway
    expect(inner.tokensSeen).toEqual([]);
  });

  it("leaves a credential with no stated expiry alone rather than re-minting per call", async () => {
    const inner = new RecordingClient();
    let exchanges = 0;
    const noExpiry = { token: "token-opaque", audience: "sre-toolhive:keycloak" } as ToolCredential;
    const tools = withCredentialRefresh(inner, async () => { exchanges += 1; return noExpiry; }, () => 2_000_000);
    await tools.listTools("keycloak", principal, "prod", { credential: noExpiry });
    expect(exchanges).toBe(0);
    expect(inner.tokensSeen).toEqual(["token-opaque"]);
  });
});
