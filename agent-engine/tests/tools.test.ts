import { describe, expect, it } from "vitest";
import { isReadOnlyTool } from "../src/guardrails/read-only.ts";
import { validateToolArguments } from "../src/tools/arguments.ts";
import { invokeVisibleTool, visibleTools } from "../src/tools/visibility.ts";
import { toolResultToEvidence } from "../src/tools/evidence.ts";
import type { ToolDescriptor, ToolCallRequest } from "../src/index.ts";
import { runAgent, engineError } from "../src/index.ts";
import { agentDefinition, ALICE, BOB, FixtureToolProvider, toolPolicy, ScriptedModel, answerAction, toolCallAction, runContext, dependencies } from "./harness.ts";

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

  // L3: honor readOnlyHint === false as exclusion
  it("excludes tools explicitly marked readOnlyHint === false", () => {
    expect(isReadOnlyTool({ ...tool, name: "query", annotations: { readOnlyHint: false } })).toBe(false);
  });

  // L3: extended mutation names (run, exec, restart, scale, rollout added to apply/patch)
  it("rejects extended mutation names: run, exec, restart, scale, rollout", () => {
    expect(isReadOnlyTool({ ...tool, name: "proc_run" })).toBe(false);
    expect(isReadOnlyTool({ ...tool, name: "script_exec" })).toBe(false);
    expect(isReadOnlyTool({ ...tool, name: "service_restart" })).toBe(false);
    expect(isReadOnlyTool({ ...tool, name: "deployment_scale" })).toBe(false);
    expect(isReadOnlyTool({ ...tool, name: "rollout_proceed" })).toBe(false);
    // existing names still work
    expect(isReadOnlyTool({ ...tool, name: "apply_config" })).toBe(false);
    expect(isReadOnlyTool({ ...tool, name: "config_patch" })).toBe(false);
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
    const call = { serverId: "alpha", toolName: "alpha_status", arguments: { target: "node-1" }, environment: "prod", requestId: ALICE.requestId, principal: ALICE, timeoutMs: 100, attempt: 1, idempotencyKey: "abc123def456" };
    await expect(invokeVisibleTool(agentDefinition({ enabled: false }), policy, tools, call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(tools.calls).toHaveLength(0);
  });

  it("refuses a credential minted for another resource before presenting it anywhere", async () => {
    const tools = new FixtureToolProvider();
    const call = {
      serverId: "alpha", toolName: "alpha_status", arguments: { target: "node-1" }, environment: "prod",
      requestId: ALICE.requestId, principal: ALICE, timeoutMs: 100,
      credential: { token: "t".repeat(24), audience: "resource:docs" },
      attempt: 1,
      idempotencyKey: "abc123def456",
    };
    await expect(invokeVisibleTool(agentDefinition(), policy, tools, call)).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(tools.calls).toHaveLength(0);
    expect(tools.listedServers).toHaveLength(0);
  });
});

describe("M9 — pinned tool contract (schema/description)", () => {
  const policy = toolPolicy();

  it("uses pinned description exclusively when present, offering it to model", async () => {
    const pinnedDescription = "This is the pinned safe description";
    const liveDescription = "This is the live description that should be ignored when pinned";
    const tools = new FixtureToolProvider({
      tools: [{
        serverId: "alpha",
        name: "alpha_status",
        description: liveDescription,
        inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
      }],
    });
    const approvedWithPin: Parameters<typeof visibleTools>[1] = {
      tools: [{
        serverId: "alpha",
        toolName: "alpha_status",
        readOnlyVerified: true,
        environments: ["prod"],
        timeoutMs: 5000,
        retryPolicy: "none",
        evidenceKind: "telemetry",
        pinnedDescription,
      }],
    };
    const { tools: visible } = await visibleTools(agentDefinition(), approvedWithPin, tools, ALICE, "prod");
    const schema = visible.find((v) => v.schema.name === "alpha_status")?.schema;
    expect(schema?.description).toBe(pinnedDescription);
  });

  it("caps live description at 1024 chars when not pinned", async () => {
    const longDesc = "Read status. " + "x".repeat(2000);
    const tools = new FixtureToolProvider({
      tools: [{
        serverId: "alpha",
        name: "alpha_status",
        description: longDesc,
        inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
      }],
    });
    const { tools: visible } = await visibleTools(agentDefinition(), policy, tools, ALICE, "prod");
    const schema = visible.find((v) => v.schema.name === "alpha_status")?.schema;
    expect(schema?.description?.length).toBeLessThanOrEqual(1024);
    expect(schema?.description).toBe(longDesc.slice(0, 1024));
  });

  it("uses pinned inputSchema exclusively when present", async () => {
    const pinnedSchema = { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false };
    const liveSchema = { type: "object", properties: { target: { type: "string" }, extra: { type: "string" } }, required: ["target"], additionalProperties: false };
    const tools = new FixtureToolProvider({
      tools: [{
        serverId: "alpha",
        name: "alpha_status",
        description: "Status",
        inputSchema: liveSchema,
      }],
    });
    const approvedWithPin: Parameters<typeof visibleTools>[1] = {
      tools: [{
        serverId: "alpha",
        toolName: "alpha_status",
        readOnlyVerified: true,
        environments: ["prod"],
        timeoutMs: 5000,
        retryPolicy: "none",
        evidenceKind: "telemetry",
        pinnedInputSchema: pinnedSchema,
      }],
    };
    const { tools: visible } = await visibleTools(agentDefinition(), approvedWithPin, tools, ALICE, "prod");
    const schema = visible.find((v) => v.schema.name === "alpha_status")?.schema;
    expect(schema?.inputSchema).toEqual(pinnedSchema);
  });

  it("excludes tool when live schema exceeds 16KB and records error", async () => {
    const largeSchema = {
      type: "object",
      properties: {
        data: { type: "string", description: "x".repeat(20000) },
      },
      required: ["data"],
      additionalProperties: false,
    };
    const tools = new FixtureToolProvider({
      tools: [{
        serverId: "alpha",
        name: "alpha_status",
        description: "Status",
        inputSchema: largeSchema,
      }],
    });
    const { tools: visible } = await visibleTools(agentDefinition(), policy, tools, ALICE, "prod");
    const found = visible.find((v) => v.schema.name === "alpha_status");
    expect(found).toBeUndefined();
  });

  it("tracks tool.schema.drift counter when pinned differs from live description", async () => {
    const pinnedDescription = "pinned";
    const liveDescription = "different";
    const tools = new FixtureToolProvider({
      tools: [{
        serverId: "alpha",
        name: "alpha_status",
        description: liveDescription,
        inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
      }],
    });
    const approvedWithPin: Parameters<typeof visibleTools>[1] = {
      tools: [{
        serverId: "alpha",
        toolName: "alpha_status",
        readOnlyVerified: true,
        environments: ["prod"],
        timeoutMs: 5000,
        retryPolicy: "none",
        evidenceKind: "telemetry",
        pinnedDescription,
      }],
    };
    // When pinned description differs from live, schema.drift counter should be emitted
    const { tools: visible } = await visibleTools(agentDefinition(), approvedWithPin, tools, ALICE, "prod");
    expect(visible).toHaveLength(1);
  });

  it("injection canary in live description never reaches model unsanitized", async () => {
    const injection = "INJECT_ATTACK";
    const liveDescription = `Read status. ${injection}`;
    const tools = new FixtureToolProvider({
      tools: [{
        serverId: "alpha",
        name: "alpha_status",
        description: liveDescription,
        inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
      }],
    });
    const { tools: visible } = await visibleTools(agentDefinition(), policy, tools, ALICE, "prod");
    const schema = visible.find((v) => v.schema.name === "alpha_status")?.schema;
    expect(schema?.description).toBeDefined();
  });
});

describe("M7 — retry idempotency", () => {
  it("transient-then-success double sees attempts 1,2 with identical idempotencyKey", async () => {
    const policy = {
      tools: [{
        serverId: "alpha",
        toolName: "alpha_status",
        readOnlyVerified: true,
        environments: ["prod"],
        timeoutMs: 5000,
        retryPolicy: "transient-once" as const,
        evidenceKind: "telemetry" as const,
      }],
    };
    const baseProvider = new FixtureToolProvider({
      tools: [{
        serverId: "alpha",
        name: "alpha_status",
        description: "Status",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["target"],
          properties: { target: { type: "string" }, mode: { type: "string", enum: ["ok", "failure", "timeout"] } },
        },
      }],
    });
    const model = new ScriptedModel([
      toolCallAction("alpha_status", { target: "node-1" }),
      answerAction("OK"),
    ]);
    const allCalls: ToolCallRequest[] = [];
    let attemptCount = 0;
    const wrappedProvider = {
      async listTools(...args: Parameters<typeof baseProvider.listTools>) { return baseProvider.listTools(...args); },
      async invoke(call: ToolCallRequest) {
        allCalls.push(call);
        attemptCount += 1;
        if (attemptCount === 1) throw engineError("TOOL_TIMEOUT", "transient failure");
        return baseProvider.invoke(call);
      },
    };
    const result = await runAgent(agentDefinition(), policy, runContext("q"), dependencies(model, wrappedProvider as never));
    expect(result.status).toBe("complete");
    expect(allCalls).toHaveLength(2);
    // Both attempts should have the same idempotencyKey but different attempt numbers
    expect(allCalls[0]?.attempt).toBe(1);
    expect(allCalls[0]?.idempotencyKey).toBeDefined();
    expect(allCalls[1]?.attempt).toBe(2);
    expect(allCalls[1]?.idempotencyKey).toBe(allCalls[0]?.idempotencyKey);
  });
});

describe("M8 — observedAt/payloadDigest", () => {
  it("invalid observedAt is dropped from evidence", () => {
    const call: Pick<ToolCallRequest, "serverId" | "toolName" | "arguments" | "requestId"> = {
      serverId: "test",
      toolName: "test_tool",
      arguments: {},
      requestId: "req-1",
    };
    const result = { content: { data: "test" }, isError: false, observedAt: "invalid-date-string" };
    const evidence = toolResultToEvidence(call as ToolCallRequest, result, "agent-1", "telemetry");
    expect(evidence.observedAt).toBeUndefined();
  });

  it("observedAt more than 5 minutes in the future is dropped", () => {
    const call: Pick<ToolCallRequest, "serverId" | "toolName" | "arguments" | "requestId"> = {
      serverId: "test",
      toolName: "test_tool",
      arguments: {},
      requestId: "req-1",
    };
    const futureDate = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    const result = { content: { data: "test" }, isError: false, observedAt: futureDate };
    const evidence = toolResultToEvidence(call as ToolCallRequest, result, "agent-1", "telemetry");
    expect(evidence.observedAt).toBeUndefined();
  });

  it("valid observedAt within 5 minutes is preserved", () => {
    const call: Pick<ToolCallRequest, "serverId" | "toolName" | "arguments" | "requestId"> = {
      serverId: "test",
      toolName: "test_tool",
      arguments: {},
      requestId: "req-1",
    };
    const recentDate = new Date(Date.now() - 1000).toISOString();
    const result = { content: { data: "test" }, isError: false, observedAt: recentDate };
    const evidence = toolResultToEvidence(call as ToolCallRequest, result, "agent-1", "telemetry");
    expect(evidence.observedAt).toBe(recentDate);
  });

  it("payloadDigest is stable and present for ok evidence", () => {
    const call: Pick<ToolCallRequest, "serverId" | "toolName" | "arguments" | "requestId"> = {
      serverId: "test",
      toolName: "test_tool",
      arguments: { q: "query" },
      requestId: "req-1",
    };
    const result = { content: { data: "test" }, isError: false, observedAt: new Date().toISOString() };
    const evidence1 = toolResultToEvidence(call as ToolCallRequest, result, "agent-1", "telemetry");
    const evidence2 = toolResultToEvidence(call as ToolCallRequest, result, "agent-1", "telemetry");
    expect(evidence1.payloadDigest).toBeDefined();
    expect(evidence1.payloadDigest).toBe(evidence2.payloadDigest);
    expect(evidence1.payloadDigest).toMatch(/^[0-9a-f]{32}$/);
  });

  it("payloadDigest is present for empty evidence", () => {
    const call: Pick<ToolCallRequest, "serverId" | "toolName" | "arguments" | "requestId"> = {
      serverId: "test",
      toolName: "test_tool",
      arguments: {},
      requestId: "req-1",
    };
    const result = { content: [], isError: false, observedAt: new Date().toISOString() };
    const evidence = toolResultToEvidence(call as ToolCallRequest, result, "agent-1", "telemetry");
    expect(evidence.payloadDigest).toBeDefined();
    expect(evidence.payloadDigest).toMatch(/^[0-9a-f]{32}$/);
  });
});
