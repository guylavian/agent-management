import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { agentDocumentSchema, type AgentDocument } from "@sre/agent-schema";
import { CONFIG_PATHS, configBaseDir, configFiles, DEPLOY_ROOT, deployEnvironmentDir } from "./app-config.ts";
import { loadDeploymentEnvironment, loadModelBindings, type RenderedAgentValues } from "./agent-catalog.ts";
import { renderAgentValues, type ManagerDesiredState } from "./render-values.ts";

/**
 * READING THE ESTATE, ONCE.
 *
 * Two callers need the Manager's rendered values: the renderer script, and the
 * management plane when it proposes a change. They must agree exactly — the
 * chart mounts these as the Manager's whole desired state, and the repository
 * gate `check:generated` fails the moment they diverge. A second copy of "which
 * Agents go into the bundle" is precisely the drift that gate exists to catch,
 * so the logic lives here and neither caller owns a version of it.
 */

/** Every canonical Agent, with pending additions folded in and removals taken out. */
export function canonicalAgents(pending?: { added?: Map<string, { document: AgentDocument; yaml: string; prompt: string }>; removed?: string[] }): Map<string, AgentDocument> {
  const documents = new Map<string, AgentDocument>();
  for (const file of configFiles(resolve(configBaseDir(), CONFIG_PATHS.agentsDir))) {
    const doc = agentDocumentSchema.parse(parseYaml(readFileSync(resolve(configBaseDir(), CONFIG_PATHS.agentsDir, file), "utf8")));
    documents.set(doc.metadata.name, doc);
  }
  for (const name of pending?.removed ?? []) documents.delete(name);
  for (const [name, entry] of pending?.added ?? new Map()) documents.set(name, entry.document);
  return documents;
}

/**
 * The whole of an environment's Agent desired state, as files to mount.
 *
 * The Manager reads the CANONICAL registry — every Agent that exists, deployed
 * here or not — because the console must be able to show and edit an Agent this
 * cluster does not run. So the bundle is every document and every prompt, not
 * only the enabled ones, intersected at read time with the overlays carried
 * alongside.
 *
 * `pending` supplies the bytes for an Agent that is not on disk yet: a change
 * being proposed has to render as though it had already merged, or the pull
 * request describes a Manager that cannot see the Agent the same pull request
 * adds.
 */
export function managerDesiredState(
  documents: Map<string, AgentDocument>,
  directory: string,
  pending?: { added?: Map<string, { document: AgentDocument; yaml: string; prompt: string }>; overlays?: Record<string, string> },
): ManagerDesiredState {
  const agents: Record<string, string> = {};
  const prompts: Record<string, string> = {};
  for (const [name, doc] of [...documents.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const added = pending?.added?.get(name);
    agents[`${name}.yaml`] = added?.yaml ?? readFileSync(resolve(configBaseDir(), CONFIG_PATHS.agentsDir, `${name}.yaml`), "utf8");
    // keyed by the prompt's own FILE NAME, because the mount replaces the
    // prompts directory and `spec.prompt.systemFile` resolves into it
    const promptFile = doc.spec.prompt.systemFile.split("/").pop() as string;
    prompts[promptFile] = added?.prompt ?? readFileSync(resolve(configBaseDir(), doc.spec.prompt.systemFile), "utf8");
  }

  const overlays: Record<string, string> = {};
  const agentsDir = join(directory, "agents");
  for (const file of configFiles(agentsDir)) overlays[file] = readFileSync(join(agentsDir, file), "utf8");
  for (const [file, contents] of Object.entries(pending?.overlays ?? {})) overlays[file] = contents;

  const environmentFiles: Record<string, string> = {
    "environment.yaml": readFileSync(join(directory, "environment.yaml"), "utf8"),
    "manager.yaml": readFileSync(join(directory, "manager.yaml"), "utf8"),
    // the runtime reads this when it renders a change PREVIEW for the console;
    // the mount shadows the directory, so leaving it out would break previews
    // in exactly the environment the Manager is serving
    "model-bindings.yaml": readFileSync(join(directory, "model-bindings.yaml"), "utf8"),
  };
  return { agents, prompts, overlays, environmentFiles };
}

/** Read an Agent's prompt and document bytes, preferring a pending version. */
function agentSources(doc: AgentDocument, pending?: Map<string, { document: AgentDocument; yaml: string; prompt: string }>): { prompt: string; yaml: string } {
  const added = pending?.get(doc.metadata.name);
  if (added !== undefined) return { prompt: added.prompt, yaml: added.yaml };
  const promptPath = doc.spec.prompt.systemFile;
  let prompt: string;
  try {
    prompt = readFileSync(resolve(configBaseDir(), promptPath), "utf8");
  } catch {
    throw new Error(`agent "${doc.metadata.name}" references prompt ${promptPath}, which does not exist`);
  }
  return { prompt, yaml: readFileSync(resolve(configBaseDir(), CONFIG_PATHS.agentsDir, `${doc.metadata.name}.yaml`), "utf8") };
}

export function renderOneAgent(
  doc: AgentDocument,
  overlay: Parameters<typeof renderAgentValues>[1],
  bindings: Parameters<typeof renderAgentValues>[2],
  environment: string,
  managerState?: ManagerDesiredState,
  pending?: Map<string, { document: AgentDocument; yaml: string; prompt: string }>,
): RenderedAgentValues {
  const { prompt, yaml } = agentSources(doc, pending);
  return renderAgentValues(doc, overlay, bindings, environment, prompt, yaml, managerState);
}

/**
 * The Manager's rendered values for one environment, or undefined where this
 * environment does not deploy a Manager.
 */
export function renderManagerValues(
  environment: string,
  pending?: { added?: Map<string, { document: AgentDocument; yaml: string; prompt: string }>; removed?: string[]; overlays?: Record<string, string> },
): RenderedAgentValues | undefined {
  const directory = resolve(configBaseDir(), deployEnvironmentDir(environment));
  const state = loadDeploymentEnvironment(directory, configBaseDir());
  if (!state.manager?.enabled) return undefined;
  const documents = canonicalAgents(pending);
  const manager = documents.get("manager");
  if (manager === undefined) throw new Error("no canonical manager Agent");
  return renderOneAgent(
    manager,
    state.manager,
    loadModelBindings(directory, configBaseDir()),
    environment,
    managerDesiredState(documents, directory, pending),
    pending?.added,
  );
}

/**
 * Every environment this repository defines.
 *
 * The renderer script defaults to `readdirSync(deploy/environments)`; sharing
 * that here keeps the management plane from rendering a different set and
 * leaving one environment's Manager bundle stale.
 */
export function deploymentEnvironments(): string[] {
  return readdirSync(resolve(configBaseDir(), DEPLOY_ROOT, "environments"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
