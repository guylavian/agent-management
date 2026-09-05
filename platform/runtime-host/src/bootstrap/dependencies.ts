import { createPublicKey } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { SpecialistTransport } from "@sre/agent-protocol";
import {
  JwksDelegatedIdentityVerifier,
  KeycloakWorkloadCredentialExchanger,
  MockDelegationAuthority,
  MockOidcClient,
  MockToolCredentialAuthority,
  PrivateKeyDelegatedIdentityIssuer,
  PrivateKeyToolCredentialExchanger,
  PublicKeyDelegatedIdentityVerifier,
  RealOidcClient,
  RealTokenExchangeCredentialExchanger,
  type DelegatedIdentityIssuer,
  type DelegatedIdentityVerifier,
  type OidcClient,
  type ToolCredentialExchanger,
} from "@sre/auth";
import {
  loadAgentInstance,
  loadAppConfig,
  loadApprovedCatalog,
  loadModelProfiles,
  ConfigValidationError,
  type AgentCatalog,
  type AppConfig,
  type ApprovedCatalog,
  type ManagerAgentConfig,
  type SpecialistAgentConfig,
} from "@sre/config";
import { MockModelClient, RealOpenAiCompatibleClient, type ModelClient } from "@sre/llm";
import { MockSpecialistTransport, type SessionStore } from "@sre/orchestrator";
import { DisabledSessionStore, MockSessionStore, PostgresSessionStore } from "@sre/orchestrator";
import { DisabledAgentRepository, PostgresAgentRepository, type AgentRepository } from "@sre/orchestrator";
import { ArgoCdStatusSource, HttpRuntimeProbe, InMemoryRunStore, PostgresRunStore, type DeploymentStatusSource, type RunStore, type RuntimeProbe } from "../management/index.ts";
import { effectiveCatalog, NOTHING_OBSERVED, ProbeAvailabilityMonitor, type AvailabilityView } from "./availability.ts";
import { envelopeDigest, operationalCatalog, OperationalStateView } from "./operational.ts";
import { agentInstanceSource, desiredStateSource, type DesiredStateSource } from "./desired-state.ts";
import { ClientCredentialsWorkloadTokenProvider, HttpSpecialistTransport, MockWorkloadTokenProvider, ProjectedWorkloadTokenProvider } from "../transport/http.ts";
import { InProcessSpecialistTransport } from "../transport/in-process.ts";
import { DirectMcpClient, mcpEndpointsFromEnv, MockToolHiveClient, RealToolHiveClient, type ToolHiveClient } from "../adapters/index.ts";

/**
 * Creates a reachability probe for the OIDC JWKS endpoint.
 * GET the JWKS URL with a short timeout (2s). Any HTTP response (including 401/404)
 * is treated as reachable; only connection failure or timeout means unreachable.
 */
function createOidcProbe(oidc: OidcClient, config: AppConfig): (() => Promise<void>) | undefined {
  if (oidc.mode !== "real") return undefined;
  // RealOidcClient requires a jwksUri; it throws in constructor if missing
  const jwksUri = config.oidc.jwksUri;
  if (!jwksUri) return undefined;
  return async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(jwksUri, { signal: controller.signal });
      // Any HTTP response (including 401/404) is treated as reachable
      if (!response.ok) return;
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Creates a reachability probe for the model endpoint.
 * GET the base URL with a short timeout (2s). Any HTTP response (including 401/404)
 * is treated as reachable; only connection failure or timeout means unreachable.
 * Comment: this probes reachability, not readiness — a 401 means the endpoint is up.
 */
function createModelProbe(model: ModelClient, config: AppConfig): (() => Promise<void>) | undefined {
  if (model.mode !== "real") return undefined;
  const baseUrl = config.llm.baseUrl ?? config.llm.tierSUrl;
  if (!baseUrl) return undefined;
  return async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const probeUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
      const response = await fetch(probeUrl, { signal: controller.signal });
      // Any HTTP response (including 401/404) is treated as reachable
      if (!response.ok) return;
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * THE COMPOSITION ROOT.
 *
 * This is the only place in the repository allowed to see both agent-engine and
 * orchestrator. Every other component receives what it needs through a contract:
 * the orchestrator gets a SpecialistTransport and never learns whether a
 * specialist is a process across the network or an object in this heap.
 *
 * Startup fails closed. A "real" client without its endpoint, a delegation key
 * that is missing, an allowed agent that is not in the catalog — each throws
 * here rather than surfacing as a runtime error on someone's first question.
 */
interface CommonDependencies {
  config: AppConfig;
  model: ModelClient;
}

export interface ManagerDependencies extends CommonDependencies {
  mode: "manager";
  agent: ManagerAgentConfig;
  oidc: OidcClient;
  synthesisModel: ModelClient;
  /**
   * Backs console assistance on the platform `prompt-assist` profile. It is the
   * SAME transport as every other model — only the logical profile differs, so
   * an environment binds it wherever it binds the rest, including an internal
   * OpenAI-compatible endpoint in an air-gapped deployment.
   */
  promptAssistModel: ModelClient;
  /**
   * The routing catalog, as a LIVE view of desired state rather than a snapshot
   * taken at boot. Disabling an Agent in Git stops it being routed on the next
   * request; there is no restart in that path any more.
   */
  registry: AgentCatalog;
  agentClient: SpecialistTransport;
  identityIssuer: DelegatedIdentityIssuer;
  sessionStore: SessionStore;
  delegationPublicJwks?: Array<Record<string, unknown>>;
  /**
   * THE one source of Git desired state for this process. The management API
   * projects it and the router above is derived from it, so the console and the
   * orchestrator cannot disagree about which Agents exist or which are enabled.
   */
  desiredState: DesiredStateSource;
  /** the operational control plane: suspend and resume only, or Disabled */
  agentRepository: AgentRepository;
  /** the synchronous view the routing catalog is narrowed by */
  operational: OperationalStateView;
  runs: RunStore;
  /** Argo CD and pod readiness. Absent means the console reports `unknown`, never a colour. */
  argo?: DeploymentStatusSource;
  runtimeProbe?: RuntimeProbe;
  /** optional probes for external dependencies (OIDC, model endpoint) */
  probes?: { oidc?: () => Promise<void>; model?: () => Promise<void> };
}

/**
 * The keys a verifier needs to check what this platform signs.
 *
 * Two different things are signed: the delegated identity (by the Manager) and
 * the tool credential (by each specialist). A verifier resolves by `kid`, and
 * specialists sign tool credentials as `sre-<agentId>` — so every one of those
 * kids has to resolve, or the first tool call is rejected before it is made.
 */
function publishedJwks(delegationPublicKey: string, config: AppConfig, registry: AgentCatalog): Array<Record<string, unknown>> {
  const keys: Array<Record<string, unknown>> = [
    { ...createPublicKey(delegationPublicKey).export({ format: "jwk" }), kid: "sre-real-poc", use: "sig", alg: "RS256" },
  ];
  const toolPublicKeyFile = config.toolCredential.publicKeyFile;
  if (toolPublicKeyFile !== undefined && existsSync(toolPublicKeyFile)) {
    const toolJwk = createPublicKey(readFileSync(toolPublicKeyFile, "utf8")).export({ format: "jwk" });
    for (const entry of registry.listEnabled()) {
      keys.push({ ...toolJwk, kid: `sre-${entry.agentId}`, use: "sig", alg: "RS256" });
    }
  }
  return keys;
}

export interface SpecialistDependencies extends CommonDependencies {
  mode: "specialist";
  /** the document as it was at STARTUP; use `agentOf()` on the request path */
  agent: SpecialistAgentConfig;
  /**
   * The LIVE document, re-read from the mounted volume.
   *
   * The request path must use this rather than `agent`. Enforcement reads the
   * tool allowlist from whatever object it is handed, so a boot-time copy keeps
   * granting access that Git has already narrowed.
   */
  agentOf: () => SpecialistAgentConfig;
  catalog: ApprovedCatalog;
  toolhive: ToolHiveClient;
  credentialExchanger: ToolCredentialExchanger;
  identityVerifier: DelegatedIdentityVerifier;
  workloadOidc?: OidcClient;
  /** service-account subject the calling Manager must present; see verifyWorkloadIdentity */
  expectedManagerSubject?: string;
}

export type ApiDependencies = ManagerDependencies | SpecialistDependencies;

export function buildDependencies(env: Record<string, string | undefined> = process.env): ApiDependencies {
  const config = loadAppConfig(env);
  const agent = loadAgentInstance({ configFile: config.agentConfigFile, mcpServersDir: config.mcpServersDir });
  assertDeclaredRole(config, agent);
  const modelMap = buildModelMap(config, config.llm.model);
  // FAIL CLOSED: an enabled Agent whose model profile does not resolve in this
  // environment is a startup error, not a surprise on someone's first question.
  assertModelProfilesResolve(config, agent, modelMap);
  assertDesiredStateIsMounted(config, agent, env);
  const model = config.clients.llm === "mock" ? new MockModelClient() : buildRealModel(config);
  const mockDelegation = config.clients.delegation === "mock"
    ? new MockDelegationAuthority({ issuer: config.delegation.issuer, secret: config.delegation.mockSecret })
    : undefined;

  if (agent.spec.type === "manager") {
    const managerAgent = agent as ManagerAgentConfig;
    // The Manager's effective catalog is DERIVED: canonical Agents intersected
    // with this environment's deployment state. There is no registry file to
    // edit, so an Agent cannot be added to routing without adding the Agent.
    // ONE source, re-read on demand. `loadEffectiveAgentCatalog` still runs on
    // the first call, so an invalid configuration is still a startup failure.
    const desiredState = desiredStateSource({ ...configPaths(config), deploymentEnvironmentDir: config.deploymentEnvironmentDir });
    /*
     * The catalog is desired state INTERSECTED WITH OBSERVED AVAILABILITY, and
     * the management API is handed this same object. There is one answer to
     * "may the Manager route here", not a routing one and a console one.
     */
    const runtimeProbe = config.reconciliation.probeRuntime ? new HttpRuntimeProbe() : undefined;
    const availability: AvailabilityView = runtimeProbe === undefined
      ? NOTHING_OBSERVED
      : new ProbeAvailabilityMonitor(runtimeProbe, () => desiredState.current().catalog.listEnabled()).start();
    /*
     * THE OPERATIONAL MEET, if a control plane is wired.
     *
     * `effectiveCatalog` is Git desired state intersected with observed
     * availability. `operationalCatalog` adds the third term: the activation
     * row, the suspension, and attestations stamped with the envelope they were
     * made against.
     *
     * When no repository is configured this is the identity function, so a
     * deployment that has not adopted the operational plane behaves exactly as
     * before. When one IS configured but unavailable, it fails closed — those
     * two must never collapse into each other.
     */
    const agentRepository: AgentRepository = config.reconciliation.operationalPlane && config.postgres.connectionString !== undefined
      ? new PostgresAgentRepository(config.postgres.connectionString)
      : new DisabledAgentRepository();
    const operational = new OperationalStateView(agentRepository, deploymentEnvironmentName(config));
    if (operational.configured) operational.start();
    const registry = operationalCatalog(
      effectiveCatalog(desiredState, availability),
      operational,
      (agentId) => {
        const snapshot = desiredState.current();
        /*
         * Refuse to admit anything from an envelope we cannot vouch for. When
         * the last reload failed, this snapshot may predate a narrowing or a
         * revocation, and resuming against it would be exactly the
         * stale-authority resurrection the design forbids.
         */
        if (snapshot.error !== undefined) return undefined;
        const agent = snapshot.registry.getSpecialist(agentId);
        if (agent === undefined) return undefined;
        const overlay = snapshot.overlays.get(agentId);
        return envelopeDigest(agent, snapshot.environment, overlay);
      },
      config.defaultEnvironment,
    );
    let agentClient: SpecialistTransport;
    if (config.clients.agent === "inprocess") {
      // single-process local PoC: the manager executes specialists in-process.
      // Uses the same delegation authority so the per-agent identity JWT verifies.
      agentClient = new InProcessSpecialistTransport(
        () => desiredState.current().registry,
        { model, toolhive: buildToolhive(config, env) },
        mockDelegation as MockDelegationAuthority,
      );
    } else if (config.clients.agent === "mock") {
      agentClient = new MockSpecialistTransport();
    } else if (config.clients.agent === "http-local") {
      // distributed local PoC: HTTP fan-out with a fixed mock workload token
      agentClient = new HttpSpecialistTransport(registry, new MockWorkloadTokenProvider());
    } else {
      const tokenProvider = config.agentTransport.workloadTokenFile
        ? new ProjectedWorkloadTokenProvider(config.agentTransport.workloadTokenFile)
        : new ClientCredentialsWorkloadTokenProvider({
          tokenEndpoint: config.agentTransport.tokenEndpoint as string,
          clientId: config.agentTransport.clientId as string,
          clientSecret: config.agentTransport.clientSecret as string,
        });
      agentClient = new HttpSpecialistTransport(registry, tokenProvider);
    }
    const delegationPrivateKey = readConfiguredSecret(config.delegation.privateKeyPkcs8, config.delegation.privateKeyFile);
    if (config.clients.delegation === "real" && delegationPrivateKey === undefined) throw new Error("manager mode requires a delegation private key");
    const identityIssuer = config.clients.delegation === "mock" ? mockDelegation as MockDelegationAuthority : new PrivateKeyDelegatedIdentityIssuer({ issuer: config.delegation.issuer, privateKeyPkcs8: delegationPrivateKey as string });
    const delegationPublicKey = config.delegation.publicKeyFile ? readFileSync(config.delegation.publicKeyFile, "utf8") : undefined;
    const oidc = config.clients.oidc === "mock" ? new MockOidcClient(config.oidc) : new RealOidcClient(config.oidc);
    const oidcProbe = createOidcProbe(oidc, config);
    const modelProbe = createModelProbe(model, config);
    return {
      mode: "manager",
      config,
      agent: managerAgent,
      registry,
      agentClient,
      runs: config.clients.postgres === "real" && config.postgres.connectionString !== undefined
        ? new PostgresRunStore(config.postgres.connectionString)
        : new InMemoryRunStore(),
      desiredState,
      agentRepository,
      operational,
      ...(buildArgo(config) ? { argo: buildArgo(config) as DeploymentStatusSource } : {}),
      ...(runtimeProbe ? { runtimeProbe } : {}),
      identityIssuer,
      model,
      promptAssistModel: buildPromptAssistModel(config, model),
      synthesisModel: config.clients.llm === "mock" ? model : config.llm.baseUrl ? model : new RealOpenAiCompatibleClient(config.llm.tierLUrl as string, { modelMap: buildModelMap(config, config.llm.tierLModel ?? config.llm.model), temperatureMap: buildTemperatureMap(config), ...(config.llm.systemSuffix ? { systemSuffix: config.llm.systemSuffix } : {}) }),
      oidc,
      sessionStore: config.clients.postgres === "mock" ? new MockSessionStore() : config.clients.postgres === "disabled" ? new DisabledSessionStore() : new PostgresSessionStore(config.postgres.connectionString as string),
      ...(delegationPublicKey ? { delegationPublicJwks: publishedJwks(delegationPublicKey, config, registry) } : {}),
      ...(oidcProbe || modelProbe ? { probes: { ...(oidcProbe ? { oidc: oidcProbe } : {}), ...(modelProbe ? { model: modelProbe } : {}) } } : {}),
    };
  }

  const specialistAgent = agent as SpecialistAgentConfig;
  const catalog = loadApprovedCatalog(config.mcpServersDir);
  if (config.clients.delegation === "real" && config.delegation.jwksUri === undefined && config.delegation.publicKeyFile === undefined) throw new Error("specialist mode requires a delegation JWKS URI or public key file");
  const identityVerifier = config.clients.delegation === "mock"
    ? mockDelegation as MockDelegationAuthority
    : config.delegation.publicKeyFile
      ? new PublicKeyDelegatedIdentityVerifier({ issuer: config.delegation.issuer, publicKeySpki: readFileSync(config.delegation.publicKeyFile, "utf8") })
      : new JwksDelegatedIdentityVerifier({ issuer: config.delegation.issuer, jwksUri: config.delegation.jwksUri as string });
  // one mock authority both issues (specialist side) and verifies (gateway side) the tool credential, so the shared key matches
  const toolAuthority = config.clients.toolhive === "mock"
    ? new MockToolCredentialAuthority({ issuer: config.toolCredential.issuer, secret: config.delegation.mockSecret })
    : undefined;
  const credentialExchanger: ToolCredentialExchanger = config.clients.toolhive === "mock"
    ? toolAuthority as MockToolCredentialAuthority
    : config.toolCredential.strategy === "signed-jwt"
      ? new PrivateKeyToolCredentialExchanger({ issuer: config.toolCredential.issuer, privateKeyPkcs8: readFileSync(config.toolCredential.privateKeyFile as string, "utf8"), agentId: specialistAgent.name })
      : config.toolCredential.strategy === "workload-client"
        // the client id comes from this Agent's own canonical config, never from env,
        // so a process cannot be pointed at another Agent's workload identity
        ? new KeycloakWorkloadCredentialExchanger({
            tokenEndpoint: config.toolCredential.tokenEndpoint as string,
            clientId: specialistAgent.spec.identity.clientId,
            clientSecret: () => config.toolCredential.clientSecret as string,
            issuer: config.toolCredential.issuer,
            ...(config.toolCredential.jwksUri ? { jwksUri: config.toolCredential.jwksUri } : {}),
          })
        // the delegation ACTOR is this pod's own projected service-account token;
        // the SUBJECT is attached per request by withDelegationAssertion
        : new RealTokenExchangeCredentialExchanger({
            ...config.toolCredential,
            clientSecret: () => config.toolCredential.clientSecret as string,
            actorToken: async () => (await readFile(config.agentTransport.workloadTokenFile as string, "utf8")).trim(),
          });
  const agentOf = agentInstanceSource({
    configFile: config.agentConfigFile,
    mcpServersDir: config.mcpServersDir,
    agentsDir: config.agentsDir,
    promptsDir: config.promptsDir,
  });
  return {
    mode: "specialist",
    config,
    ...(config.internalOidc.expectedSubject ? { expectedManagerSubject: config.internalOidc.expectedSubject } : {}),
    agent: specialistAgent,
    // a manager document can never reach this branch: assertDeclaredRole and
    // the type switch above both already refused it
    agentOf: () => agentOf() as SpecialistAgentConfig,
    catalog,
    model,
    toolhive: buildToolhive(config, env, toolAuthority),
    credentialExchanger,
    identityVerifier,
    ...(config.clients.agent === "real" ? { workloadOidc: new RealOidcClient(config.internalOidc) } : {}),
  };
}

/**
 * ROLE and AGENT_ID describe what a deployment BELIEVES it is running. The Agent
 * document is what it IS. Trusting the environment variable would create a
 * second source of truth; ignoring it would let a manifest that mounted the
 * wrong configuration start silently as the wrong agent. So it is checked.
 */
function assertDeclaredRole(config: AppConfig, agent: ManagerAgentConfig | SpecialistAgentConfig): void {
  const actualRole = agent.spec.type === "manager" ? "manager" : "specialist";
  if (config.role !== undefined && config.role !== actualRole) {
    throw new ConfigValidationError(`unsafe configuration:\n- ROLE declares "${config.role}" but ${config.agentConfigFile} is a ${actualRole}`);
  }
  if (config.agentId !== undefined && config.agentId !== agent.name) {
    throw new ConfigValidationError(`unsafe configuration:\n- AGENT_ID declares "${config.agentId}" but ${config.agentConfigFile} defines agent "${agent.name}"`);
  }
}

/**
 * IN PRODUCTION, AGENT DESIRED STATE MUST BE MOUNTED, NOT BAKED.
 *
 * The image still ships `platform/config` and `deploy/environments`, because
 * the approved MCP catalog, the model profiles and the tool policy belong to
 * the reviewed artifact, and because a working tree and a container must
 * resolve the same relative paths. But the Agent registry, the prompts and the
 * deployment overlays are MUTABLE desired state: Argo delivers them, and a pod
 * that silently fell back to the image's copy would serve whatever the estate
 * looked like on build day. That is the exact failure this platform is supposed
 * not to have, and it produces no error of its own — the Manager simply never
 * discovers the Agent someone merged an hour ago.
 *
 * So it is checked. `..data` is how a kubelet builds a projected volume, and
 * its presence is the definitive evidence that this directory is delivered
 * rather than baked. A production deployment that is not on Kubernetes can say
 * so explicitly with SRE_ALLOW_BAKED_DESIRED_STATE=true and own the
 * consequence; there is deliberately no way to reach that state by accident.
 */
function assertDesiredStateIsMounted(
  config: AppConfig,
  agent: ManagerAgentConfig | SpecialistAgentConfig,
  env: Record<string, string | undefined>,
): void {
  if (config.env !== "production" && config.env !== "real-poc") return;
  if (env.SRE_ALLOW_BAKED_DESIRED_STATE === "true") return;

  // a specialist loads one Agent document and its prompt; the Manager
  // additionally derives its catalog from the registry and the overlays
  const required = agent.spec.type === "manager"
    ? [config.agentsDir, config.promptsDir, join(config.deploymentEnvironmentDir, "agents")]
    // a specialist needs BOTH: `AGENT_CONFIG` resolves into the agents
    // directory, so a baked one means the pod loads the document the image was
    // built with — or, for an Agent created since, finds no document at all
    : [config.agentsDir, config.promptsDir];
  const baked = required.filter((directory) => !existsSync(join(directory, "..data")));
  if (baked.length > 0) {
    throw new ConfigValidationError(
      `unsafe configuration:\n- Agent desired state is not mounted for ${baked.join(", ")}; ` +
      "these must be delivered as ConfigMap volumes by deploy/runtime/helm, or the runtime would serve the configuration baked into its image. " +
      "Set SRE_ALLOW_BAKED_DESIRED_STATE=true only if this deployment genuinely has no GitOps delivery path.",
    );
  }
}

/** The deployment environment this runtime serves, which keys the operational rows. */
function deploymentEnvironmentName(config: AppConfig): string {
  // `deploy/environments/<name>`; the trailing segment is the environment
  return config.deploymentEnvironmentDir.split("/").filter((part) => part.length > 0).pop() ?? "production";
}

export function configPaths(config: AppConfig): { agentsDir: string; promptsDir: string; mcpServersDir: string; modelProfilesFile: string; toolPolicyFile: string } {
  return {
    agentsDir: config.agentsDir,
    promptsDir: config.promptsDir,
    mcpServersDir: config.mcpServersDir,
    modelProfilesFile: config.modelProfilesFile,
    toolPolicyFile: config.toolPolicyFile,
  };
}

/**
 * Every logical profile this process will actually ask for must resolve to a
 * served model. A specialist needs its own profile; a manager additionally
 * routes and synthesises. Mock model runs are exempt because the mock answers
 * to any profile by construction.
 */
function assertModelProfilesResolve(config: AppConfig, agent: ManagerAgentConfig | SpecialistAgentConfig, modelMap: Record<string, string>): void {
  if (config.clients.llm === "mock") return;
  const required = agent.spec.type === "manager"
    ? [agent.spec.model.profile, "tier-l-synthesis"]
    : [agent.spec.model.profile];
  const unresolved = [...new Set(required)].filter((profile) => modelMap[profile] === undefined);
  if (unresolved.length > 0) {
    throw new ConfigValidationError(`unsafe configuration:\n- model profile(s) ${unresolved.join(", ")} cannot be resolved for agent "${agent.name}" in environment ${config.env}; set SRE_MODEL_* or SRE_LLM_MODEL`);
  }
}

/** Maps logical profiles to configured model ids; falls back to a single served model. */
/**
 * The client behind console assistance.
 *
 * When the environment binds its own endpoint, drafting runs there and nowhere
 * near the Agents' provider — which is the point of a platform profile: a dev
 * box can leave the Agents on a local model and point drafting at a hosted one,
 * and an air-gapped deployment points both at internal endpoints. With nothing
 * bound it reuses the shared client, so the feature still works out of the box.
 */
function buildPromptAssistModel(config: AppConfig, shared: ModelClient): ModelClient {
  const baseUrl = config.llm.promptAssistBaseUrl;
  if (baseUrl === undefined || config.clients.llm === "mock") return shared;
  const served = config.llm.promptAssistModel;
  return new RealOpenAiCompatibleClient(baseUrl, {
    ...(config.llm.promptAssistApiKey ? { apiKey: config.llm.promptAssistApiKey } : {}),
    ...(served ? { modelMap: { "prompt-assist": served } } : {}),
  });
}

/**
 * Per-profile sampling temperature, read from the SAME document that declares
 * the profiles. A profile that omits it leaves the provider default, so this
 * cannot quietly pin a temperature nobody asked for.
 */
export function buildTemperatureMap(config: AppConfig): Record<string, number> {
  const map: Record<string, number> = {};
  for (const profile of loadModelProfiles(config.modelProfilesFile).profiles) {
    if (profile.temperature !== undefined) map[profile.id] = profile.temperature;
  }
  return map;
}

export function buildModelMap(config: AppConfig, fallback?: string): Record<string, string> {
  const map: Record<string, string> = {};
  const manager = config.llm.managerModel ?? fallback;
  const tool = config.llm.toolCallerModel ?? fallback;
  const synthesis = config.llm.synthesisModel ?? config.llm.tierLModel ?? fallback;
  if (manager) map["manager-router"] = manager;
  if (tool) map["tool-caller"] = tool;
  if (synthesis) map["tier-l-synthesis"] = synthesis;
  /*
   * Platform assistance, bound per environment like any other profile.
   *
   * The fallback degrades through the profiles that ARE configured rather than
   * only through `llm.model`: a deployment that sets the three agent profiles
   * and nothing else — which is what the PoC does — would otherwise leave
   * `prompt-assist` out of the map entirely, and the literal string would travel
   * to the provider as if it were a served model id. The profile stays distinct
   * so an environment can still bind it somewhere else.
   */
  const promptAssist = config.llm.promptAssistModel ?? fallback ?? tool ?? manager;
  if (promptAssist) map["prompt-assist"] = promptAssist;
  return map;
}

function buildRealModel(config: AppConfig): RealOpenAiCompatibleClient {
  const baseUrl = config.llm.baseUrl ?? config.llm.tierSUrl;
  if (baseUrl === undefined) throw new Error("real llm requires SRE_LLM_BASE_URL or SRE_LLM_TIER_S_URL");
  return new RealOpenAiCompatibleClient(baseUrl, {
    ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}),
    modelMap: buildModelMap(config, config.llm.model),
    temperatureMap: buildTemperatureMap(config),
    ...(config.llm.systemSuffix ? { systemSuffix: config.llm.systemSuffix } : {}),
  });
}

function buildToolhive(config: AppConfig, env: Record<string, string | undefined>, verifier?: import("@sre/auth").ToolCredentialVerifier): ToolHiveClient {
  if (config.clients.toolhive === "mock") return new MockToolHiveClient(verifier);
  if (config.clients.toolhive === "direct") return new DirectMcpClient(mcpEndpointsFromEnv(env), new MockToolHiveClient(verifier));
  return new RealToolHiveClient(config.toolhive.url, config.toolhive.endpoints);
}

/**
 * Argo CD, only when an environment actually points at one. There is no default
 * URL: guessing one would turn "no Argo configured" into "Argo unreachable",
 * and those must not look alike on the console.
 */
function buildArgo(config: AppConfig): DeploymentStatusSource | undefined {
  const argo = config.reconciliation.argo;
  if (argo === undefined) return undefined;
  return new ArgoCdStatusSource({
    baseUrl: argo.baseUrl,
    token: argo.token,
    ...(argo.appTemplate ? { appTemplate: argo.appTemplate } : {}),
  });
}

function readConfiguredSecret(value: string | undefined, file: string | undefined): string | undefined {
  return value ?? (file ? readFileSync(file, "utf8") : undefined);
}

