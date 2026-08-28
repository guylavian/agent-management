import { describe, expect, it } from "vitest";
import { hashDelegatedSubject, type AgentExecutionRequest } from "@sre/agent-protocol";
import { MockSpecialistTransport } from "../src/index.ts";

const request = (): AgentExecutionRequest => ({
  requestId: "req-dispatch",
  question: "AD replication status",
  environment: "prod",
  identityContext: {
    token: "a".repeat(40),
    tokenType: "urn:ietf:params:oauth:token-type:jwt",
    issuer: "https://mock-manager.sre.local",
    audience: "sre-agent:active-directory",
    subjectHash: hashDelegatedSubject("alice"),
  },
  deadline: new Date(Date.now() + 5_000).toISOString(),
});

describe("specialist dispatch", () => {
  it("provides a deterministic protocol-level transport double", async () => {
    const transport = new MockSpecialistTransport();
    const result = await transport.execute("active-directory", request(), new AbortController().signal);
    expect(result.agentId).toBe("active-directory");
    expect(transport.calls).toHaveLength(1);
  });
});
