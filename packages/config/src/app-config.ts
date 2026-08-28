import { z } from "zod";

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
    agentsDir: z.string().min(1).default("agents"),
    agentConfigFile: z.string().min(1).default("agents/manager.yaml"),
    agentRegistryFile: z.string().min(1).default("agents/registry.yaml"),
    promptsDir: z.string().min(1).default("prompts"),
    approvedCatalogFile: z.string().min(1).default("policies/approved-tools.yaml"),
    requestDeadlineMs: z.coerce.number().int().min(1_000).max(600_000).default(45_000),
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
      })
      .strict(),
    internalOidc: z.object({
      issuer: z.string().min(1).default("https://mock-workload-idp.sre.local"),
      audience: z.string().min(1).default("sre-agent-runtime"),
      jwksUri: z.string().optional(),
    }).strict(),
    llm: z
      .object({
        // unified OpenAI-compatible endpoint (Groq / on-prem vLLM); preferred over tier URLs
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        // logical profile → served model id
        managerModel: z.string().optional(),
        toolCallerModel: z.string().optional(),
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
    toolCredential: z.object({
      issuer: z.string().min(1).default("https://mock-toolhive-sts.sre.local"),
      audiencePrefix: z.string().min(1).default("sre-toolhive"),
      tokenEndpoint: z.string().optional(),
      // "workload-client": the Agent authenticates as its own Keycloak
      // service-account client and requests one MCP audience scope per call
      strategy: z.enum(["token-exchange", "signed-jwt", "workload-client"]).default("token-exchange"),
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
    agentRegistryFile: env.SRE_AGENT_REGISTRY,
    promptsDir: env.SRE_PROMPTS_DIR,
    approvedCatalogFile: env.SRE_APPROVED_CATALOG,
    requestDeadlineMs: env.SRE_REQUEST_DEADLINE_MS,
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
    },
    internalOidc: {
      issuer: env.SRE_INTERNAL_OIDC_ISSUER,
      audience: env.SRE_INTERNAL_OIDC_AUDIENCE,
      jwksUri: env.SRE_INTERNAL_OIDC_JWKS_URI,
    },
    llm: {
      baseUrl: env.SRE_LLM_BASE_URL,
      apiKey: env.SRE_LLM_API_KEY,
      managerModel: env.SRE_MODEL_MANAGER,
      toolCallerModel: env.SRE_MODEL_TOOL_CALLER,
      synthesisModel: env.SRE_MODEL_SYNTHESIS,
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
    toolCredential: {
      issuer: env.SRE_TOOL_CREDENTIAL_ISSUER,
      audiencePrefix: env.SRE_TOOL_CREDENTIAL_AUDIENCE_PREFIX,
      tokenEndpoint: env.SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT,
      strategy: env.SRE_TOOL_CREDENTIAL_STRATEGY,
      privateKeyFile: env.SRE_TOOL_CREDENTIAL_PRIVATE_KEY_FILE,
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
