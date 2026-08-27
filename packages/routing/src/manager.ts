import type { AgentRegistry } from "@sre/agent-registry";
import type { ManagerAgentConfig } from "@sre/config";
import type { ModelClient } from "@sre/llm";
import { managerDecisionSchema, type ManagerDecision } from "./schemas.ts";

const jsonSchema = {
  title: "ManagerDecision",
  type: "object",
  additionalProperties: false,
  required: ["agents", "confidence", "abstain"],
  properties: {
    agents: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    alternates: { type: "array", items: { type: "string" } },
    abstain: { type: "boolean" },
    reasonCodes: { type: "array", items: { type: "string" } },
  },
} satisfies Record<string, unknown>;

export class ManagerRouter {
  readonly #model: ModelClient;
  readonly #registry: AgentRegistry;
  readonly #manager: ManagerAgentConfig;
  constructor(model: ModelClient, registry: AgentRegistry, manager: ManagerAgentConfig) {
    this.#model = model;
    this.#registry = registry;
    this.#manager = manager;
  }

  async selectAgents(question: string, authorizedAgentIds: string[], entities: Record<string, string>, signal?: AbortSignal): Promise<ManagerDecision> {
    const allowed = new Set(authorizedAgentIds);
    const descriptors = this.#registry.listEnabled().filter((agent) => allowed.has(agent.agentId)).map((agent) => ({ id: agent.agentId, description: agent.description }));
    const response = await this.#model.chat({ model: this.#manager.spec.model.profile, messages: [{ role: "system", content: this.#manager.systemPrompt }, { role: "user", content: JSON.stringify({ question, trustedEntities: entities, authorizedSpecialists: descriptors }) }], guidedJsonSchema: jsonSchema, signal });
    const decision = managerDecisionSchema.parse(JSON.parse(response.content ?? ""));
    const allIds = [...decision.agents, ...(decision.alternates ?? [])];
    if (allIds.some((id) => !allowed.has(id))) throw Object.assign(new Error("Manager selected an unavailable agent"), { code: "ROUTE_INVALID" });
    const alternates = decision.alternates ?? [];
    if (new Set(decision.agents).size !== decision.agents.length || new Set(alternates).size !== alternates.length || decision.agents.length > this.#manager.spec.execution.maxAgentsPerRequest || alternates.length > this.#manager.spec.execution.maxAgentsPerRequest) throw Object.assign(new Error("Manager selection violates bounds"), { code: "ROUTE_INVALID" });
    return decision;
  }
}

export function resolveAbstentionFanout(decision: ManagerDecision, authorizedAgentIds: string[], maxAgents: number): string[] {
  const alternates = [...new Set(decision.alternates ?? [])];
  const authorized = new Set(authorizedAgentIds);
  if (!decision.abstain || alternates.length < 2 || alternates.some((id) => !authorized.has(id)) || maxAgents < 2) return [];
  return alternates.slice(0, 2);
}
