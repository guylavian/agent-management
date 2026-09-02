import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { configFiles } from "./app-config.ts";
import { isAgentEnabled, type AgentDocument, type AgentRouting } from "./schemas.ts";

/**
 * The Manager's EFFECTIVE agent catalog.
 *
 * It is DERIVED, never authored:
 *
 *     config/agents/*.yaml                    (what an Agent is)
 *          ∩
 *     deploy/environments/<env>/agents/*.yaml (whether it is deployed here)
 *          +
 *     the Service naming convention           (where it is)
 *          =
 *     effective catalog
 *
 * There used to be a hand-maintained `registry.yaml` per environment carrying
 * routing vocabulary AND endpoints AND enablement together. Onboarding an Agent
 * meant editing three files that could disagree, and a routing fix in one
 * environment silently did not apply to another. Routing now lives with the
 * Agent; only placement and enablement are per environment.
 */

export const DEFAULT_ENDPOINT_TEMPLATE = "http://sre-agent-{agentId}.{namespace}.svc.cluster.local";

/**
 * Per-environment platform settings. The Helm chart owns the Service naming
 * convention; this is where the Manager is told what that convention is, so
 * finding a specialist needs no Kubernetes API discovery or watch.
 */
export const environmentSettingsSchema = z
  .object({
    apiVersion: z.literal("sre.ai/v1alpha1"),
    kind: z.literal("DeploymentEnvironment"),
    environment: z.string().min(1),
    namespace: z.string().min(1),
    // `{agentId}` and `{namespace}` are substituted; must agree with deploy/runtime/helm
    endpointTemplate: z.string().min(1).default(DEFAULT_ENDPOINT_TEMPLATE),
  })
  .strict();

export type EnvironmentSettings = z.infer<typeof environmentSettingsSchema>;

/**
 * The deployment overlay — an ALLOW-LIST. `.strict()` is not a stylistic choice
 * here: it is what stops an environment overlay from quietly redefining
 * routing, capabilities, tool access or ownership and becoming a second logical
 * source of truth. Adding a field is a deliberate act, mirrored by the JSON
 * Schema under deploy/schemas.
 */
export const agentDeploymentOverlaySchema = z
  .object({
    apiVersion: z.literal("sre.ai/v1alpha1"),
    kind: z.literal("AgentDeployment"),
    agentId: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    enabled: z.boolean(),
    replicas: z.number().int().min(0).max(20).optional(),
    resources: z
      .object({
        requests: z.object({ cpu: z.string().min(1), memory: z.string().min(1) }).strict().optional(),
        limits: z.object({ cpu: z.string().min(1), memory: z.string().min(1) }).strict().optional(),
      })
      .strict()
      .optional(),
    serviceAccount: z.string().min(1).optional(),
    /** escape hatch for environments that cannot follow the naming convention (local compose, loopback PoC) */
    endpoint: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "endpoint must use HTTP(S)").optional(),
  })
  .strict();

export type AgentDeploymentOverlay = z.infer<typeof agentDeploymentOverlaySchema>;

export interface AgentCatalogEntry {
  agentId: string;
  endpoint: string;
  owner: string;
  description: string;
  enabled: boolean;
  environments: string[];
  requiredRoles: string[];
  allowedNeedsDomains: string[];
  routing: AgentRouting;
}

export interface AgentCatalog {
  resolve(agentId: string): AgentCatalogEntry | undefined;
  listEnabled(environment?: string): AgentCatalogEntry[];
  filterAuthorized(agentIds: string[], roles: string[], environment: string): string[];
  mayRequestDomain(originAgentId: string, targetAgentId: string): boolean;
}

export class StaticAgentCatalog implements AgentCatalog {
  readonly #entries: ReadonlyMap<string, Readonly<AgentCatalogEntry>>;

  constructor(entries: AgentCatalogEntry[]) {
    const mapped = new Map<string, Readonly<AgentCatalogEntry>>();
    for (const entry of entries) {
      if (mapped.has(entry.agentId)) throw new Error(`duplicate catalog agentId ${entry.agentId}`);
      mapped.set(entry.agentId, Object.freeze(structuredClone(entry)));
    }
    for (const entry of mapped.values()) {
      for (const target of entry.allowedNeedsDomains) {
        if (!mapped.has(target) || target === entry.agentId) throw new Error(`invalid discovery edge ${entry.agentId} -> ${target}`);
      }
    }
    this.#entries = mapped;
  }

  resolve(agentId: string): AgentCatalogEntry | undefined {
    return this.#entries.get(agentId);
  }

  listEnabled(environment?: string): AgentCatalogEntry[] {
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

export function resolveEndpoint(agentId: string, settings: EnvironmentSettings, overlay?: AgentDeploymentOverlay): string {
  if (overlay?.endpoint !== undefined) return overlay.endpoint;
  return settings.endpointTemplate.replaceAll("{agentId}", agentId).replaceAll("{namespace}", settings.namespace);
}

/**
 * An Agent is routable only if BOTH its lifecycle is active (a statement about
 * the Agent) and the environment enables it (a statement about the deployment).
 * Every canonical specialist appears in the catalog either way, so a discovered
 * domain that exists but is not deployed here stays distinguishable from a typo.
 */
export function buildAgentCatalog(
  documents: AgentDocument[],
  settings: EnvironmentSettings,
  overlays: Map<string, AgentDeploymentOverlay>,
): StaticAgentCatalog {
  const entries: AgentCatalogEntry[] = [];
  for (const doc of documents) {
    if (doc.spec.type !== "specialist") continue;
    const spec = doc.spec;
    const overlay = overlays.get(doc.metadata.name);
    entries.push({
      agentId: doc.metadata.name,
      endpoint: resolveEndpoint(doc.metadata.name, settings, overlay),
      owner: doc.metadata.owner,
      description: doc.metadata.description ?? doc.metadata.displayName ?? doc.metadata.name,
      enabled: isAgentEnabled(spec) && overlay?.enabled === true,
      environments: spec.environments,
      requiredRoles: spec.authorization.requiredRoles,
      allowedNeedsDomains: spec.discovery?.allowedNeedsDomains ?? [],
      routing: spec.routing,
    });
  }
  return new StaticAgentCatalog(entries);
}

export interface DeploymentEnvironment {
  settings: EnvironmentSettings;
  overlays: Map<string, AgentDeploymentOverlay>;
  /** the manager's own deployment overlay; not a catalog entry, the Manager does not route to itself */
  manager?: AgentDeploymentOverlay;
}

/** Read `deploy/environments/<env>/` — environment.yaml, manager.yaml and agents/*.yaml. */
export function loadDeploymentEnvironment(directory: string, baseDir = process.cwd()): DeploymentEnvironment {
  const root = resolvePath(baseDir, directory);
  const settings = environmentSettingsSchema.parse(parseYaml(readFileSync(join(root, "environment.yaml"), "utf8")));
  const overlays = new Map<string, AgentDeploymentOverlay>();
  const agentsDir = join(root, "agents");
  for (const file of configFiles(agentsDir)) {
    const overlay = agentDeploymentOverlaySchema.parse(parseYaml(readFileSync(join(agentsDir, file), "utf8")));
    if (overlays.has(overlay.agentId)) throw new Error(`duplicate deployment overlay for ${overlay.agentId} in ${directory}`);
    overlays.set(overlay.agentId, overlay);
  }
  const manager = agentDeploymentOverlaySchema.parse(parseYaml(readFileSync(join(root, "manager.yaml"), "utf8")));
  return { settings, overlays, manager };
}

export function loadModelBindings(directory: string, baseDir = process.cwd()): ModelBindings {
  const file = join(resolvePath(baseDir, directory), "model-bindings.yaml");
  return modelBindingsSchema.parse(parseYaml(readFileSync(file, "utf8")));
}

/**
 * ENVIRONMENT model bindings: logical profile -> the model actually served here.
 *
 * Deliberately carries no credential and no required endpoint. Endpoints and API
 * keys reach the pod through the integrations Secret referenced by the runtime
 * chart, so nothing credential-shaped is ever rendered into Git.
 */
export const modelBindingsSchema = z
  .object({
    apiVersion: z.literal("sre.ai/v1alpha1"),
    kind: z.literal("ModelBindings"),
    environment: z.string().min(1),
    profiles: z.record(
      z.string().min(1),
      z
        .object({
          provider: z.string().min(1),
          model: z.string().min(1),
          /** optional; only for environments that publish a non-secret endpoint */
          endpoint: z.url().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type ModelBindings = z.infer<typeof modelBindingsSchema>;

/** The environment variable a logical model profile is rendered to. */
export const MODEL_PROFILE_ENV: Readonly<Record<string, string>> = Object.freeze({
  "manager-router": "SRE_MODEL_MANAGER",
  "tool-caller": "SRE_MODEL_TOOL_CALLER",
  "tier-l-synthesis": "SRE_MODEL_SYNTHESIS",
});

/**
 * Helm values for exactly one Agent in one environment — the renderer's output
 * and the only thing Argo CD reads. Strict, so a hand edit that adds a field
 * fails validation instead of silently diverging from the render.
 */
/**
 * A file the deployment MOUNTS into the workload: relative name → contents.
 *
 * This is a PROJECTION of Git, never a second source of truth. Git holds the
 * Agent; the renderer copies it here so Argo can deliver it to a running pod
 * without a new image, and `check:generated` fails the moment the copy drifts
 * from the original.
 */
const mountedFiles = z.record(z.string().regex(/^[a-z][a-z0-9._-]*$/u), z.string());

export const renderedAgentValuesSchema = z
  .object({
    agent: z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]*$/u),
        mode: z.enum(["manager", "specialist"]),
        configFile: z.string().min(1),
      })
      .strict(),
    /*
     * MUTABLE DESIRED STATE, DELIVERED BY ARGO RATHER THAN BY THE IMAGE.
     *
     * The runtime image bakes `platform/config` and `deploy/environments` so a
     * working tree and a container resolve the same relative paths. That is
     * fine for code and for defaults, and wrong for Agent desired state: a
     * merged pull request changed Git, Argo reconciled, and the running Manager
     * went on reading the registry from the image it was built with. A new
     * Agent needed an image rebuild before it could be discovered.
     *
     * These files are mounted OVER the baked copies as whole directories, so
     * the kubelet's atomic `..data` symlink swap delivers a complete new
     * version and the runtime's revalidation picks it up in place. No rollout,
     * no restart, one generic image.
     *
     * A specialist gets only its own prompt — it loads one Agent document, and
     * shipping it the whole estate would be handing every pod a list of every
     * other Agent for no reason.
     */
    desiredState: z
      .object({
        /** manager only: every canonical Agent document, keyed `<name>.yaml` */
        agents: mountedFiles.optional(),
        /** the prompt bodies this workload resolves, keyed `<name>.md` */
        prompts: mountedFiles,
        /** manager only: this environment's deployment overlays, keyed `<name>.yaml` */
        overlays: mountedFiles.optional(),
        /** manager only: `environment.yaml` and `manager.yaml` for this environment */
        environmentFiles: mountedFiles.optional(),
        /**
         * One digest over every file above, stamped into EVERY ConfigMap this
         * workload mounts.
         *
         * The four volumes are separate Kubernetes objects and the kubelet
         * swaps each independently, so a pod can briefly hold overlays from
         * commit N+1 beside agent documents from commit N. Each directory is
         * internally consistent, nothing is mid-write, and a fingerprint taken
         * before and after the read is identical — so a straddle check cannot
         * see it. Comparing this stamp across the mounts can.
         */
        revision: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    deploymentEnvironment: z.string().min(1),
    environment: z.string().min(1),
    replicaCount: z.number().int().min(0).max(20),
    resources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).strict(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).strict(),
      })
      .strict(),
    serviceAccount: z.object({ name: z.string().min(1) }).strict().optional(),
    /** logical profile -> served model id; never an endpoint or a key */
    modelEnv: z.record(z.string().min(1), z.string().min(1)),
    /** proves the renderer resolved the prompt, and makes a prompt change a visible diff */
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type RenderedAgentValues = z.infer<typeof renderedAgentValuesSchema>;
