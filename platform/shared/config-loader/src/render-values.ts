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

/**
 * Everything a MANAGER must read that its image cannot supply.
 *
 * The Manager derives its catalog from the whole canonical registry
 * intersected with this environment's overlays, so all of it has to reach the
 * pod. A specialist loads exactly one Agent document and needs none of it.
 */
export interface ManagerDesiredState {
  /** `<name>.yaml` → canonical Agent document */
  agents: Record<string, string>;
  /** `<name>.md` → prompt body */
  prompts: Record<string, string>;
  /** `<name>.yaml` → this environment's deployment overlay */
  overlays: Record<string, string>;
  /** `environment.yaml` and `manager.yaml` for this environment */
  environmentFiles: Record<string, string>;
}

/**
 * A ConfigMap holds 1 MiB. Failing the RENDER is the right place to notice:
 * the alternative is a manifest Argo cannot apply, discovered in the cluster
 * long after the pull request was approved.
 */
const MAX_MOUNTED_BYTES = 900_000;

export function renderAgentValues(
  doc: AgentDocument,
  overlay: AgentDeploymentOverlay,
  bindings: ModelBindings,
  environment: string,
  prompt: string,
  /** the Agent document exactly as it is written in Git, for the specialist mount */
  agentYaml: string,
  managerState?: ManagerDesiredState,
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
    /*
     * MUTABLE DESIRED STATE, CARRIED BY ARGO RATHER THAN BY THE IMAGE.
     *
     * The image bakes `platform/config` and `deploy/environments` so a working
     * tree and a container resolve the same relative paths. That is right for
     * code and defaults and wrong for Agent desired state: a merged pull
     * request changed Git, Argo reconciled, and the running Manager went on
     * reading the registry from the image it was built with — so discovering a
     * new Agent needed an image rebuild.
     *
     * These files are mounted OVER the baked copies as whole directories, so a
     * merge reaches a running pod through the deployment path.
     */
    desiredState: doc.spec.type === "manager" && managerState !== undefined
      ? { agents: managerState.agents, prompts: managerState.prompts, overlays: managerState.overlays, environmentFiles: managerState.environmentFiles, revision: "" }
      /*
       * A specialist gets its OWN document and prompt, and nothing about
       * anyone else.
       *
       * Its own document is not optional. `AGENT_CONFIG` points at
       * `config/agents/<name>.yaml`, and without this mount that path resolves
       * to the image's BAKED copy — so a specialist created after the image was
       * built has no document to load and cannot start at all. Shipping only
       * the prompt fixed prompt edits while leaving the headline case, "a new
       * Agent needs no rebuild", quietly broken.
       */
      : {
        agents: { [`${doc.metadata.name}.yaml`]: agentYaml },
        prompts: { [`${doc.metadata.name}.md`]: prompt },
        revision: "",
      },
    // the digest still travels: it is what makes a prompt-only edit a visible
    // one-line diff in this file even though the body now sits beside it
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };

  /*
   * Stamp every mount with one digest of the whole bundle. Computed AFTER the
   * files are assembled and BEFORE validation, so it covers exactly what will
   * be mounted and nothing else.
   */
  if (values.desiredState) values.desiredState.revision = bundleRevision(values.desiredState);

  const mountedBytes = JSON.stringify(values.desiredState ?? {}).length;
  if (mountedBytes > MAX_MOUNTED_BYTES) {
    throw new Error(`${environment}: mounted desired state for "${doc.metadata.name}" is ${mountedBytes} bytes, over the ${MAX_MOUNTED_BYTES}-byte ConfigMap budget`);
  }

  const validated = renderedAgentValuesSchema.parse(values);
  // rendered output must never carry credential material — only references to it
  assertNoSecretMaterial(validated, `rendered.${doc.metadata.name}`);
  return validated;
}

/**
 * A digest over every mounted file, independent of map iteration order.
 *
 * This is what lets a running pod notice that its four ConfigMaps are not all
 * from the same commit yet — a state no single-directory check can detect,
 * because each volume is individually complete and consistent.
 */
export function bundleRevision(state: NonNullable<RenderedAgentValues["desiredState"]>): string {
  const hash = createHash("sha256");
  for (const group of ["agents", "prompts", "overlays", "environmentFiles"] as const) {
    for (const name of Object.keys(state[group] ?? {}).sort()) {
      hash.update(`${group}/${name}\u0000${(state[group] as Record<string, string>)[name]}\u0000`);
    }
  }
  return hash.digest("hex");
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
  if (values.desiredState) {
    lines.push("desiredState:");
    for (const group of ["agents", "prompts", "overlays", "environmentFiles"] as const) {
      const files = values.desiredState[group];
      if (files === undefined) continue;
      lines.push(`  ${group}:`);
      for (const name of Object.keys(files).sort()) {
        /*
         * `|-` block scalars, so a reviewer reads a prompt change as a prompt
         * change. A quoted one-line string would render every edit as one
         * enormous unreadable diff, which is the same as no diff at all.
         *
         * Trailing newlines are stripped because `|-` re-adds none, and the
         * loader compares content, not trailing whitespace.
         */
        lines.push(`    ${name}: |-`, ...(files[name] as string).replace(/\n+$/u, "").split("\n").map((line) => (line.length === 0 ? "" : `      ${line}`)));
      }
    }
  }
  if (values.desiredState?.revision) lines.push(`  revision: ${values.desiredState.revision}`);
  lines.push(`promptSha256: ${values.promptSha256}`);
  return `${lines.join("\n")}\n`;
}
