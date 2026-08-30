import { createHash } from "node:crypto";
import { assertNoSecretMaterial, type AgentDocument } from "@sre/agent-schema";
import { CONFIG_PATHS } from "./app-config.ts";
import { MODEL_PROFILE_ENV, renderedAgentValuesSchema, type AgentDeploymentOverlay, type ModelBindings, type RenderedAgentValues } from "./agent-catalog.ts";

/**
 * Canonical Agent + deployment overlay → the Helm values Argo actually deploys.
 *
 * This is the PURE half of `npm run render:deploy`. It lived inside that script,
 * which meant the only way to obtain a rendered Agent was to have every input
 * already on disk. The management plane needs the same answer for a draft that
 * does not exist yet: an Agent created in the console proposes its canonical
 * document and its overlay, and without the render, merging that proposal adds
 * an Agent to Git that Argo never sees — the ApplicationSet globs `rendered/`,
 * so an unrendered Agent is simply not there.
 *
 * The prompt arrives as TEXT rather than a path for the same reason. A draft's
 * prompt is in the operator's browser, not in the working tree.
 *
 * Nothing here touches the filesystem, so both callers agree by construction
 * rather than by two implementations staying in step.
 */

const DEFAULT_RESOURCES = {
  requests: { cpu: "500m", memory: "512Mi" },
  limits: { cpu: "1", memory: "1Gi" },
} as const;

export const GENERATED_HEADER = [
  "# GENERATED FILE — DO NOT EDIT.",
  "# Produced by `npm run render:deploy` from:",
  "#   config/agents/<agent>.yaml",
  "#   config/prompts/<agent>.md",
  "#   deploy/environments/<env>/agents/<agent>.yaml",
  "#   deploy/environments/<env>/model-bindings.yaml",
  "# CI re-renders and fails on any diff, so edits here are lost, not applied.",
].join("\n");

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

export function renderAgentValues(
  doc: AgentDocument,
  overlay: AgentDeploymentOverlay,
  bindings: ModelBindings,
  environment: string,
  prompt: string,
): RenderedAgentValues {
  if (prompt.trim().length === 0) throw new Error(`${environment}: the prompt for agent "${doc.metadata.name}" is empty`);

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
export function renderedValuesToYaml(values: RenderedAgentValues): string {
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
