import { describe, expect, it } from "vitest";
import { MockDelegationAuthority } from "../src/index.ts";

describe("delegated identity context", () => {
  it("binds signed human identity to agent audience and request ID", async () => {
    const authority = new MockDelegationAuthority({ issuer: "mock://manager", secret: "local-test-delegation-secret-32-bytes-minimum" });
    const identity = { subject: "alice", groups: ["domain-services"], roles: ["infra-read"], requestId: "req-delegated" };
    const context = await authority.issue(identity, "sre-agent:active-directory", Date.now() + 5_000);
    await expect(authority.verify(context, "sre-agent:active-directory", identity.requestId)).resolves.toEqual(identity);
    await expect(authority.verify(context, "sre-agent:openshift", identity.requestId)).rejects.toThrow();
    await expect(authority.verify(context, "sre-agent:active-directory", "other-request")).rejects.toThrow();
  });
});
