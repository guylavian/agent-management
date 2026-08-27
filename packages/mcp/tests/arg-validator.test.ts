import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../src/arg-validator.ts";
import type { McpTool } from "../src/toolhive-client.ts";

const tool: McpTool = {
  serverId: "active-directory",
  name: "get_replication_status",
  description: "Read AD replication health",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourceDc"],
    properties: {
      sourceDc: { type: "string", maxLength: 64 },
      targetDc: { type: "string" },
      mode: { type: "string", enum: ["ok", "failure", "timeout", "denied", "empty"] },
    },
  },
};

describe("tool argument schema validation (pre-ToolHive)", () => {
  it("accepts valid arguments", () => {
    expect(validateToolArguments(tool, { sourceDc: "DC-TLV-01", targetDc: "DC-HFA-02", mode: "ok" }).valid).toBe(true);
  });

  it("rejects a missing required argument", () => {
    const result = validateToolArguments(tool, { targetDc: "DC-HFA-02" });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("rejects a wrong argument type", () => {
    expect(validateToolArguments(tool, { sourceDc: 42 }).valid).toBe(false);
  });

  it("rejects an unknown property", () => {
    expect(validateToolArguments(tool, { sourceDc: "DC-TLV-01", drop: true }).valid).toBe(false);
  });

  it("rejects an invalid enum value", () => {
    expect(validateToolArguments(tool, { sourceDc: "DC-TLV-01", mode: "restart" }).valid).toBe(false);
  });

  it("rejects an oversized string", () => {
    expect(validateToolArguments(tool, { sourceDc: "x".repeat(65) }).valid).toBe(false);
  });

  it("fails closed on an uncompilable schema", () => {
    const broken: McpTool = { ...tool, inputSchema: { type: "object", properties: { x: { type: "not-a-type" } } } };
    expect(validateToolArguments(broken, { x: 1 }).valid).toBe(false);
  });
});
