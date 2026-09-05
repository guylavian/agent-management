import { readdirSync } from "node:fs";
import { z } from "zod";

/**
 * Canonical configuration layout. One constant so a path change is one edit,
 * and so tests load exactly what the runtime loads rather than a fixture that
 * can drift from it.
 */
/**
 * Deployment desired state is a repository-root sibling of the platform, not a
 * child of it: `agent-engine`, `platform` and `deploy` are three first-class
 * concerns. Every path to it goes through here so the relationship is stated
 * once rather than spelled out in twenty string literals.
 */
export const DEPLOY_ROOT = "../deploy";

/**
 * Where the runtime sits inside the configuration repository.
 *
 * The runtime reads `config/agents/...` relative to itself, but that file is
 * `platform/config/agents/...` in Git. A change-set is committed to the
 * REPOSITORY, so its paths have to be repository-relative or a pull request
 * creates new files at the root and leaves the real ones untouched — a green
 * PR that changes nothing the runtime reads.
 *
 * `deploy/` is already repository-relative, which is what DEPLOY_ROOT exists
 * to express from the other direction.
 */
export const REPO_PREFIX = "platform";

/** A runtime-relative path as it is addressed in the repository. */
export function toRepoPath(path: string): string {
  return path.startsWith("deploy/") ? path : `${REPO_PREFIX}/${path}`;
}

/** The inverse: a repository path as this process addresses it on disk. */
export function fromRepoPath(path: string): string {
  if (path.startsWith(`${REPO_PREFIX}/`)) return path.slice(REPO_PREFIX.length + 1);
  if (path.startsWith("deploy/")) return `${DEPLOY_ROOT}/${path.slice("deploy/".length)}`;
  return path;
}

export function deployEnvironmentDir(environment: string): string {
  return `${DEPLOY_ROOT}/environments/${environment}`;
}

export const CONFIG_PATHS = {
  agentsDir: "config/agents",
  promptsDir: "config/prompts",
  mcpServersDir: "config/mcp-servers",
  modelProfilesFile: "config/model-profiles/profiles.yaml",
  toolPolicyFile: "config/policies/tool-policy.yaml",
} as const;

/**
 * Application configuration — fail-closed per TDD §22.
 * Every external integration is config-selected mock|real; a "real" client
 * requires its endpoint, and production forbids mocks entirely.
 */

const clientMode = z.enum(["mock", "real"]);

export const appConfigSchema = z
  .object({
    env: z.enum(["local", "test", "real-poc", "production"]).default("local"),
    port: z.coerce.number().int().min(1).max(65_535).default(3000),
    agentsDir: z.string().min(1).default(CONFIG_PATHS.agentsDir),
    agentConfigFile: z.string().min(1).default("config/agents/manager.yaml"),
    /**
     * Declared role and agent id. Both are OPTIONAL and never authoritative:
     * the Agent document decides what this process is. They exist so a
     * deployment can state its intent, and so a manifest that disagrees with
     * the configuration it mounted fails at startup instead of running as
     * something nobody asked for.
     */
    role: z.enum(["manager", "specialist"]).optional(),
    agentId: z.string().regex(/^[a-z][a-z0-9-]*$/u).optional(),
    promptsDir: z.string().min(1).default(CONFIG_PATHS.promptsDir),
    mcpServersDir: z.string().min(1).default(CONFIG_PATHS.mcpServersDir),
    modelProfilesFile: z.string().min(1).default(CONFIG_PATHS.modelProfilesFile),
    toolPolicyFile: z.string().min(1).default(CONFIG_PATHS.toolPolicyFile),
    /** the active environment's deployment desired state — enablement, placement, model bindings */
    deploymentEnvironmentDir: z.string().min(1).default(`${DEPLOY_ROOT}/environments/production`),
    requestDeadlineMs: z.coerce.number().int().min(1_000).max(600_000).default(45_000),
    /** in-flight /v1/query bound per instance; beyond it the runtime sheds load instead of queueing without limit */
    maxConcurrentQueries: z.coerce.number().int().min(1).max(10_000).default(64),
    defaultEnvironment: z.string().min(1).default("prod"),
    clients: z
      .object({
        oidc: clientMode.default("mock"),
        llm: clientMode.default("mock"),
        // "direct" reaches standalone MCP servers without ToolHive (local dev only)
        toolhive: z.enum(["mock", "real", "direct"]).default("mock"),
        postgres: z.enum(["mock", "real", "disabled"]).default("mock"),
        // "inprocess" runs specialists in the manager process (single-process local PoC)
        // "http-local" fans out over HTTP with mock local identity (distributed local PoC)
        agent: z.enum(["mock", "real", "inprocess", "http-local"]).default("mock"),
        delegation: clientMode.default("mock"),
      })
      .strict(),
    oidc: z
      .object({
        issuer: z.string().min(1).default("https://mock-idp.sre.local"),
        audience: z.string().min(1).default("sre-assistant"),
        jwksUri: z.string().optional(),
        // mock only: persist the dev signing key so a restart is not a key rotation
        mockKeyFile: z.string().optional(),
      })
      .strict(),
    internalOidc: z.object({
      issuer: z.string().min(1).default("https://mock-workload-idp.sre.local"),
      audience: z.string().min(1).default("sre-agent-runtime"),
      jwksUri: z.string().optional(),
      /**
       * The Manager's own service-account subject. Every pod mounts a projected
       * token for the SAME audience, so audience alone proves only "some agent
       * in this platform" — a specialist could present its own token and be
       * taken for the Manager. Specialists therefore pin the caller's subject.
       */
      expectedSubject: z.string().min(1).optional(),
    }).strict(),
    llm: z
      .object({
        // unified OpenAI-compatible endpoint (Groq / on-prem vLLM); preferred over tier URLs
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        // logical profile → served model id
        managerModel: z.string().optional(),
        toolCallerModel: z.string().optional(),
        /**
         * PLATFORM-level profile, not an Agent's. It backs console assistance
         * such as drafting a system prompt, and is bound per environment — a
         * hosted endpoint in dev, an internal OpenAI-compatible model in an
         * air-gapped deployment. It is never the model an Agent runs on.
         */
        promptAssistModel: z.string().optional(),
        /**
         * Its own endpoint, when console assistance should not run where the
         * Agents run. A dev box can leave the Agents on a local model and point
         * drafting at a hosted one; an air-gapped deployment points both at
         * internal endpoints. Falls back to the shared client when unset.
         */
        promptAssistBaseUrl: z.string().optional(),
        promptAssistApiKey: z.string().optional(),
        synthesisModel: z.string().optional(),
        // legacy per-tier endpoints (Ollama) kept for back-compat
        tierSUrl: z.string().optional(),
        tierLUrl: z.string().optional(),
        model: z.string().optional(),
        tierLModel: z.string().optional(),
        // prepended system message (e.g. "/no_think" for fast local qwen3)
        systemSuffix: z.string().optional(),
      })
      .strict(),
    toolhive: z.object({
      url: z.string().optional(),
      endpoints: z.record(z.string(), z.url()).default({}),
    }).strict(),
    /*
     * How this deployment observes ACTUAL state for the management console.
     *
     * Both halves are optional and BOTH DEFAULT TO OFF, because the console
     * reports an unobserved signal as `unknown` with the reason. A default
     * endpoint here would turn "nobody wired Argo up" into "Argo is down",
     * which is the kind of fabricated telemetry this platform refuses to emit.
     */
    reconciliation: z.object({
      argo: z.object({
        baseUrl: z.url(),
        token: z.string().min(1),
        /** `{agentId}`; must match the ApplicationSet template's metadata.name */
        appTemplate: z.string().min(1).optional(),
      }).strict().optional(),
      /** probe each enabled agent's own Service for readiness */
      probeRuntime: z.coerce.boolean().default(false),
      /**
       * Who writes the activation and attestation rows the operational plane
       * reads. Nothing in this repository runs that reconciler yet, so it must
       * be named explicitly rather than assumed — see the guard below.
       */
      reconciler: z.enum(["external"]).optional(),
      /*
       * The PostgreSQL operational control plane (suspend/resume + attested
       * readiness). OFF by default, and deliberately not inferred from Postgres
       * being configured: until a reconciler has written attestations, every
       * Agent resolves to not-routable — which is the correct fail-closed
       * default and a total outage if switched on by accident.
       */
      operationalPlane: z.coerce.boolean().default(false),
    }).strict().default({ probeRuntime: false, operationalPlane: false }),
    toolCredential: z.object({
      issuer: z.string().min(1).default("https://mock-toolhive-sts.sre.local"),
      audiencePrefix: z.string().min(1).default("sre-toolhive"),
      tokenEndpoint: z.string().optional(),
      // "workload-client": the Agent authenticates as its own Keycloak
      // service-account client and requests one MCP audience scope per call
      strategy: z.enum(["token-exchange", "signed-jwt", "workload-client"]).default("token-exchange"),
      /** public half of the signed-jwt key, published in the Manager's JWKS so a verifier can resolve the kid a specialist signs with */
      publicKeyFile: z.string().optional(),
      privateKeyFile: z.string().optional(),
      /** env-only; never read from Agent YAML and never logged — TDD §36 */
      clientSecret: z.string().optional(),
      jwksUri: z.string().optional(),
    }).strict(),
    postgres: z.object({ connectionString: z.string().optional() }).strict(),
    agentTransport: z.object({
      workloadTokenFile: z.string().optional(),
      tokenEndpoint: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
    }).strict(),
    delegation: z.object({
      issuer: z.string().min(1).default("https://mock-manager.sre.local"),
      mockSecret: z.string().min(32).default("local-only-delegation-secret-change-me-0001"),
      jwksUri: z.string().optional(),
      privateKeyPkcs8: z.string().optional(),
      privateKeyFile: z.string().optional(),
      publicKeyFile: z.string().optional(),
    }).strict(),
    telemetry: z
      .object({
        exporter: z.enum(["console", "otlp", "none"]).default("none"),
        otlpEndpoint: z.string().optional(),
        serviceName: z.string().default("sre-assistant"),
      })
      .strict(),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/** Build AppConfig from process env. Throws ConfigValidationError — startup must fail closed. */
export function loadAppConfig(env: Record<string, string | undefined>): AppConfig {
  const raw = {
    env: env.SRE_ENV,
    port: env.SRE_PORT,
    agentsDir: env.SRE_AGENTS_DIR,
    agentConfigFile: env.AGENT_CONFIG,
    role: env.ROLE,
    agentId: env.AGENT_ID,
    promptsDir: env.SRE_PROMPTS_DIR,
    mcpServersDir: env.SRE_MCP_SERVERS_DIR,
    modelProfilesFile: env.SRE_MODEL_PROFILES,
    toolPolicyFile: env.SRE_TOOL_POLICY,
    deploymentEnvironmentDir: env.SRE_DEPLOYMENT_ENVIRONMENT_DIR,
    requestDeadlineMs: env.SRE_REQUEST_DEADLINE_MS,
    maxConcurrentQueries: env.SRE_MAX_CONCURRENT_QUERIES,
    defaultEnvironment: env.SRE_DEFAULT_ENVIRONMENT,
    clients: {
      oidc: env.SRE_CLIENT_OIDC,
      llm: env.SRE_CLIENT_LLM,
      toolhive: env.SRE_CLIENT_TOOLHIVE,
      postgres: env.SRE_CLIENT_POSTGRES,
      agent: env.SRE_CLIENT_AGENT,
      delegation: env.SRE_CLIENT_DELEGATION,
    },
    oidc: {
      issuer: env.SRE_OIDC_ISSUER,
      audience: env.SRE_OIDC_AUDIENCE,
      jwksUri: env.SRE_OIDC_JWKS_URI,
      // local runs keep the mock key in the workspace (gitignored); anything
      // else generates per process as before
      mockKeyFile: env.SRE_MOCK_OIDC_KEY_FILE ?? (env.SRE_ENV === "local" ? ".sre-local/mock-oidc-key.pem" : undefined),
    },
    internalOidc: {
      issuer: env.SRE_INTERNAL_OIDC_ISSUER,
      audience: env.SRE_INTERNAL_OIDC_AUDIENCE,
      jwksUri: env.SRE_INTERNAL_OIDC_JWKS_URI,
      expectedSubject: env.SRE_INTERNAL_EXPECTED_SUBJECT,
    },
    llm: {
      baseUrl: env.SRE_LLM_BASE_URL,
      apiKey: env.SRE_LLM_API_KEY,
      managerModel: env.SRE_MODEL_MANAGER,
      toolCallerModel: env.SRE_MODEL_TOOL_CALLER,
      synthesisModel: env.SRE_MODEL_SYNTHESIS,
      promptAssistModel: env.SRE_MODEL_PROMPT_ASSIST,
      promptAssistBaseUrl: env.SRE_LLM_PROMPT_ASSIST_URL,
      promptAssistApiKey: env.SRE_LLM_PROMPT_ASSIST_API_KEY,
      tierSUrl: env.SRE_LLM_TIER_S_URL,
      tierLUrl: env.SRE_LLM_TIER_L_URL,
      model: env.SRE_LLM_MODEL,
      tierLModel: env.SRE_LLM_TIER_L_MODEL,
      systemSuffix: env.SRE_LLM_SYSTEM_SUFFIX,
    },
    toolhive: {
      url: env.SRE_TOOLHIVE_URL,
      endpoints: parseJsonObject(env.SRE_TOOLHIVE_ENDPOINTS_JSON),
    },
    reconciliation: {
      // both halves of the credential or nothing: a base URL with no token
      // would fail on every poll and read as "Argo is unhealthy"
      ...(env.SRE_ARGOCD_BASE_URL && env.SRE_ARGOCD_TOKEN
        ? {
          argo: {
            baseUrl: env.SRE_ARGOCD_BASE_URL,
            token: env.SRE_ARGOCD_TOKEN,
            ...(env.SRE_ARGOCD_APP_TEMPLATE ? { appTemplate: env.SRE_ARGOCD_APP_TEMPLATE } : {}),
          },
        }
        : {}),
      probeRuntime: env.SRE_RUNTIME_PROBE === "on",
      operationalPlane: env.SRE_OPERATIONAL_PLANE === "on",
      ...(env.SRE_OPERATIONAL_RECONCILER ? { reconciler: env.SRE_OPERATIONAL_RECONCILER } : {}),
    },
    toolCredential: {
      issuer: env.SRE_TOOL_CREDENTIAL_ISSUER,
      audiencePrefix: env.SRE_TOOL_CREDENTIAL_AUDIENCE_PREFIX,
      tokenEndpoint: env.SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT,
      strategy: env.SRE_TOOL_CREDENTIAL_STRATEGY,
      privateKeyFile: env.SRE_TOOL_CREDENTIAL_PRIVATE_KEY_FILE,
      publicKeyFile: env.SRE_TOOL_CREDENTIAL_PUBLIC_KEY_FILE,
      clientSecret: env.SRE_TOOL_CREDENTIAL_CLIENT_SECRET,
      jwksUri: env.SRE_TOOL_CREDENTIAL_JWKS_URI,
    },
    postgres: { connectionString: env.SRE_POSTGRES_URL },
    agentTransport: {
      workloadTokenFile: env.SRE_WORKLOAD_TOKEN_FILE,
      tokenEndpoint: env.SRE_WORKLOAD_TOKEN_ENDPOINT,
      clientId: env.SRE_WORKLOAD_CLIENT_ID,
      clientSecret: env.SRE_WORKLOAD_CLIENT_SECRET,
    },
    delegation: {
      issuer: env.SRE_DELEGATION_ISSUER,
      mockSecret: env.SRE_DELEGATION_MOCK_SECRET,
      jwksUri: env.SRE_DELEGATION_JWKS_URI,
      privateKeyPkcs8: env.SRE_DELEGATION_PRIVATE_KEY_PKCS8,
      privateKeyFile: env.SRE_DELEGATION_PRIVATE_KEY_FILE,
      publicKeyFile: env.SRE_DELEGATION_PUBLIC_KEY_FILE,
    },
    telemetry: {
      exporter: env.SRE_OTEL_EXPORTER,
      otlpEndpoint: env.SRE_OTEL_ENDPOINT,
      serviceName: env.SRE_OTEL_SERVICE_NAME,
    },
  };
  // drop undefined leaves so zod defaults apply
  const parsed = appConfigSchema.safeParse(prune(raw));
  if (!parsed.success) {
    throw new ConfigValidationError(`invalid application config: ${parsed.error.message}`);
  }
  const config = parsed.data;

  const problems: string[] = [];
  if (config.env === "production" || config.env === "real-poc") {
    for (const [name, mode] of Object.entries(config.clients)) {
      if (mode === "mock") problems.push(`client "${name}" is mock in ${config.env}`);
    }
    if (config.clients.agent === "inprocess" || config.clients.agent === "http-local") problems.push(`client "agent" is ${config.clients.agent} in ${config.env} (use real distributed agents)`);
    if (config.clients.toolhive === "direct") problems.push(`client "toolhive" is direct in ${config.env} (route through ToolHive)`);
  }
  if (config.clients.oidc === "real" && !config.oidc.jwksUri) {
    problems.push("oidc client is real but SRE_OIDC_JWKS_URI is unset");
  }
  // The operational plane decides whether an agent is routable at all. With no
  // database it silently falls back to a repository that reports nothing, and
  // with no reconciler the tables stay empty — both read as "no agent is
  // ready", which is a total routing outage produced by one variable.
  if (config.reconciliation.operationalPlane) {
    if (config.clients.postgres !== "real" || !config.postgres.connectionString) {
      problems.push("operational plane is on but Postgres is not configured — every agent would resolve to not-routable");
    }
    if (config.reconciliation.reconciler === undefined) {
      problems.push("operational plane is on but SRE_OPERATIONAL_RECONCILER is unset — nothing would write the activation and attestation rows it reads");
    }
  }
  if (config.clients.agent === "real" && !config.internalOidc.expectedSubject) {
    problems.push("agent client is real but SRE_INTERNAL_EXPECTED_SUBJECT is unset — a specialist would accept any platform workload token as the Manager");
  }
  // Only the token-exchange strategy presents the human as a verifiable
  // assertion. The others authorize the agent alone or rest on a single
  // platform key, so production refuses them rather than running weaker than
  // its own design claims.
  if (config.env === "production" && config.clients.toolhive !== "disabled" && config.toolCredential.strategy !== "token-exchange") {
    problems.push(`tool-credential strategy "${config.toolCredential.strategy}" is not permitted in production (use token-exchange, which delegates the human)`);
  }
  if (config.clients.toolhive === "real" && config.toolCredential.strategy === "token-exchange" && !config.toolCredential.clientSecret) {
    problems.push("token-exchange ToolHive credentials require SRE_TOOL_CREDENTIAL_CLIENT_SECRET to authenticate the exchange");
  }
  if (config.clients.agent === "real" && !config.internalOidc.jwksUri) {
    problems.push("agent client is real but SRE_INTERNAL_OIDC_JWKS_URI is unset");
  }
  if (config.clients.llm === "real" && !config.llm.baseUrl && (!config.llm.tierSUrl || !config.llm.tierLUrl)) {
    problems.push("llm client is real but neither SRE_LLM_BASE_URL nor SRE_LLM_TIER_S_URL/SRE_LLM_TIER_L_URL is set");
  }
  if (config.clients.toolhive === "real" && !config.toolhive.url && Object.keys(config.toolhive.endpoints).length === 0) {
    problems.push("toolhive client is real but neither SRE_TOOLHIVE_URL nor SRE_TOOLHIVE_ENDPOINTS_JSON is set");
  }
  if (config.clients.toolhive === "real" && config.toolCredential.strategy === "token-exchange" && !config.toolCredential.tokenEndpoint) {
    problems.push("toolhive client is real but SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT (RFC 8693 token exchange) is unset — see INTEGRATION BLOCKER");
  }
  if (config.clients.toolhive === "real" && config.toolCredential.strategy === "signed-jwt" && !config.toolCredential.privateKeyFile) {
    problems.push("signed-jwt ToolHive credentials require SRE_TOOL_CREDENTIAL_PRIVATE_KEY_FILE");
  }
  if (config.clients.toolhive === "real" && config.toolCredential.strategy === "workload-client" && !(config.toolCredential.tokenEndpoint && config.toolCredential.clientSecret)) {
    problems.push("workload-client ToolHive credentials require SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT and SRE_TOOL_CREDENTIAL_CLIENT_SECRET");
  }
  if (config.clients.postgres === "real" && !config.postgres.connectionString) {
    problems.push("postgres client is real but SRE_POSTGRES_URL is unset");
  }
  if (config.clients.agent === "real" && !config.agentTransport.workloadTokenFile && !(config.agentTransport.tokenEndpoint && config.agentTransport.clientId && config.agentTransport.clientSecret)) {
    problems.push("agent client is real but neither SRE_WORKLOAD_TOKEN_FILE nor the client-credentials settings are complete");
  }
  if (config.clients.delegation === "real" && !config.delegation.jwksUri && !config.delegation.publicKeyFile && !config.delegation.privateKeyPkcs8 && !config.delegation.privateKeyFile) {
    problems.push("delegation is real but no verifier or signing key is configured");
  }
  if (config.telemetry.exporter === "otlp" && !config.telemetry.otlpEndpoint) {
    problems.push("telemetry exporter is otlp but SRE_OTEL_ENDPOINT is unset");
  }
  if (problems.length > 0) {
    throw new ConfigValidationError(`unsafe configuration:\n- ${problems.join("\n- ")}`);
  }
  return config;
}

function parseJsonObject(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined;
  } catch {
    return undefined;
  }
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = prune(v);
    }
    return out;
  }
  return value;
}

/**
 * List the configuration files in a directory, SAFE ON A PROJECTED VOLUME.
 *
 * A Kubernetes ConfigMap volume is not a plain directory. The kubelet writes
 * each version into a timestamped directory and points a `..data` symlink at
 * it, so a listing contains `..data` and `..2026_01_01_12_00_00.123456789`
 * alongside the real files. An update REPLACES that symlink atomically rather
 * than rewriting files in place.
 *
 * Every entry beginning with `..` is therefore kubelet bookkeeping and must be
 * skipped. The extension filter alone happened to hide them — until the day a
 * bookkeeping name ends in `.yaml`, or a caller lists without filtering. This
 * makes the rule explicit rather than incidental.
 */
export function configFiles(directory: string, extensions: readonly string[] = [".yaml", ".yml"]): string[] {
  return readdirSync(directory)
    .filter((name) => !name.startsWith(".."))
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .sort();
}
