import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { agentDocumentSchema, type AgentDocument } from "@sre/agent-schema";
import {
  CONFIG_PATHS,
  isAgentEnabled,
  DEPLOY_ROOT,
  deployEnvironmentDir,
  loadDeploymentEnvironment,
  loadModelBindings,
  configFiles,
  canonicalAgents,
  managerDesiredState,
  renderOneAgent,
  renderedValuesToYaml,
  type AgentDeploymentOverlay,
  type ManagerDesiredState,
  type ModelBindings,
  type RenderedAgentValues,
} from "@sre/config";

/**
 * THE ONLY path from logical configuration to Kubernetes.
 *
 *   config/agents/<agent>.yaml
 *   config/prompts/<agent>.md
 *   deploy/environments/<env>/agents/<agent>.yaml
 *   deploy/environments/<env>/model-bindings.yaml
 *            ↓  this renderer  ↓
 *   deploy/environments/<env>/rendered/agents/<agent>.yaml   (Helm values)
 *            ↓
 *   Argo CD ApplicationSet  →  deploy/runtime/helm  →  one Deployment per Agent
 *
 * The output is GENERATED, committed and freshness-checked. It is never edited
 * by hand: a hand edit either fails schema validation or is overwritten on the
 * next render, and CI fails on the diff either way.
 *
 * Argo consumes what is already rendered. There is deliberately no Argo config
 * management plugin: rendering in the cluster would mean the committed state and
 * the deployed state could differ without anyone seeing a diff.
 */


/**
 * Reading the prompt is this script's job; producing the values is not.
 * `renderAgentValues` lives in @sre/config so the management plane renders a
 * DRAFT with the same code — an Agent proposed in the console must arrive in
 * Git already rendered, or Argo, which globs `rendered/`, never sees it.
 */

/**
 * The whole of this environment's Agent desired state, as files to mount.
 *
 * The Manager reads the CANONICAL registry — every Agent that exists, deployed
 * here or not — because the console must be able to show and edit an Agent this
 * cluster does not run. So the bundle is every document and every prompt, not
 * only the enabled ones, intersected at read time with the overlays that are
 * also carried here.
 */

const toYaml = renderedValuesToYaml;

export function render(environments: string[] = readdirSync(`${DEPLOY_ROOT}/environments`).sort()): string[] {
  const documents = canonicalAgents();
  const written: string[] = [];

  for (const environment of environments) {
    const directory = deployEnvironmentDir(environment);
    const state = loadDeploymentEnvironment(directory);
    const bindings = loadModelBindings(directory);
    if (bindings.environment !== state.settings.environment) {
      throw new Error(`${environment}: model-bindings declares environment "${bindings.environment}" but environment.yaml declares "${state.settings.environment}"`);
    }

    // clear only the subtree this renderer owns: deploy/environments/<env>/rendered
    // is shared with the ToolHive policy renderer, and wiping the parent would
    // silently delete the other's output depending on which ran last
    const renderedDir = join(directory, "rendered", "agents");
    rmSync(renderedDir, { recursive: true, force: true });
    mkdirSync(renderedDir, { recursive: true });

    const manager = documents.get("manager");
    if (manager === undefined) throw new Error("no canonical manager Agent");
    if (state.manager?.enabled) {
      const file = join(renderedDir, "manager.yaml");
      // the Manager carries the environment's whole desired state, because its
      // catalog is derived from all of it
      writeFileSync(file, toYaml(renderOneAgent(manager, state.manager, bindings, environment, managerDesiredState(documents, directory))), "utf8");
      written.push(file);
    }

    for (const [agentId, overlay] of [...state.overlays.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const doc = documents.get(agentId);
      if (doc === undefined) throw new Error(`${environment}: deployment overlay for "${agentId}" has no canonical Agent`);
      // a disabled Agent renders nothing: the ApplicationSet discovers files, so
      // absence is how "do not deploy this here" reaches the cluster
      if (!overlay.enabled) continue;
      if (!isAgentEnabled(doc.spec)) {
        throw new Error(`${environment}: "${agentId}" is enabled for deployment but its lifecycle is "${doc.spec.lifecycle}"`);
      }
      const file = join(renderedDir, `${agentId}.yaml`);
      writeFileSync(file, toYaml(renderOneAgent(doc, overlay, bindings, environment)), "utf8");
      written.push(file);
    }
  }
  return written;
}

const written = render();
for (const file of written) console.log(`rendered ${file}`);
console.log(`rendered ${written.length} agent deployment value file(s)`);
