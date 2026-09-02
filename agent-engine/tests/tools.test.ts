import { describe, expect, it } from "vitest";
import { isReadOnlyTool } from "../src/guardrails/read-only.ts";
import { validateToolArguments } from "../src/tools/arguments.ts";
import { invokeVisibleTool, visibleTools } from "../src/tools/visibility.ts";
import type { ToolDescriptor } from "../src/index.ts";
import { agentDefinition, ALICE, BOB, FixtureToolProvider, toolPolicy } from "./harness.ts";

const tool: ToolDescriptor = {
  serverId: "alpha",
  name: "alpha_status",
  description: "Read subsystem status",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target"],
    properties: {
      target: { type: "string", maxLength: 64 },
      peer: { type: "string" },
      mode: { type: "string", enum: ["ok", "failure", "timeout", "denied", "empty"] },
    },
  },
};

describe("tool argument validation", () => {
  it("accepts valid arguments", () => {
    expect(validateToolArguments(tool, { target: "node-1", peer: "node-2", mode: "ok" }).valid).toBe(true);
  });

  it("rejects a missing required argument", () => {
    const result = validateToolArguments(tool, { peer: "node-2" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("coerces a scalar to the declared type, but rejects structure, unknown properties, bad enums and oversized strings", () => {
    // a number where a string is declared is coerced (contract repair), not rejected
    const coercible: Record<string, unknown> = { target: 42 };
    expect(validateToolArguments(tool, coercible).valid).toBe(true);
    expect(validateToolArguments(tool, { target: { nested: true } }).valid).toBe(false);
    expect(validateToolArguments(tool, { target: "node-1", drop: true }).valid).toBe(false);
    expect(validateToolArguments(tool, { target: "node-1", mode: "restart" }).valid).toBe(false);
    expect(validateToolArguments(tool, { target: "x".repeat(65) }).valid).toBe(false);
  });

  it("returns coerced value and never mutates caller args", () => {
    const coercible: Record<string, unknown> = { target: 42 };
    const originalTarget = coercible.target;
    const result = validateToolArguments(tool, coercible);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.target).toBe("42");
      // caller object must NOT be mutated
      expect(coercible.target).toBe(originalTarget);
    }
  });

  it("rejects schemas with misspelled keywords (strict mode)", () => {
    const broken: ToolDescriptor = { ...tool, inputSchema: { type: "object", properties: { x: { type: "string" } }, requird: ["x"] } };
    const result = validateToolArguments(broken, { x: "test" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("fails closed on an uncompilable schema", () => {
    const broken: ToolDescriptor = { ...tool, inputSchema: { type: "object", properties: { x: { type: "not-a-type" } } } };
    expect(validateToolArguments(broken, { x: 1 }).valid).toBe(false);
  });
});

describe("read-only backstop", () => {
  it("rejects mutation names even when a server claims the tool is read-only", () => {
    expect(isReadOnlyTool({ ...tool, name: "update_client", annotations: { readOnlyHint: true } })).toBe(false);
    expect(isReadOnlyTool({ ...tool, name: "delete_series" })).toBe(false);
  });

  it("rejects a destructive annotation and accepts a verified query shape", () => {
    expect(isReadOnlyTool({ ...tool, annotations: { destructiveHint: true } })).toBe(false);
    expect(isReadOnlyTool({ ...tool, name: "query", annotations: { readOnlyHint: true } })).toBe(true);
  });
});

describe("tool visibility", () => {
  const policy = toolPolicy();

  it("is the intersection of policy, published tools, read-only and authorization", async () => {
    const { tools: visible } = await visibleTools(agentDefinition(), policy, new FixtureToolProvider(), ALICE, "prod");
    expect(visible.map(({ schema }) => schema.name).sort()).toEqual(["alpha_health", "alpha_status", "docs_read", "docs_search"]);
  });

  it("is empty for a principal without the Agent's required role", async () => {
    const { tools } = await visibleTools(agentDefinition(), policy, new FixtureToolProvider(), BOB, "prod");
    expect(tools).toHaveLength(0);
  });

  it("is empty for a disabled Agent, whatever the caller's roles", async () => {
    const { tools } = await visibleTools(agentDefinition({ enabled: false }), policy, new FixtureToolProvider(), ALICE, "prod");
    expect(tools).toHaveLength(0);
  });

  it("is empty in an environment the approved tool does not list", async () => {
    const { tools } = await visibleTools(agentDefinition(), policy, new FixtureToolProvider(), ALICE, "staging");
    expect(tools).toHaveLength(0);
  });

  it("survives one unreachable server rather than failing the whole discovery", async () => {
    class PartlyDown extends FixtureToolProvider {
      override async listTools(serverId: string, principal: typeof ALICE, environment: string, options?: Parameters<FixtureToolProvider["listTools"]>[3]) {
        if (serverId === "docs") throw new Error("unreachable");
        return super.listTools(serverId, principal, environment, options);
      }
    }
    const { tools: visible, failures } = await visibleTools(agentDefinition(), policy, new PartlyDown(), ALICE, "prod");
    expect(visible.map(({ schema }) => schema.name).sort()).toEqual(["alpha_health", "alpha_status"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.server).toBe("docs");
  });

  it("re-checks visibility at the moment of the call, not from a cached set", async () => {
    const tools = new FixtureToolProvider();
    const call = { serverId: "alpha", toolName: "alpha_status", arguments: { target: "node-1" }, environment: "prod", requestId: ALICE.requestId, principal: ALICE, timeoutMs: 100 };
    await expect(invokeVisibleTool(agentDefinition({ enabled: false }), policy, tools, call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(tools.calls).toHaveLength(0);
  });

  it("refuses a credential minted for another resource before presenting it anywhere", async () => {
    const tools = new FixtureToolProvider();
    const call = {
      serverId: "alpha", toolName: "alpha_status", arguments: { target: "node-1" }, environment: "prod",
      requestId: ALICE.requestId, principal: ALICE, timeoutMs: 100,
      credential: { token: "t".repeat(24), audience: "resource:docs" },
    };
    await expect(invokeVisibleTool(agentDefinition(), policy, tools, call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(tools.calls).toHaveLength(0);
    expect(tools.listedServers).toHaveLength(0);
  });
});
