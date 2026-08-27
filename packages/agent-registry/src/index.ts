import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const agentRoutingSchema = z.object({
  // whole-phrase, case-insensitive terms that resolve to this agent (high precision)
  exactTerms: z.array(z.string().min(2)).default([]),
  // regexes (source strings) tested against the question; a match routes and yields an entity
  entityPatterns: z.array(z.string().min(1)).default([]),
  // overloaded terms that MUST NOT resolve routing on their own (precision guard, documentation)
  ambiguousTerms: z.array(z.string().min(1)).default([]),
}).strict();
export type AgentRouting = z.infer<typeof agentRoutingSchema>;

export const agentRegistryEntrySchema = z.object({
  agentId: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  endpoint: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "endpoint must use HTTP(S)"),
  owner: z.string().min(1),
  description: z.string().min(1).max(500),
  enabled: z.boolean(),
  environments: z.array(z.string().min(1)).min(1),
  requiredRoles: z.array(z.string().min(1)).min(1),
  allowedNeedsDomains: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/u)).max(8).default([]),
  routing: agentRoutingSchema.default({ exactTerms: [], entityPatterns: [], ambiguousTerms: [] }),
}).strict();
export type AgentRegistryEntry = z.infer<typeof agentRegistryEntrySchema>;

export const agentServiceRegistryDocumentSchema = z.object({
  apiVersion: z.literal("sre.ai/v1alpha1"),
  kind: z.literal("AgentServiceRegistry"),
  agents: z.array(agentRegistryEntrySchema).min(1),
}).strict();

export interface AgentRegistry {
  resolve(agentId: string): AgentRegistryEntry | undefined;
  listEnabled(environment?: string): AgentRegistryEntry[];
  filterAuthorized(agentIds: string[], roles: string[], environment: string): string[];
  mayRequestDomain(originAgentId: string, targetAgentId: string): boolean;
}

export class StaticAgentRegistry implements AgentRegistry {
  readonly #entries: ReadonlyMap<string, Readonly<AgentRegistryEntry>>;

  constructor(entries: AgentRegistryEntry[]) {
    const mapped = new Map<string, Readonly<AgentRegistryEntry>>();
    for (const entry of entries) {
      if (mapped.has(entry.agentId)) throw new Error(`duplicate registry agentId ${entry.agentId}`);
      mapped.set(entry.agentId, Object.freeze(structuredClone(entry)));
    }
    for (const entry of mapped.values()) {
      for (const target of entry.allowedNeedsDomains) {
        if (!mapped.has(target) || target === entry.agentId) throw new Error(`invalid discovery edge ${entry.agentId} -> ${target}`);
      }
    }
    this.#entries = mapped;
  }

  resolve(agentId: string): AgentRegistryEntry | undefined {
    return this.#entries.get(agentId);
  }

  listEnabled(environment?: string): AgentRegistryEntry[] {
    return [...this.#entries.values()].filter((entry) => entry.enabled && (environment === undefined || entry.environments.includes(environment)));
  }

  filterAuthorized(agentIds: string[], roles: string[], environment: string): string[] {
    return [...new Set(agentIds)].filter((agentId) => {
      const entry = this.#entries.get(agentId);
      return entry !== undefined && entry.enabled && entry.environments.includes(environment) && entry.requiredRoles.every((role) => roles.includes(role));
    });
  }

  mayRequestDomain(originAgentId: string, targetAgentId: string): boolean {
    return this.#entries.get(originAgentId)?.allowedNeedsDomains.includes(targetAgentId) ?? false;
  }
}

export function loadAgentServiceRegistry(file: string, baseDir = process.cwd()): StaticAgentRegistry {
  const parsed = agentServiceRegistryDocumentSchema.parse(parseYaml(readFileSync(resolvePath(baseDir, file), "utf8")));
  return new StaticAgentRegistry(parsed.agents);
}
