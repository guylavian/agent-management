import { engineErrorCodeSchema } from "@sre/engine-contract";
import { runtimeErrorCodeSchema, specialistResultSchema } from "@sre/evidence";
import { describe, expect, it } from "vitest";

describe("contract composition: engine codes ⊆ platform codes", () => {
  it("every engine error code is recognized by the platform", () => {
    const engineCodes = engineErrorCodeSchema.options;
    const platformCodes = runtimeErrorCodeSchema.options;
    for (const code of engineCodes) {
      expect(platformCodes).toContain(code as never);
    }
  });

  it("specialistResultSchema accepts engine-emitted TOOL_TIMEOUT with needsHandoff", () => {
    const result = {
      agentId: "keycloak",
      status: "failed" as const,
      evidence: [],
      errors: [{ code: "TOOL_TIMEOUT", message: "Tool invocation timed out", retryable: true }],
      needsHandoff: ["network-observability"],
    };
    expect(() => specialistResultSchema.parse(result)).not.toThrow();
    const parsed = specialistResultSchema.parse(result);
    expect(parsed.needsHandoff).toEqual(["network-observability"]);
  });
});
