import type { AgentCatalog } from "@sre/config";
import type { ManagerAgentConfig } from "@sre/config";
import type { ModelClient } from "@sre/llm";
import { managerDecisionSchema, type ManagerDecision } from "./schemas.ts";

const jsonSchema = {
  title: "ManagerDecision",
  type: "object",
  additionalProperties: false,
  // Strict OpenAI-compatible providers (including Groq) require every
  // property declared by a response-format schema to appear in `required`.
  // Optional semantics are represented by empty arrays in the model response
  // and remain optional in the runtime/Zod domain type for compatibility.
  required: ["routes", "confidence", "alternates", "abstain", "reasonCodes"],
  properties: {
    routes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["agent", "task"],
        properties: {
          agent: { type: "string" },
          task: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    alternates: { type: "array", items: { type: "string" } },
    abstain: { type: "boolean" },
    reasonCodes: { type: "array", items: { type: "string" } },
  },
} satisfies Record<string, unknown>;

export class ManagerRouter {
  readonly #model: ModelClient;
  readonly #registry: AgentCatalog;
  readonly #manager: ManagerAgentConfig;
  constructor(model: ModelClient, registry: AgentCatalog, manager: ManagerAgentConfig) {
    this.#model = model;
    this.#registry = registry;
    this.#manager = manager;
  }

  async selectAgents(question: string, authorizedAgentIds: string[], entities: Record<string, string>, signal?: AbortSignal): Promise<ManagerDecision> {
    const authorized = new Set(authorizedAgentIds);
    // descriptors are supplied dynamically from the registry (config), never hardcoded in the prompt
    const descriptors = this.#registry.listEnabled().filter((agent) => authorized.has(agent.agentId)).map((agent) => ({
      id: agent.agentId,
      description: agent.description,
      ...(agent.routing.capabilities.length > 0 ? { capabilities: agent.routing.capabilities } : {}),
      ...(agent.routing.exclusions.length > 0 ? { exclusions: agent.routing.exclusions } : {}),
    }));
    // The model may only choose from what it was actually shown. Validating
    // against `authorized` instead would admit an agent that is authorized but
    // DISABLED: withheld from the catalog, yet waved through here the moment the
    // model named it from conversation context or its own prior. The offered set
    // is enabled ∩ authorized, so it is the only honest thing to check against.
    const offered = new Set(descriptors.map((agent) => agent.id));
    const response = await this.#model.chat({ model: this.#manager.spec.model.profile, messages: [{ role: "system", content: this.#manager.systemPrompt }, { role: "user", content: JSON.stringify({ question, trustedEntities: entities, authorizedSpecialists: descriptors }) }], guidedJsonSchema: jsonSchema, signal });
    const decision = managerDecisionSchema.parse(JSON.parse(response.content ?? ""));
    const agents = decision.routes.map((route) => route.agent);
    const alternates = decision.alternates ?? [];
    if ([...agents, ...alternates].some((id) => !offered.has(id))) throw Object.assign(new Error("Manager selected an unavailable agent"), { code: "ROUTE_INVALID" });
    if (new Set(agents).size !== agents.length || new Set(alternates).size !== alternates.length || agents.length > this.#manager.spec.execution.maxAgentsPerRequest || alternates.length > this.#manager.spec.execution.maxAgentsPerRequest) throw Object.assign(new Error("Manager selection violates bounds"), { code: "ROUTE_INVALID" });
    return decision;
  }
}

export function resolveAbstentionFanout(decision: ManagerDecision, authorizedAgentIds: string[], maxAgents: number): string[] {
  const alternates = [...new Set(decision.alternates ?? [])];
  const authorized = new Set(authorizedAgentIds);
  if (!decision.abstain || alternates.length < 2 || alternates.some((id) => !authorized.has(id)) || maxAgents < 2) return [];
  return alternates.slice(0, 2);
}
