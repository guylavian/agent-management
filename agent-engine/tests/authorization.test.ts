import { describe, expect, it } from "vitest";
import { authorizeAgent, authorizeAudience, authorizeTool, runAgent, type ApprovedTool } from "../src/index.ts";
import { agentDefinition, ALICE, answerAction, BOB, dependencies, FixtureToolProvider, ScriptedModel, runContext, toolPolicy } from "./harness.ts";

const approved: ApprovedTool = { serverId: "alpha", toolName: "alpha_status", readOnlyVerified: true, environments: ["prod"], timeoutMs: 5_000, retryPolicy: "none", evidenceKind: "telemetry" };

/**
 * Authorization is owned by the engine rather than injected, so these are tests
 * of the engine's own decisions. Each conjunct is checked on its own: removing
 * any single layer must deny, which is what "do not remove one enforcement layer
 * because another exists" means in practice.
 */
describe("runtime authorization", () => {
  it("denies a principal missing a required role", () => {
    expect(authorizeAgent(ALICE, agentDefinition()).allowed).toBe(true);
    expect(authorizeAgent(BOB, agentDefinition()).allowed).toBe(false);
  });

  it("denies a disabled Agent regardless of roles", () => {
    expect(authorizeAgent(ALICE, agentDefinition({ enabled: false })).allowed).toBe(false);
  });

  it("denies when any single tool layer is removed", () => {
    expect(authorizeTool(ALICE, agentDefinition(), approved, "prod").allowed).toBe(true);
    // the Agent's own read-only posture
    expect(authorizeTool(ALICE, agentDefinition({ readOnly: false }), approved, "prod").allowed).toBe(false);
    // the catalog's verification flag
    expect(authorizeTool(ALICE, agentDefinition(), { ...approved, readOnlyVerified: false }, "prod").allowed).toBe(false);
    // the environment list
    expect(authorizeTool(ALICE, agentDefinition(), approved, "staging").allowed).toBe(false);
    // the Agent's per-server tool grant
    expect(authorizeTool(ALICE, agentDefinition(), { ...approved, toolName: "beta_status" }, "prod").allowed).toBe(false);
    // the principal
    expect(authorizeTool(BOB, agentDefinition(), approved, "prod").allowed).toBe(false);
  });

  it("scopes a tool grant per server: the same name on another server is not granted", () => {
    expect(authorizeTool(ALICE, agentDefinition(), { ...approved, serverId: "beta" }, "prod").allowed).toBe(false);
  });

  it("binds a credential to exactly the audience the Agent declares for that server", () => {
    expect(authorizeAudience(agentDefinition(), "alpha", "resource:alpha").allowed).toBe(true);
    expect(authorizeAudience(agentDefinition(), "alpha", "resource:docs").allowed).toBe(false);
    // a server outside policy has no audience, so nothing matches it
    expect(authorizeAudience(agentDefinition(), "beta", "resource:beta").allowed).toBe(false);
  });

  it("denies the whole run for an unauthorized principal, before any provider call", async () => {
    const tools = new FixtureToolProvider();
    const result = await runAgent(agentDefinition(), toolPolicy(), runContext("q", Date.now() + 10_000, { principal: BOB, requestId: BOB.requestId }), dependencies(new ScriptedModel([answerAction("x")]), tools));
    expect(result.status).toBe("failed");
    expect(result.errors).toEqual([expect.objectContaining({ code: "AUTHZ_DENIED" })]);
    expect(tools.calls).toHaveLength(0);
    expect(tools.listedServers).toHaveLength(0);
    // the denial says nothing about which rule denied it
    expect(result.errors?.[0]?.message).not.toMatch(/role|reader|policy|allowlist/iu);
  });
});
