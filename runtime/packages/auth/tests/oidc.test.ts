import { describe, expect, it } from "vitest";
import { MockOidcClient } from "../src/index.ts";

describe("mock OIDC", () => {
  it("issues verifiable tokens for distinct entitlements", async () => {
    const oidc = new MockOidcClient({ issuer: "https://mock-idp.sre.local", audience: "sre-assistant" });
    const alice = await oidc.verify(await oidc.issueTestToken("alice"), "req-a");
    const bob = await oidc.verify(await oidc.issueTestToken("bob"), "req-b");
    expect(alice.subject).not.toBe(bob.subject);
    expect(alice.roles).toContain("infra-read");
    expect(bob.roles).toEqual(["network-read"]);
  });

  it("rejects an expired token", async () => {
    const oidc = new MockOidcClient({ issuer: "https://mock-idp.sre.local", audience: "sre-assistant" });
    await expect(oidc.verify(await oidc.issueTestToken("alice", -1), "req-expired")).rejects.toThrow();
  });
});
