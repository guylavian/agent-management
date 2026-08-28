import { describe, expect, it } from "vitest";
import { agentDocumentSchema, classifyTool } from "@sre/agent-schema";
import { agentDeploymentOverlaySchema, CONFIG_PATHS, loadAgentRegistry } from "@sre/config";
import { parse as parseYaml } from "yaml";
import {
  agentDetail,
  agentSummary,
  buildRunRecord,
  draftToDocument,
  generateAgentChange,
  InMemoryRunStore,
  mcpServerViews,
  permissionMatrix,
  renderAgentYaml,
  AgentDraftError,
  type SpecialistResultLike,
} from "../src/management/index.ts";

const registry = loadAgentRegistry(CONFIG_PATHS);
const specialists = registry.listSpecialists();
const keycloak = registry.getSpecialist("keycloak")!;

describe("agent views", () => {
  it("summarises an agent from its canonical config", () => {
    expect(agentSummary(keycloak)).toMatchObject({
      id: "keycloak",
      displayName: "Keycloak Agent",
      owner: "identity-platform",
      lifecycle: "active",
      enabled: true,
      modelProfile: "tool-caller",
      workloadClientId: "sre-agent-keycloak",
      readOnly: true,
    });
  });

  it("shows denied MCPs explicitly rather than omitting them", () => {
    const detail = agentDetail(keycloak, registry.catalog);
    const prometheus = detail.access.find((entry) => entry.mcp === "prometheus");
    expect(prometheus).toBeDefined();
    expect(prometheus?.allowed).toBe(false);
    expect(prometheus?.allowedTools).toEqual([]);
    expect(prometheus?.audience).toBeUndefined();
  });

  it("lists allowed and blocked tools per MCP with the Keycloak role for each grant", () => {
    const detail = agentDetail(keycloak, registry.catalog);
    const kc = detail.access.find((entry) => entry.mcp === "keycloak")!;
    expect(kc.allowed).toBe(true);
    expect(kc.audience).toBe("sre-toolhive:keycloak");
    expect(kc.audienceScope).toBe("sre-toolhive-keycloak");
    expect(kc.allowedTools.map((tool) => tool.name)).toContain("list_clients");
    expect(kc.allowedTools.find((tool) => tool.name === "list_clients")?.role).toBe("keycloak:list_clients");
    expect(kc.allowedTools.every((tool) => tool.classification === "read")).toBe(true);
  });

  it("classifies a tool absent from the approved catalog as unknown, never read", () => {
    const detail = agentDetail(keycloak, registry.catalog);
    const allTools = detail.access.flatMap((entry) => [...entry.allowedTools, ...entry.blockedTools]);
    expect(allTools.every((tool) => tool.classification !== "write")).toBe(true);
    // a name not in the catalog must not be reported as read
    expect(classifyTool(registry.catalog, "keycloak", "create_user")).toBe("unknown");
    expect(classifyTool(registry.catalog, "keycloak", "list_clients")).toBe("read");
  });

  it("never exposes credentials", () => {
    const serialized = JSON.stringify(specialists.map((agent) => agentDetail(agent, registry.catalog)));
    expect(serialized).not.toMatch(/secret|password|private[_-]?key|bearer /iu);
  });
});

describe("mcp server views", () => {
  it("reports which agents may reach each MCP and the expected audience", () => {
    const servers = mcpServerViews(specialists, registry.catalog, { keycloak: "http://localhost:8301/mcp" });
    const kc = servers.find((server) => server.id === "keycloak")!;
    expect(kc.agents).toEqual(["keycloak"]);
    expect(kc.expectedAudience).toBe("sre-toolhive:keycloak");
    expect(kc.readOnlyVerified).toBe(true);
    expect(kc.toolhiveEndpoint).toBe("http://localhost:8301/mcp");
    // wiki is a shared knowledge source, reachable by several agents
    expect(servers.find((server) => server.id === "wiki")!.agents.length).toBeGreaterThan(1);
  });
});

describe("permission matrix", () => {
  it("is consistent with the canonical policy in both directions", () => {
    const matrix = permissionMatrix(specialists, registry.catalog);
    const kcRow = matrix.rows.find((row) => row.agent === "keycloak")!;
    expect(kcRow.cells.find((cell) => cell.mcp === "keycloak")?.allowed).toBe(true);
    expect(kcRow.cells.find((cell) => cell.mcp === "prometheus")?.allowed).toBe(false);
    expect(kcRow.cells.find((cell) => cell.mcp === "active-directory")?.allowed).toBe(false);
    // MCP → agents is the transpose of agent → MCPs
    const prometheusAgents = matrix.rows.filter((row) => row.cells.find((cell) => cell.mcp === "prometheus")?.allowed).map((row) => row.agent);
    expect(prometheusAgents).toEqual(mcpServerViews(specialists, registry.catalog).find((server) => server.id === "prometheus")!.agents);
  });
});

describe("GitOps YAML generation", () => {
  const draft = {
    name: "check-point",
    owner: "network-security",
    displayName: "Check Point Agent",
    modelTier: "small" as const,
    modelProfile: "tool-caller",
    prompt: "You are the Check Point specialist. Investigate firewall policy and gateway state using only approved read-only tools.",
    requiredRoles: ["network-read"],
    crossDomainAllowed: ["observability"],
    access: [{ mcp: "wiki", tools: ["wiki_search", "wiki_read_page"] }],
  };

  it("derives the workload client id rather than accepting one", () => {
    expect(draftToDocument(draft).spec).toMatchObject({ identity: { provider: "keycloak", clientId: "sre-agent-check-point" } });
  });

  it("defaults a new agent to draft lifecycle, not active", () => {
    expect(draftToDocument(draft).spec.lifecycle).toBe("draft");
  });

  it("produces YAML that the runtime schema accepts", () => {
    const change = generateAgentChange(draft);
    expect(change.path).toBe("config/agents/check-point.yaml");
    expect(agentDocumentSchema.safeParse(parseYaml(change.yaml)).success).toBe(true);
  });

  it("writes the canonical audience for every MCP", () => {
    expect(generateAgentChange(draft).yaml).toContain("audience: sre-toolhive:wiki");
  });

  /**
   * An Agent, a prompt it references and an overlay that decides where it runs
   * are one change or none. Generating the Agent alone would produce a document
   * that fails startup on a missing prompt and is never rendered for any
   * environment.
   */
  it("generates the Agent, its prompt and its deployment overlay as one change-set", () => {
    const change = generateAgentChange(draft);
    expect(change.files.map((file) => file.path)).toEqual([
      "config/agents/check-point.yaml",
      "config/prompts/check-point.md",
      "deploy/environments/production/agents/check-point.yaml",
    ]);
    const prompt = change.files.find((file) => file.path.endsWith(".md"));
    expect(prompt?.contents).toContain("Investigate firewall policy");
    const overlay = change.files.find((file) => file.path.startsWith("deploy/"));
    expect(agentDeploymentOverlaySchema.parse(parseYaml(overlay!.contents))).toMatchObject({ agentId: "check-point", enabled: false });
  });

  it("refuses to generate an Agent that references a prompt it does not create", () => {
    expect(() => generateAgentChange({ ...draft, prompt: "   " })).toThrow(/system prompt is required/u);
  });

  it("rejects an invalid draft instead of generating a broken file", () => {
    expect(() => draftToDocument({ ...draft, name: "Check Point" })).toThrow(AgentDraftError);
    expect(() => draftToDocument({ ...draft, access: [] })).toThrow(AgentDraftError);
    expect(() => draftToDocument({ ...draft, requiredRoles: [] })).toThrow(AgentDraftError);
  });

  it("rejects a draft that tries to smuggle a duplicate MCP", () => {
    expect(() => draftToDocument({ ...draft, access: [{ mcp: "wiki", tools: ["wiki_search"] }, { mcp: "wiki", tools: ["wiki_read_page"] }] })).toThrow(AgentDraftError);
  });

  it("never emits secret material", () => {
    expect(generateAgentChange(draft).yaml).not.toMatch(/secret|password|token:|private[_-]?key/iu);
  });

  it("round-trips the checked-in agents unchanged in meaning", () => {
    for (const agent of specialists) {
      const rendered = renderAgentYaml({ apiVersion: "sre.ai/v1alpha1", kind: "Agent", metadata: { name: agent.name, owner: agent.owner, ...(agent.displayName ? { displayName: agent.displayName } : {}) }, spec: agent.spec });
      const reparsed = agentDocumentSchema.parse(parseYaml(rendered));
      expect(reparsed.spec).toEqual(agent.spec);
    }
  });
});

describe("run store and execution graph", () => {
  const results: SpecialistResultLike[] = [
    {
      agentId: "keycloak",
      status: "complete",
      needsDomain: ["observability"],
      evidence: [
        { id: "ev-1", kind: "config", system: "keycloak", tool: "list_clients", status: "ok" },
        { id: "ev-2", kind: "missing", system: "prometheus", tool: "query", status: "failed" },
      ],
    },
    { agentId: "observability", status: "partial", evidence: [{ id: "ev-3", kind: "telemetry", system: "prometheus", tool: "query", status: "ok" }] },
  ];

  function record() {
    return buildRunRecord({
      requestId: "req-1",
      userSubjectHash: "a".repeat(64),
      environment: "prod",
      startedAt: new Date("2026-08-28T10:00:00.000Z"),
      durationMs: 1234,
      routedAgents: ["keycloak"],
      results,
      workloadFor: (agentId) => registry.getSpecialist(agentId)?.spec.identity.clientId,
      modelProfileFor: (agentId) => registry.getSpecialist(agentId)?.spec.model.profile,
      status: "complete",
      evidenceCount: 3,
      synthesized: true,
    });
  }

  it("builds a fan-out graph with a synthesis fan-in", () => {
    const run = record();
    expect(run.nodes.find((node) => node.kind === "manager.route")).toBeDefined();
    expect(run.nodes.filter((node) => node.kind === "specialist").map((node) => node.label).sort()).toEqual(["keycloak", "observability"]);
    expect(run.nodes.find((node) => node.kind === "synthesis")?.parentId).toBe("manager.route");
  });

  it("marks the agent that was not initially routed as round 2", () => {
    const run = record();
    expect(run.nodes.find((node) => node.id === "specialist.keycloak")?.round).toBe(1);
    expect(run.nodes.find((node) => node.id === "specialist.observability")?.round).toBe(2);
    expect(run.nodes.some((node) => node.kind === "domain.escalation" && node.label === "needs observability")).toBe(true);
  });

  it("records both actors: the human initiator and the agent workloads", () => {
    const run = record();
    expect(run.userSubjectHash).toBe("a".repeat(64));
    expect(run.workloads.sort()).toEqual(["sre-agent-keycloak", "sre-agent-observability"]);
    expect(run.nodes.filter((node) => node.kind === "workload.token").map((node) => node.label).sort()).toEqual(["sre-agent-keycloak", "sre-agent-observability"]);
  });

  it("counts denied tool calls separately", () => {
    const run = record();
    expect(run.toolCalls).toBe(3);
    expect(run.deniedToolCalls).toBe(1);
    expect(run.nodes.find((node) => node.kind === "toolhive.call" && node.mcp === "prometheus" && node.status === "denied")).toBeDefined();
  });

  it("never carries answer text, reasoning or tool payloads", () => {
    const serialized = JSON.stringify(record());
    expect(serialized).not.toMatch(/secret|password|bearer |eyJ/iu);
    expect(record().nodes.every((node) => node.label.length <= 200)).toBe(true);
  });

  it("bounds retained history", () => {
    const store = new InMemoryRunStore(3);
    for (let index = 0; index < 10; index += 1) store.record({ ...record(), requestId: `req-${index}` });
    expect(store.list(100)).toHaveLength(3);
    expect(store.get("req-9")).toBeDefined();
    expect(store.get("req-0")).toBeUndefined();
  });

  it("lists most recent first", () => {
    const store = new InMemoryRunStore();
    store.record({ ...record(), requestId: "older" });
    store.record({ ...record(), requestId: "newer" });
    expect(store.list()[0]?.requestId).toBe("newer");
  });
});
