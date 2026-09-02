import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  agentDocumentSchema,
  assertNoSecretMaterial,
  mcpServerDocumentSchema,
  modelProfilesSchema,
  toApprovedCatalog,
  toolPolicySchema,
  type AgentDocument,
  type ApprovedCatalog,
  type ManagerAgentConfig,
  type McpServerDocument,
  type ModelProfiles,
  type SpecialistAgentConfig,
  type ToolPolicy,
} from "./schemas.ts";
import { ConfigValidationError, configFiles } from "./app-config.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { buildAgentCatalog, loadDeploymentEnvironment, type StaticAgentCatalog } from "./agent-catalog.ts";
import { validateSemantics } from "./validation.ts";

export interface LoadOptions {
  agentsDir: string;
  promptsDir: string;
  /** directory of one McpServer document per logical MCP server */
  mcpServersDir: string;
  modelProfilesFile: string;
  toolPolicyFile: string;
  /** repo root; paths above are resolved against it */
  baseDir?: string;
}

export interface LoadAgentInstanceOptions {
  configFile: string;
  mcpServersDir?: string;
  baseDir?: string;
}

/** Load exactly one logical Agent for one Generic Runtime process. */
export function loadAgentInstance(opts: LoadAgentInstanceOptions): ManagerAgentConfig | SpecialistAgentConfig {
  const base = opts.baseDir ?? process.cwd();
  const configPath = join(base, opts.configFile);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new ConfigValidationError(`agent config load failed for ${opts.configFile}: ${String(error)}`);
  }
  const result = agentDocumentSchema.safeParse(parsed);
  if (!result.success) throw new ConfigValidationError(`schema validation failed for ${opts.configFile}: ${result.error.message}`);
  const doc = result.data;
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(join(base, doc.spec.prompt.systemFile), "utf8");
  } catch {
    throw new ConfigValidationError(`prompt file ${doc.spec.prompt.systemFile} referenced by ${opts.configFile} does not exist`);
  }
  if (systemPrompt.trim().length === 0) throw new ConfigValidationError(`prompt file ${doc.spec.prompt.systemFile} is empty`);
  if (doc.spec.type === "manager") return { name: doc.metadata.name, owner: doc.metadata.owner, ...(doc.metadata.displayName ? { displayName: doc.metadata.displayName } : {}), ...(doc.metadata.description ? { description: doc.metadata.description } : {}), ...(doc.metadata.avatar ? { avatar: doc.metadata.avatar } : {}), spec: doc.spec, systemPrompt };

  if (opts.mcpServersDir === undefined) throw new ConfigValidationError("specialist runtime requires an approved tool catalog");
  const catalog = loadApprovedCatalog(join(base, opts.mcpServersDir));
  validateSingleSpecialist(doc, catalog, opts.configFile);
  return { name: doc.metadata.name, owner: doc.metadata.owner, ...(doc.metadata.displayName ? { displayName: doc.metadata.displayName } : {}), ...(doc.metadata.description ? { description: doc.metadata.description } : {}), ...(doc.metadata.avatar ? { avatar: doc.metadata.avatar } : {}), spec: doc.spec, systemPrompt };
}

/**
 * Startup config load per TDD §22:
 * YAML parse → JSON-Schema/zod validation → semantic validation → prompt load
 * → approved-catalog cross-check → immutable registry. Any failure throws.
 */
export function loadAgentRegistry(opts: LoadOptions): AgentRegistry {
  const base = opts.baseDir ?? process.cwd();
  const agentsDir = join(base, opts.agentsDir);
  const promptsDir = join(base, opts.promptsDir);

  const documents = loadAgentDocuments(agentsDir);

  const catalog = loadApprovedCatalog(join(base, opts.mcpServersDir));
  const profiles = loadModelProfiles(join(base, opts.modelProfilesFile));
  const toolPolicy = loadToolPolicy(join(base, opts.toolPolicyFile));
  validateSemantics(documents, catalog, profiles, toolPolicy);

  const prompts = new Map<string, string>();
  for (const { file, doc } of documents) {
    const promptPath = join(base, doc.spec.prompt.systemFile);
    let prompt: string;
    try {
      prompt = readFileSync(promptPath, "utf8");
    } catch {
      throw new ConfigValidationError(
        `prompt file ${doc.spec.prompt.systemFile} referenced by ${file} does not exist`,
      );
    }
    if (prompt.trim().length === 0) {
      throw new ConfigValidationError(`prompt file ${doc.spec.prompt.systemFile} is empty`);
    }
    void promptsDir; // prompts referenced by explicit path from repo root
    prompts.set(doc.metadata.name, prompt);
  }

  return AgentRegistry.build(
    documents.map(({ doc }) => doc),
    prompts,
    catalog,
  );
}

/**
 * Read every logical MCP server definition and flatten them into the approved
 * tool catalog the runtime enforces. One file per server means a tool cannot be
 * approved for the wrong server by a stray copy-paste of `serverId`.
 */
/** Parse every Agent document under a directory. Anything that is not an Agent fails closed. */
function loadAgentDocuments(agentsDir: string): Array<{ file: string; doc: AgentDocument }> {
  let files: string[];
  try {
    files = configFiles(agentsDir);
  } catch {
    throw new ConfigValidationError(`no agent YAML found in ${agentsDir}`);
  }
  if (files.length === 0) throw new ConfigValidationError(`no agent YAML found in ${agentsDir}`);
  const documents: Array<{ file: string; doc: AgentDocument }> = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(join(agentsDir, file), "utf8"));
    } catch (err) {
      throw new ConfigValidationError(`YAML parse failed for ${file}: ${String(err)}`);
    }
    const result = agentDocumentSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigValidationError(`schema validation failed for ${file}: ${result.error.message}`);
    }
    documents.push({ file, doc: result.data });
  }
  return documents;
}

export function loadApprovedCatalog(directory: string): ApprovedCatalog {
  let files: string[];
  try {
    files = configFiles(directory);
  } catch {
    throw new ConfigValidationError(`MCP server definitions not found at ${directory}`);
  }
  if (files.length === 0) throw new ConfigValidationError(`no MCP server definitions in ${directory}`);
  const servers: McpServerDocument[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const result = mcpServerDocumentSchema.safeParse(parseYaml(readFileSync(join(directory, file), "utf8")));
    if (!result.success) throw new ConfigValidationError(`MCP server definition invalid (${file}): ${result.error.message}`);
    if (seen.has(result.data.metadata.serverId)) throw new ConfigValidationError(`duplicate MCP server "${result.data.metadata.serverId}" (${file})`);
    seen.add(result.data.metadata.serverId);
    servers.push(result.data);
  }
  try {
    return toApprovedCatalog(servers);
  } catch (error) {
    throw new ConfigValidationError(`approved tool catalog invalid: ${String(error)}`);
  }
}

export function loadModelProfiles(path: string): ModelProfiles {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigValidationError(`model profiles not found at ${path}`);
  }
  const result = modelProfilesSchema.safeParse(parseYaml(raw));
  if (!result.success) throw new ConfigValidationError(`model profiles invalid: ${result.error.message}`);
  return result.data;
}

export function loadToolPolicy(path: string): ToolPolicy {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigValidationError(`tool policy not found at ${path}`);
  }
  const result = toolPolicySchema.safeParse(parseYaml(raw));
  if (!result.success) throw new ConfigValidationError(`tool policy invalid: ${result.error.message}`);
  return result.data;
}

/**
 * Build the Manager's effective catalog from the canonical Agents plus the
 * active environment's deployment state. This is the ONLY path to a catalog;
 * there is deliberately no file that can be edited to add an Agent to routing
 * without adding the Agent itself.
 */
export function loadEffectiveAgentCatalog(opts: LoadOptions & { deploymentEnvironmentDir: string }): StaticAgentCatalog {
  const base = opts.baseDir ?? process.cwd();
  const documents = loadAgentDocuments(join(base, opts.agentsDir));
  const environment = loadDeploymentEnvironment(opts.deploymentEnvironmentDir, base);
  for (const agentId of environment.overlays.keys()) {
    if (!documents.some(({ doc }) => doc.metadata.name === agentId)) {
      throw new ConfigValidationError(`deployment overlay for "${agentId}" has no canonical Agent under ${opts.agentsDir}`);
    }
  }
  return buildAgentCatalog(documents.map(({ doc }) => doc), environment.settings, environment.overlays);
}

function validateSingleSpecialist(doc: AgentDocument, catalog: ApprovedCatalog, file: string): void {
  if (doc.spec.type !== "specialist") throw new ConfigValidationError(`${file}: expected specialist config`);
  assertNoSecretMaterial(doc.spec);
  for (const entry of doc.spec.access) {
    if (!catalog.tools.some((tool) => tool.serverId === entry.mcp)) throw new ConfigValidationError(`${file}: MCP server "${entry.mcp}" is not in the approved catalog`);
    for (const toolName of entry.tools) {
      if (!catalog.tools.some((tool) => tool.toolName === toolName && tool.serverId === entry.mcp)) throw new ConfigValidationError(`${file}: tool "${toolName}" is not approved for MCP "${entry.mcp}"`);
    }
  }
}
