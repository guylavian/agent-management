import { describe, expect, it } from "vitest";
import { MockToolHiveClient } from "../src/index.ts";

const alice = { subject: "alice", groups: ["domain-services"], roles: ["infra-read"], requestId: "req-1" };
const bob = { subject: "bob", groups: ["network"], roles: ["network-read"], requestId: "req-2" };

describe("mock ToolHive", () => {
  it("serves parameterized read-only tools", async () => {
    const client = new MockToolHiveClient();
    const tools = await client.listTools("active-directory", alice, "prod");
    expect(tools).toHaveLength(4);
    const result = await client.invoke({ serverId: "active-directory", toolName: "get_replication_status", arguments: { sourceDc: "DC1", targetDc: "DC2" }, environment: "prod", requestId: "req-1", identity: alice, timeoutMs: 100 });
    expect(result.content).toMatchObject({ sourceDc: "DC1", targetDc: "DC2", failures: 0 });
  });

  it("supports denied, empty, failure and timeout modes", async () => {
    const client = new MockToolHiveClient();
    await expect(client.invoke({ serverId: "active-directory", toolName: "get_dc_health", arguments: { dc: "DC1" }, environment: "prod", requestId: "req-2", identity: bob, timeoutMs: 10 })).rejects.toMatchObject({ code: "TOOL_DENIED" });
    await expect(client.invoke({ serverId: "active-directory", toolName: "get_dc_health", arguments: { dc: "DC1", mode: "failure" }, environment: "prod", requestId: "req-1", identity: alice, timeoutMs: 10 })).rejects.toMatchObject({ code: "TOOL_FAILED" });
    await expect(client.invoke({ serverId: "active-directory", toolName: "get_dc_health", arguments: { dc: "DC1", mode: "timeout" }, environment: "prod", requestId: "req-1", identity: alice, timeoutMs: 10 })).rejects.toMatchObject({ code: "MCP_TIMEOUT" });
    await expect(client.invoke({ serverId: "active-directory", toolName: "get_dc_health", arguments: { dc: "DC1", mode: "empty" }, environment: "prod", requestId: "req-1", identity: alice, timeoutMs: 10 })).resolves.toMatchObject({ content: [] });
  });
});
