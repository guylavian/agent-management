import type {
  AgentDocument,
  ApprovedCatalog,
  ManagerAgentConfig,
  SpecialistAgentConfig,
} from "./schemas.ts";

function optionalMetadata(doc: AgentDocument): { displayName?: string; description?: string } {
  return {
    ...(doc.metadata.displayName ? { displayName: doc.metadata.displayName } : {}),
    ...(doc.metadata.description ? { description: doc.metadata.description } : {}),
  };
}

export class AgentRegistry {
  readonly #manager: ManagerAgentConfig;
  readonly #specialists: ReadonlyMap<string, SpecialistAgentConfig>;
  readonly catalog: ApprovedCatalog;

  private constructor(
    manager: ManagerAgentConfig,
    specialists: Map<string, SpecialistAgentConfig>,
    catalog: ApprovedCatalog,
  ) {
    this.#manager = Object.freeze(manager);
    this.#specialists = specialists;
    this.catalog = Object.freeze(catalog);
  }

  static build(
    documents: AgentDocument[],
    prompts: Map<string, string>,
    catalog: ApprovedCatalog,
  ): AgentRegistry {
    let manager: ManagerAgentConfig | undefined;
    const specialists = new Map<string, SpecialistAgentConfig>();
    for (const doc of documents) {
      const systemPrompt = prompts.get(doc.metadata.name);
      if (systemPrompt === undefined) throw new Error(`missing prompt for ${doc.metadata.name}`);
      if (doc.spec.type === "manager") {
        manager = { name: doc.metadata.name, owner: doc.metadata.owner, ...optionalMetadata(doc), spec: doc.spec, systemPrompt };
      } else {
        specialists.set(doc.metadata.name, {
          name: doc.metadata.name,
          owner: doc.metadata.owner,
          ...optionalMetadata(doc),
          spec: doc.spec,
          systemPrompt,
        });
      }
    }
    if (manager === undefined) throw new Error("manager missing after semantic validation");
    return new AgentRegistry(manager, specialists, catalog);
  }

  get manager(): ManagerAgentConfig {
    return this.#manager;
  }

  getSpecialist(id: string): SpecialistAgentConfig | undefined {
    return this.#specialists.get(id);
  }

  listSpecialists(): SpecialistAgentConfig[] {
    return [...this.#specialists.values()];
  }
}
