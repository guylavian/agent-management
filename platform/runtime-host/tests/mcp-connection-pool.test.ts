import { describe, expect, it } from "vitest";
import type { ToolCredential } from "@sre/agent-engine";
import { McpConnectionPool } from "../src/adapters/toolhive.ts";

/**
 * One tool call used to cost at least two connect/close cycles, because the
 * engine re-checks visibility before every invocation. Connections are reused
 * — but never across credentials, because the bearer token lives in the
 * transport headers and sharing one would let a later call ride an earlier
 * human's identity.
 */

const credential = (token: string): ToolCredential => ({ token, audience: "sre-toolhive:keycloak" } as ToolCredential);

class FakeClient {
  closed = false;
  async close(): Promise<void> { this.closed = true; }
}

function counting() {
  let opened = 0;
  const created: FakeClient[] = [];
  return {
    get opened() { return opened; },
    created,
    connect: async () => { opened += 1; const client = new FakeClient(); created.push(client); return client as never; },
  };
}

describe("MCP connections are reused within a run", () => {
  it("opens one connection for repeated calls to the same server with the same credential", async () => {
    const pool = new McpConnectionPool();
    const factory = counting();
    const cred = credential("token-a");
    // the pattern a single tool call actually produces: discovery, re-check, invoke
    await pool.getConnection("keycloak", cred, factory.connect);
    await pool.getConnection("keycloak", cred, factory.connect);
    await pool.getConnection("keycloak", cred, factory.connect);
    // before pooling this was 3 connect/close cycles
    expect(factory.opened).toBe(1);
  });

  it("never shares a connection across credentials", async () => {
    const pool = new McpConnectionPool();
    const factory = counting();
    await pool.getConnection("keycloak", credential("alice-token"), factory.connect);
    await pool.getConnection("keycloak", credential("bob-token"), factory.connect);
    expect(factory.opened).toBe(2);
    expect(pool.size).toBe(2);
  });

  it("keeps different servers on different connections", async () => {
    const pool = new McpConnectionPool();
    const factory = counting();
    const cred = credential("token-a");
    await pool.getConnection("keycloak", cred, factory.connect);
    await pool.getConnection("prometheus", cred, factory.connect);
    expect(factory.opened).toBe(2);
  });

  it("closes an idle connection past its lifetime instead of leaking it", async () => {
    let now = 1_000_000;
    const pool = new McpConnectionPool({ ttlMs: 30_000, now: () => now });
    const factory = counting();
    const cred = credential("token-a");
    await pool.getConnection("keycloak", cred, factory.connect);
    now += 31_000;
    await pool.getConnection("keycloak", cred, factory.connect);
    expect(factory.opened).toBe(2);
    expect(factory.created[0]?.closed).toBe(true);
  });

  it("closes everything it holds when the process shuts down", async () => {
    const pool = new McpConnectionPool();
    const factory = counting();
    await pool.getConnection("keycloak", credential("token-a"), factory.connect);
    await pool.getConnection("prometheus", credential("token-a"), factory.connect);
    await pool.dispose();
    expect(factory.created.every((client) => client.closed)).toBe(true);
    expect(pool.size).toBe(0);
  });
});
