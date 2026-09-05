import { describe, expect, it } from "vitest";
import {
  agentDocumentSchema,
  assertNoSecretMaterial,
  audienceFor,
  isAgentEnabled,
  isToolAllowed,
  workloadClientId,
} from "../src/index.ts";

/** TDD §54 — the canonical Agent schema's fail-closed behaviour. */

const VALID = {
  apiVersion: "sre.ai/v1alpha1",
  kind: "Agent",
  metadata: { name: "check-point", owner: "network-security", displayName: "Check Point Agent", description: "Check Point firewalls and policy management" },
  spec: {
    type: "specialist",
    lifecycle: "active",
    model: { tier: "small", profile: "tool-caller" },
    prompt: { systemFile: "config/prompts/check-point.md" },
    identity: { provider: "keycloak", clientId: "sre-agent-check-point" },
    environments: ["prod", "dr", "lab"],
    routing: { capabilities: ["Check Point policy and gateway state"], exclusions: ["identity administration"] },
    access: [
      { mcp: "wiki", audience: "sre-toolhive:wiki", tools: ["wiki_search"] },
      { mcp: "network", tools: ["get_bgp_status"] },
    ],
    execution: { maxToolCalls: 6, maxModelTurns: 6, timeoutMs: 120000, maxEvidenceBytes: 262144, maxContextTokens: 12000, maxEvidenceItems: 32, maxRawExcerptBytes: 8192 },
    discovery: { allowedNeedsDomains: ["observability"] },
    authorization: { requiredRoles: ["network-read"] },
    security: { readOnly: true },
  },
} as const;

function parse(mutate: (doc: Record<string, any>) => void) {
  const doc = JSON.parse(JSON.stringify(VALID));
  mutate(doc);
  return agentDocumentSchema.safeParse(doc);
}

describe("valid agent", () => {
  it("accepts the canonical shape", () => {
    const result = agentDocumentSchema.safeParse(JSON.parse(JSON.stringify(VALID)));
    expect(result.success).toBe(true);
  });

  it("defaults an omitted audience to the canonical derivation", () => {
    const doc = agentDocumentSchema.parse(JSON.parse(JSON.stringify(VALID)));
    if (doc.spec.type !== "specialist") throw new Error("expected specialist");
    expect(audienceFor(doc.spec, "network")).toBe("sre-toolhive:network");
    expect(audienceFor(doc.spec, "prometheus")).toBeUndefined();
  });

  it("scopes tools per MCP", () => {
    const doc = agentDocumentSchema.parse(JSON.parse(JSON.stringify(VALID)));
    if (doc.spec.type !== "specialist") throw new Error("expected specialist");
    expect(isToolAllowed(doc.spec, "wiki", "wiki_search")).toBe(true);
    expect(isToolAllowed(doc.spec, "network", "wiki_search")).toBe(false);
    expect(isToolAllowed(doc.spec, "prometheus", "wiki_search")).toBe(false);
  });

  it("treats only the active lifecycle as enabled", () => {
    expect(isAgentEnabled({ lifecycle: "active" })).toBe(true);
    for (const lifecycle of ["draft", "disabled", "decommissioning", "removed"] as const) {
      expect(isAgentEnabled({ lifecycle })).toBe(false);
    }
  });
});

describe("fail-closed validation", () => {
  it("rejects a missing identity block", () => {
    expect(parse(doc => { delete doc.spec.identity; }).success).toBe(false);
  });

  it("rejects a workload client id that does not match the agent name", () => {
    expect(parse(doc => { doc.spec.identity.clientId = "sre-agent-something-else"; }).success).toBe(false);
  });

  it("rejects a client id that is not namespaced", () => {
    expect(parse(doc => { doc.spec.identity.clientId = "check-point"; }).success).toBe(false);
  });

  it("rejects a duplicate MCP in the access policy", () => {
    expect(parse(doc => { doc.spec.access.push({ mcp: "wiki", tools: ["wiki_read_page"] }); }).success).toBe(false);
  });

  it("rejects a duplicate tool within one MCP", () => {
    expect(parse(doc => { doc.spec.access[0].tools.push("wiki_search"); }).success).toBe(false);
  });

  it("rejects an audience that does not match its MCP", () => {
    expect(parse(doc => { doc.spec.access[0].audience = "sre-toolhive:keycloak"; }).success).toBe(false);
  });

  it("rejects a catch-all audience", () => {
    expect(parse(doc => { doc.spec.access[0].audience = "sre-toolhive:all"; }).success).toBe(false);
  });

  it("rejects an empty access policy", () => {
    expect(parse(doc => { doc.spec.access = []; }).success).toBe(false);
  });

  it("rejects an agent that discovers itself", () => {
    expect(parse(doc => { doc.spec.discovery.allowedNeedsDomains = ["check-point"]; }).success).toBe(false);
  });

  it("rejects runtime limits outside their bounds", () => {
    expect(parse(doc => { doc.spec.execution.maxToolCalls = 0; }).success).toBe(false);
    expect(parse(doc => { doc.spec.execution.maxToolCalls = 999; }).success).toBe(false);
    expect(parse(doc => { doc.spec.execution.timeoutMs = 10; }).success).toBe(false);
  });

  it("rejects a non-read-only agent", () => {
    expect(parse(doc => { doc.spec.security.readOnly = false; }).success).toBe(false);
  });

  it("rejects an unknown key anywhere in the document", () => {
    expect(parse(doc => { doc.spec.loop = { while: true }; }).success).toBe(false);
    expect(parse(doc => { doc.spec.access[0].onFailure = "retry"; }).success).toBe(false);
    expect(parse(doc => { doc.metadata.extra = 1; }).success).toBe(false);
  });

  it("rejects an unknown lifecycle", () => {
    expect(parse(doc => { doc.spec.lifecycle = "paused"; }).success).toBe(false);
  });

  it("rejects an agent with no required role", () => {
    expect(parse(doc => { doc.spec.authorization.requiredRoles = []; }).success).toBe(false);
  });
});

describe("secret material", () => {
  it("rejects credential-shaped keys", () => {
    for (const key of ["clientSecret", "password", "privateKey", "private_key", "apiKey", "accessToken", "refresh_token"]) {
      expect(() => assertNoSecretMaterial({ [key]: "x" }), key).toThrow(/secret-like key/u);
    }
  });

  it("does not flag legitimate limits that merely contain the word token", () => {
    expect(() => assertNoSecretMaterial({ maxContextTokens: 12_000, tokenBudget: 5 })).not.toThrow();
  });

  it("checks nested structures", () => {
    expect(() => assertNoSecretMaterial({ spec: { access: [{ mcp: "wiki", clientSecret: "x" }] } })).toThrow(/secret-like key/u);
  });
});

describe("derivations", () => {
  it("derives the workload client id from the agent name", () => {
    expect(workloadClientId("network-security")).toBe("sre-agent-network-security");
  });
});
