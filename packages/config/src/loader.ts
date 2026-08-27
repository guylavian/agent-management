import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  agentDocumentSchema,
  approvedCatalogSchema,
  type AgentDocument,
  type ApprovedCatalog,
  type ManagerAgentConfig,
  type SpecialistAgentConfig,
} from "./schemas.ts";
import { ConfigValidationError } from "./app-config.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { validateSemantics } from "./validation.ts";

export interface LoadOptions {
  agentsDir: string;
  promptsDir: string;
  approvedCatalogFile: string;
  /** repo root; paths above are resolved against it */
  baseDir?: string;
}

export interface LoadAgentInstanceOptions {
  configFile: string;
  approvedCatalogFile?: string;
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
  if (doc.spec.type === "manager") return { name: doc.metadata.name, owner: doc.metadata.owner, spec: doc.spec, systemPrompt };

  if (opts.approvedCatalogFile === undefined) throw new ConfigValidationError("specialist runtime requires an approved tool catalog");
  const catalog = loadApprovedCatalog(join(base, opts.approvedCatalogFile));
  validateSingleSpecialist(doc, catalog, opts.configFile);
  return { name: doc.metadata.name, owner: doc.metadata.owner, spec: doc.spec, systemPrompt };
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

  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  if (files.length === 0) {
    throw new ConfigValidationError(`no agent YAML found in ${agentsDir}`);
  }

  const documents: Array<{ file: string; doc: AgentDocument }> = [];
  for (const file of files) {
    const raw = readFileSync(join(agentsDir, file), "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new ConfigValidationError(`YAML parse failed for ${file}: ${String(err)}`);
    }
    // the co-located service registry is a distinct, separately validated kind; anything else non-Agent still fails closed
    if (typeof parsed === "object" && parsed !== null && (parsed as { kind?: unknown }).kind === "AgentServiceRegistry") continue;
    const result = agentDocumentSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigValidationError(`schema validation failed for ${file}: ${result.error.message}`);
    }
    documents.push({ file, doc: result.data });
  }

  const catalog = loadApprovedCatalog(join(base, opts.approvedCatalogFile));
  validateSemantics(documents, catalog);

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

export function loadApprovedCatalog(path: string): ApprovedCatalog {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigValidationError(`approved tool catalog not found at ${path}`);
  }
  const result = approvedCatalogSchema.safeParse(parseYaml(raw));
  if (!result.success) {
    throw new ConfigValidationError(`approved tool catalog invalid: ${result.error.message}`);
  }
  return result.data;
}

function validateSingleSpecialist(doc: AgentDocument, catalog: ApprovedCatalog, file: string): void {
  if (doc.spec.type !== "specialist") throw new ConfigValidationError(`${file}: expected specialist config`);
  const servers = new Set(doc.spec.mcp.servers);
  for (const server of servers) {
    if (!catalog.tools.some((tool) => tool.serverId === server)) throw new ConfigValidationError(`${file}: MCP server "${server}" is not in the approved catalog`);
  }
  for (const toolName of doc.spec.mcp.allowedTools) {
    if (!catalog.tools.some((tool) => tool.toolName === toolName && servers.has(tool.serverId))) throw new ConfigValidationError(`${file}: tool "${toolName}" is not approved for this specialist`);
  }
}
