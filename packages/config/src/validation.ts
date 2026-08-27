import { ConfigValidationError } from "./app-config.ts";
import type { AgentDocument, ApprovedCatalog } from "./schemas.ts";

/**
 * Semantic validation per TDD §5.3 / §22 — fail closed:
 * - exactly one manager;
 * - manager.agents.allowed reference existing specialists;
 * - specialist MCP servers exist in the approved catalog;
 * - every allowedTool exists in the approved catalog under one of the
 *   specialist's servers;
 * - discovery.allowedNeedsDomains reference existing specialist agents;
 * - duplicate agent names rejected.
 */
export function validateSemantics(
  documents: Array<{ file: string; doc: AgentDocument }>,
  catalog: ApprovedCatalog,
): void {
  const names = new Set<string>();
  for (const { file, doc } of documents) {
    if (names.has(doc.metadata.name)) {
      throw new ConfigValidationError(`duplicate agent name "${doc.metadata.name}" (${file})`);
    }
    names.add(doc.metadata.name);
  }

  const managers = documents.filter(({ doc }) => doc.spec.type === "manager");
  if (managers.length !== 1) {
    throw new ConfigValidationError(`expected exactly one manager agent, found ${managers.length}`);
  }

  const specialistNames = new Set(
    documents.filter(({ doc }) => doc.spec.type === "specialist").map(({ doc }) => doc.metadata.name),
  );

  const catalogServers = new Set(catalog.tools.map((t) => t.serverId));
  const catalogByTool = new Map<string, Set<string>>();
  for (const tool of catalog.tools) {
    const servers = catalogByTool.get(tool.toolName) ?? new Set<string>();
    servers.add(tool.serverId);
    catalogByTool.set(tool.toolName, servers);
  }

  for (const { file, doc } of documents) {
    const spec = doc.spec;
    if (spec.type === "manager") {
      for (const agent of spec.agents.allowed) {
        if (!specialistNames.has(agent)) {
          throw new ConfigValidationError(
            `manager ${file} allows unknown specialist "${agent}"`,
          );
        }
      }
      continue;
    }
    for (const server of spec.mcp.servers) {
      if (!catalogServers.has(server)) {
        throw new ConfigValidationError(
          `${file}: MCP server "${server}" is not in the approved catalog`,
        );
      }
    }
    const specServers = new Set(spec.mcp.servers);
    for (const tool of spec.mcp.allowedTools) {
      const servers = catalogByTool.get(tool);
      const hosted = servers === undefined ? [] : [...servers].filter((s) => specServers.has(s));
      if (hosted.length === 0) {
        throw new ConfigValidationError(
          `${file}: tool "${tool}" is not in the approved catalog for servers [${spec.mcp.servers.join(", ")}]`,
        );
      }
    }
    for (const domain of spec.discovery?.allowedNeedsDomains ?? []) {
      if (!specialistNames.has(domain)) {
        throw new ConfigValidationError(
          `${file}: discovery domain "${domain}" is not a registered specialist`,
        );
      }
      if (domain === doc.metadata.name) {
        throw new ConfigValidationError(`${file}: agent cannot discover itself`);
      }
    }
  }
}
