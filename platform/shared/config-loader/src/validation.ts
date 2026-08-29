import { ConfigValidationError } from "./app-config.ts";
import { assertNoSecretMaterial, isAgentEnabled, type AgentDocument, type ApprovedCatalog, type ModelProfiles, type ToolPolicy } from "./schemas.ts";

/**
 * Semantic validation per TDD §5.3 / §22 — fail closed:
 * - exactly one manager;
 * - manager.agents.allowed reference existing specialists;
 * - specialist MCP servers exist in the approved catalog;
 * - every allowedTool exists in the approved catalog under one of the
 *   specialist's servers;
 * - discovery.allowedNeedsDomains reference existing specialist agents;
 * - duplicate agent names rejected;
 * - every referenced model profile is a declared logical profile;
 * - no approved tool violates the platform tool policy.
 */
export function validateSemantics(
  documents: Array<{ file: string; doc: AgentDocument }>,
  catalog: ApprovedCatalog,
  profiles: ModelProfiles,
  toolPolicy: ToolPolicy,
): void {
  // the tool policy is enforced here rather than only in a test, so a
  // mutating-sounding tool cannot be approved by editing config alone
  for (const tool of catalog.tools) {
    if (toolPolicy.requireReadOnlyVerified && !tool.readOnlyVerified) {
      throw new ConfigValidationError(`approved tool "${tool.serverId}/${tool.toolName}" is not read-only-verified`);
    }
    const forbidden = toolPolicy.forbiddenToolNamePrefixes.find((prefix) => tool.toolName.startsWith(prefix));
    if (forbidden !== undefined) {
      throw new ConfigValidationError(`approved tool "${tool.serverId}/${tool.toolName}" uses forbidden mutating prefix "${forbidden}"`);
    }
  }

  const profileIds = new Set(profiles.profiles.map((profile) => profile.id));
  const names = new Set<string>();
  for (const { file, doc } of documents) {
    if (names.has(doc.metadata.name)) {
      throw new ConfigValidationError(`duplicate agent name "${doc.metadata.name}" (${file})`);
    }
    names.add(doc.metadata.name);
    // secrets never belong in Git-tracked Agent configuration — TDD §36
    try {
      assertNoSecretMaterial(doc.spec);
    } catch (error) {
      throw new ConfigValidationError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const { file, doc } of documents) {
    if (!profileIds.has(doc.spec.model.profile)) {
      throw new ConfigValidationError(`${file}: model profile "${doc.spec.model.profile}" is not declared in the model profiles`);
    }
  }

  const managers = documents.filter(({ doc }) => doc.spec.type === "manager");
  if (managers.length !== 1) {
    throw new ConfigValidationError(`expected exactly one manager agent, found ${managers.length}`);
  }

  const specialistNames = new Set(
    documents.filter(({ doc }) => doc.spec.type === "specialist").map(({ doc }) => doc.metadata.name),
  );
  // an Agent that is not active must not be reachable through routing either — TDD §34
  const routableNames = new Set(
    documents
      .filter(({ doc }) => doc.spec.type === "specialist" && isAgentEnabled(doc.spec))
      .map(({ doc }) => doc.metadata.name),
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
        if (!routableNames.has(agent)) {
          throw new ConfigValidationError(
            `manager ${file} routes to "${agent}" but that agent's lifecycle is not active`,
          );
        }
      }
      continue;
    }
    for (const entry of spec.access) {
      if (!catalogServers.has(entry.mcp)) {
        throw new ConfigValidationError(
          `${file}: MCP server "${entry.mcp}" is not in the approved catalog`,
        );
      }
      // per-MCP scoping: the tool must be approved on THIS server, not merely somewhere
      for (const tool of entry.tools) {
        if (!catalogByTool.get(tool)?.has(entry.mcp)) {
          throw new ConfigValidationError(
            `${file}: tool "${tool}" is not in the approved catalog for MCP "${entry.mcp}"`,
          );
        }
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
