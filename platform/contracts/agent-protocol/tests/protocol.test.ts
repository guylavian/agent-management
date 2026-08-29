import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_REQUEST_BYTES,
  agentExecutionRequestSchema,
  assertSerializedLimit,
  hashDelegatedSubject,
} from "../src/index.ts";

describe("internal agent protocol", () => {
  const request = {
    requestId: "req-1",
    question: "Is AD replication healthy?",
    environment: "prod",
    identityContext: {
      token: "x".repeat(32),
      tokenType: "urn:ietf:params:oauth:token-type:jwt" as const,
      issuer: "mock://manager",
      audience: "sre-agent:active-directory",
      subjectHash: hashDelegatedSubject("alice"),
    },
    deadline: new Date(Date.now() + 1_000).toISOString(),
  };

  it("validates the versioned request and scalar-only handoff", () => {
    expect(agentExecutionRequestSchema.parse(request).requestId).toBe("req-1");
    expect(() => agentExecutionRequestSchema.parse({
      ...request,
      handoff: {
        originalQuestion: "q",
        reasonCode: "r",
        entities: [],
        evidenceRefs: [],
        sanitizedFacts: [{ key: "unsafe", value: { nested: true } }],
      },
    })).toThrow();
  });

  it("enforces serialized request bounds in runtime code", () => {
    expect(() => assertSerializedLimit(request, MAX_AGENT_REQUEST_BYTES, "agent request")).not.toThrow();
    expect(() => assertSerializedLimit({ ...request, question: "x".repeat(MAX_AGENT_REQUEST_BYTES) }, MAX_AGENT_REQUEST_BYTES, "agent request")).toThrow(/size limit/u);
  });
});
