import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { agentDocumentSchema, assertNoSecretMaterial, type AgentDocument } from "@sre/agent-schema";
import {
  CONFIG_PATHS,
  MODEL_PROFILE_ENV,
  isAgentEnabled,
  loadDeploymentEnvironment,
  loadModelBindings,
  renderedAgentValuesSchema,
  type AgentDeploymentOverlay,
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

const DEFAULT_RESOURCES = {
  requests: { cpu: "500m", memory: "512Mi" },
  limits: { cpu: "1", memory: "1Gi" },
} as const;

const GENERATED_HEADER = [
  "# GENERATED FILE — DO NOT EDIT.",
  "# Produced by `npm run render:deploy` from:",
  "#   config/agents/<agent>.yaml",
  "#   config/prompts/<agent>.md",
  "#   deploy/environments/<env>/agents/<agent>.yaml",
  "#   deploy/environments/<env>/model-bindings.yaml",
  "# CI re-renders and fails on any diff, so edits here are lost, not applied.",
].join("\n");

function canonicalAgents(): Map<string, AgentDocument> {
  const documents = new Map<string, AgentDocument>();
  for (const file of readdirSync(CONFIG_PATHS.agentsDir).filter((name) => name.endsWith(".yaml")).sort()) {
    const doc = agentDocumentSchema.parse(parseYaml(readFileSync(join(CONFIG_PATHS.agentsDir, file), "utf8")));
    documents.set(doc.metadata.name, doc);
  }
  return documents;
}

/** Resolve every profile this Agent will ask for, failing closed when one is unbound. */
function resolveModelEnv(doc: AgentDocument, bindings: ModelBindings, environment: string): Record<string, string> {
  const profiles = doc.spec.type === "manager" ? [doc.spec.model.profile, "tier-l-synthesis"] : [doc.spec.model.profile];
  const modelEnv: Record<string, string> = {};
  for (const profile of new Set(profiles)) {
    const binding = bindings.profiles[profile];
    if (binding === undefined) {
      throw new Error(`${environment}: agent "${doc.metadata.name}" references model profile "${profile}", which has no binding in deploy/environments/${environment}/model-bindings.yaml`);
    }
    const variable = MODEL_PROFILE_ENV[profile];
    if (variable === undefined) throw new Error(`${environment}: model profile "${profile}" has no environment-variable mapping`);
    modelEnv[variable] = binding.model;
  }
  return modelEnv;
}

function renderAgent(doc: AgentDocument, overlay: AgentDeploymentOverlay, bindings: ModelBindings, environment: string): RenderedAgentValues {
  const promptPath = doc.spec.prompt.systemFile;
  let prompt: string;
  try {
    prompt = readFileSync(promptPath, "utf8");
  } catch {
    throw new Error(`${environment}: agent "${doc.metadata.name}" references prompt ${promptPath}, which does not exist`);
  }
  if (prompt.trim().length === 0) throw new Error(`${environment}: prompt ${promptPath} is empty`);

  const values: RenderedAgentValues = {
    agent: {
      name: doc.metadata.name,
      mode: doc.spec.type === "manager" ? "manager" : "specialist",
      configFile: `${CONFIG_PATHS.agentsDir}/${doc.metadata.name}.yaml`,
    },
    deploymentEnvironment: environment,
    environment: environment === "production" ? "production" : environment === "poc" ? "real-poc" : "local",
    replicaCount: overlay.replicas ?? 2,
    resources: {
      requests: overlay.resources?.requests ?? DEFAULT_RESOURCES.requests,
      limits: overlay.resources?.limits ?? DEFAULT_RESOURCES.limits,
    },
    ...(overlay.serviceAccount ? { serviceAccount: { name: overlay.serviceAccount } } : {}),
    modelEnv: resolveModelEnv(doc, bindings, environment),
    // the prompt ships inside the runtime image (Dockerfile COPY config); the
    // digest is what makes a prompt change a visible, syncable diff here
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };

  const validated = renderedAgentValuesSchema.parse(values);
  // rendered output must never carry credential material — only references to it
  assertNoSecretMaterial(validated, `rendered.${doc.metadata.name}`);
  return validated;
}

/** Deterministic YAML: fixed key order, no timestamps, no map iteration surprises. */
function toYaml(values: RenderedAgentValues): string {
  const lines = [
    GENERATED_HEADER,
    "agent:",
    `  name: ${values.agent.name}`,
    `  mode: ${values.agent.mode}`,
    `  configFile: ${values.agent.configFile}`,
    `deploymentEnvironment: ${values.deploymentEnvironment}`,
    `environment: ${values.environment}`,
    `replicaCount: ${values.replicaCount}`,
    "resources:",
    `  requests: { cpu: ${JSON.stringify(values.resources.requests.cpu)}, memory: ${JSON.stringify(values.resources.requests.memory)} }`,
    `  limits: { cpu: ${JSON.stringify(values.resources.limits.cpu)}, memory: ${JSON.stringify(values.resources.limits.memory)} }`,
  ];
  if (values.serviceAccount) lines.push("serviceAccount:", `  name: ${values.serviceAccount.name}`);
  lines.push("modelEnv:");
  for (const key of Object.keys(values.modelEnv).sort()) lines.push(`  ${key}: ${JSON.stringify(values.modelEnv[key])}`);
  lines.push(`promptSha256: ${values.promptSha256}`);
  return `${lines.join("\n")}\n`;
}

export function render(environments: string[] = readdirSync("deploy/environments").sort()): string[] {
  const documents = canonicalAgents();
  const written: string[] = [];

  for (const environment of environments) {
    const directory = `deploy/environments/${environment}`;
    const state = loadDeploymentEnvironment(directory);
    const bindings = loadModelBindings(directory);
    if (bindings.environment !== state.settings.environment) {
      throw new Error(`${environment}: model-bindings declares environment "${bindings.environment}" but environment.yaml declares "${state.settings.environment}"`);
    }

    const renderedDir = join(directory, "rendered", "agents");
    rmSync(join(directory, "rendered"), { recursive: true, force: true });
    mkdirSync(renderedDir, { recursive: true });

    const manager = documents.get("manager");
    if (manager === undefined) throw new Error("no canonical manager Agent");
    if (state.manager?.enabled) {
      const file = join(directory, "rendered", "agents", "manager.yaml");
      writeFileSync(file, toYaml(renderAgent(manager, state.manager, bindings, environment)), "utf8");
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
      writeFileSync(file, toYaml(renderAgent(doc, overlay, bindings, environment)), "utf8");
      written.push(file);
    }
  }
  return written;
}

const written = render();
for (const file of written) console.log(`rendered ${file}`);
console.log(`rendered ${written.length} agent deployment value file(s)`);
