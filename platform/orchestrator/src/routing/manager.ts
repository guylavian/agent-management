import type { AgentCatalog } from "@sre/config";
import type { ManagerAgentConfig } from "@sre/config";
import type { ModelClient } from "@sre/llm";
import { managerDecisionSchema, type ManagerDecision } from "./schemas.ts";

const jsonSchema = {
  title: "ManagerDecision",
  type: "object",
  additionalProperties: false,
  // Strict OpenAI-compatible providers (including Groq) require every property
  // declared here to appear in `required`, so a field cannot be "optional" in
  // this schema — it is either demanded of the model or absent from it. That
  // makes every property a cost: more tokens to emit and one more thing to get
  // wrong before the response validates at all.
  //
  // `confidence` used to be here and nothing read it. Each field below has a
  // consumer: `alternates` feeds resolveAbstentionFanout, `reasonCodes` feeds
  // classifyIntent, `rationale` is recorded on the run trace. The Zod schema
  // stays permissive about `confidence` so a producer that still sends one is
  // not rejected at the boundary.
  required: ["routes", "alternates", "abstain", "reasonCodes"],
  properties: {
    routes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["agent", "task", "rationale"],
        properties: {
          agent: { type: "string" },
          // The RECEIVING schema accepts 2000 (managerRouteSchema), because a
          // long task is valid; what is not survivable is generating one. A
          // model that spends its completion budget writing four paragraphs of
          // task never emits `abstain`, and a strict provider rejects the whole
          // response — the request then fails with nothing routed, which is
          // what happened. Bound what may be GENERATED, and stay permissive
          // about what may arrive.
          task: { type: "string", minLength: 1, maxLength: 400, description: "One or two sentences: what this specialist should investigate. Not a plan." },
          rationale: { type: "string", maxLength: 300, description: "One sentence: why this specialist for this request." },
        },
      },
    },
    alternates: { type: "array", items: { type: "string" }, description: "Specialists to consult if abstaining because two or more fit equally. Empty otherwise." },
    abstain: { type: "boolean", description: "True when no specialist clearly owns the request. Then routes is empty." },
    reasonCodes: { type: "array", items: { type: "string" }, description: "Short machine tags for why, e.g. causal-question. Empty when unremarkable." },
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

    // A response that is not the agreed shape is a MANAGER problem, and saying so
    // separates a prompt or schema regression from an agent that does not exist.
    let decision: ManagerDecision;
    try {
      decision = managerDecisionSchema.parse(JSON.parse(response.content ?? ""));
    } catch {
      throw Object.assign(new Error("Manager returned an unusable decision"), { code: "MANAGER_OUTPUT_INVALID" });
    }

    const agents = decision.routes.map((route) => route.agent);
    const alternates = decision.alternates ?? [];
    for (const id of [...agents, ...alternates]) {
      if (offered.has(id)) continue;
      // Distinguishing these is the whole point: an agent this environment does
      // not run is a DEPLOYMENT fact and a fixable one, while a name that exists
      // nowhere means the model invented it. Both are refused identically.
      const known = this.#registry.resolve(id) !== undefined;
      throw known
        ? Object.assign(new Error("Manager selected an agent this environment does not run"), { code: "DISABLED_AGENT" })
        : Object.assign(new Error("Manager selected an agent that does not exist"), { code: "UNKNOWN_AGENT" });
    }
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
