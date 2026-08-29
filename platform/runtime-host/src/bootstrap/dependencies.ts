import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { DirectMcpClient, mcpEndpointsFromEnv, MockToolHiveClient, RealToolHiveClient, type ToolHiveClient } from "@sre/agent-engine";
import type { SpecialistTransport } from "@sre/agent-protocol";
import {
  AuthorizationService,
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
  loadAgentRegistry,
  loadAppConfig,
  loadApprovedCatalog,
  loadEffectiveAgentCatalog,
  ConfigValidationError,
  type AgentCatalog,
  type AgentRegistry,
  type AppConfig,
  type ApprovedCatalog,
  type ManagerAgentConfig,
  type SpecialistAgentConfig,
} from "@sre/config";
import { MockModelClient, RealOpenAiCompatibleClient, type ModelClient } from "@sre/llm";
import { MockSpecialistTransport, type SessionStore } from "@sre/orchestrator";
import { DisabledSessionStore, MockSessionStore, PostgresSessionStore } from "@sre/orchestrator";
import { InMemoryRunStore, type RunStore } from "../management/index.ts";
import { ClientCredentialsWorkloadTokenProvider, HttpSpecialistTransport, MockWorkloadTokenProvider, ProjectedWorkloadTokenProvider } from "../transport/http.ts";
import { InProcessSpecialistTransport } from "../transport/in-process.ts";

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
  registry: AgentCatalog;
  agentClient: SpecialistTransport;
  identityIssuer: DelegatedIdentityIssuer;
  sessionStore: SessionStore;
  delegationPublicJwk?: Record<string, unknown>;
  /**
   * Full agent registry, present only when every Agent document is mounted in
   * this process. The read-only management API needs it; the execution path
   * never does, so a deployment without the config mounted simply serves no
   * management surface rather than serving a partial one.
   */
  managementRegistry?: AgentRegistry;
  runs: RunStore;
}

export interface SpecialistDependencies extends CommonDependencies {
  mode: "specialist";
  agent: SpecialistAgentConfig;
  catalog: ApprovedCatalog;
  authorization: AuthorizationService;
  toolhive: ToolHiveClient;
  credentialExchanger: ToolCredentialExchanger;
  identityVerifier: DelegatedIdentityVerifier;
  workloadOidc?: OidcClient;
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
  const model = config.clients.llm === "mock" ? new MockModelClient() : buildRealModel(config);
  const mockDelegation = config.clients.delegation === "mock"
    ? new MockDelegationAuthority({ issuer: config.delegation.issuer, secret: config.delegation.mockSecret })
    : undefined;

  if (agent.spec.type === "manager") {
    const managerAgent = agent as ManagerAgentConfig;
    // The Manager's effective catalog is DERIVED: canonical Agents intersected
    // with this environment's deployment state. There is no registry file to
    // edit, so an Agent cannot be added to routing without adding the Agent.
    const registry = loadEffectiveAgentCatalog({ ...configPaths(config), deploymentEnvironmentDir: config.deploymentEnvironmentDir });
    let agentClient: SpecialistTransport;
    if (config.clients.agent === "inprocess") {
      // single-process local PoC: the manager executes specialists in-process.
      // Uses the same delegation authority so the per-agent identity JWT verifies.
      const fullRegistry = loadAgentRegistry(configPaths(config));
      agentClient = new InProcessSpecialistTransport(
        fullRegistry,
        {
          authorization: new AuthorizationService(fullRegistry),
          model,
          toolhive: buildToolhive(config, env),
        },
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
    // the same documents the catalog was derived from, reused for the read-only
    // management projection rather than loaded from a second place
    const managementRegistry: AgentRegistry = loadAgentRegistry(configPaths(config));
    return {
      mode: "manager",
      config,
      agent: managerAgent,
      registry,
      agentClient,
      runs: new InMemoryRunStore(),
      ...(managementRegistry ? { managementRegistry } : {}),
      identityIssuer,
      model,
      synthesisModel: config.clients.llm === "mock" ? model : config.llm.baseUrl ? model : new RealOpenAiCompatibleClient(config.llm.tierLUrl as string, { modelMap: buildModelMap(config, config.llm.tierLModel ?? config.llm.model), ...(config.llm.systemSuffix ? { systemSuffix: config.llm.systemSuffix } : {}) }),
      oidc: config.clients.oidc === "mock" ? new MockOidcClient(config.oidc) : new RealOidcClient(config.oidc),
      sessionStore: config.clients.postgres === "mock" ? new MockSessionStore() : config.clients.postgres === "disabled" ? new DisabledSessionStore() : new PostgresSessionStore(config.postgres.connectionString as string),
      ...(delegationPublicKey ? { delegationPublicJwk: { ...createPublicKey(delegationPublicKey).export({ format: "jwk" }), kid: "sre-real-poc", use: "sig", alg: "RS256" } } : {}),
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
      ? new PrivateKeyToolCredentialExchanger({ issuer: config.toolCredential.issuer, privateKeyPkcs8: readFileSync(config.toolCredential.privateKeyFile as string, "utf8") })
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
        : new RealTokenExchangeCredentialExchanger(config.toolCredential);
  return {
    mode: "specialist",
    config,
    agent: specialistAgent,
    catalog,
    model,
    authorization: new AuthorizationService(),
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

function configPaths(config: AppConfig): { agentsDir: string; promptsDir: string; mcpServersDir: string; modelProfilesFile: string; toolPolicyFile: string } {
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
function buildModelMap(config: AppConfig, fallback?: string): Record<string, string> {
  const map: Record<string, string> = {};
  const manager = config.llm.managerModel ?? fallback;
  const tool = config.llm.toolCallerModel ?? fallback;
  const synthesis = config.llm.synthesisModel ?? config.llm.tierLModel ?? fallback;
  if (manager) map["manager-router"] = manager;
  if (tool) map["tool-caller"] = tool;
  if (synthesis) map["tier-l-synthesis"] = synthesis;
  return map;
}

function buildRealModel(config: AppConfig): RealOpenAiCompatibleClient {
  const baseUrl = config.llm.baseUrl ?? config.llm.tierSUrl;
  if (baseUrl === undefined) throw new Error("real llm requires SRE_LLM_BASE_URL or SRE_LLM_TIER_S_URL");
  return new RealOpenAiCompatibleClient(baseUrl, {
    ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}),
    modelMap: buildModelMap(config, config.llm.model),
    ...(config.llm.systemSuffix ? { systemSuffix: config.llm.systemSuffix } : {}),
  });
}

function buildToolhive(config: AppConfig, env: Record<string, string | undefined>, verifier?: import("@sre/auth").ToolCredentialVerifier): ToolHiveClient {
  if (config.clients.toolhive === "mock") return new MockToolHiveClient(verifier);
  if (config.clients.toolhive === "direct") return new DirectMcpClient(mcpEndpointsFromEnv(env), new MockToolHiveClient(verifier));
  return new RealToolHiveClient(config.toolhive.url, config.toolhive.endpoints);
}

function readConfiguredSecret(value: string | undefined, file: string | undefined): string | undefined {
  return value ?? (file ? readFileSync(file, "utf8") : undefined);
}

