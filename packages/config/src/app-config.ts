import { z } from "zod";

/**
 * Application configuration — fail-closed per TDD §22.
 * Every external integration is config-selected mock|real; a "real" client
 * requires its endpoint, and production forbids mocks entirely.
 */

const clientMode = z.enum(["mock", "real"]);

export const appConfigSchema = z
  .object({
    env: z.enum(["local", "test", "production"]).default("local"),
    port: z.coerce.number().int().min(1).max(65_535).default(3000),
    agentsDir: z.string().min(1).default("agents"),
    agentConfigFile: z.string().min(1).default("agents/manager.yaml"),
    agentRegistryFile: z.string().min(1).default("agents/registry.yaml"),
    promptsDir: z.string().min(1).default("prompts"),
    approvedCatalogFile: z.string().min(1).default("policies/approved-tools.yaml"),
    requestDeadlineMs: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
    defaultEnvironment: z.string().min(1).default("prod"),
    clients: z
      .object({
        oidc: clientMode.default("mock"),
        llm: clientMode.default("mock"),
        toolhive: clientMode.default("mock"),
        rag: clientMode.default("mock"),
        postgres: clientMode.default("mock"),
        // "inprocess" runs specialists in the manager process (single-process local PoC)
        agent: z.enum(["mock", "real", "inprocess"]).default("mock"),
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
        tierSUrl: z.string().optional(),
        tierLUrl: z.string().optional(),
      })
      .strict(),
    toolhive: z.object({ url: z.string().optional() }).strict(),
    toolCredential: z.object({
      issuer: z.string().min(1).default("https://mock-toolhive-sts.sre.local"),
      audiencePrefix: z.string().min(1).default("sre-toolhive"),
      tokenEndpoint: z.string().optional(),
    }).strict(),
    rag: z.object({ url: z.string().optional() }).strict(),
    postgres: z.object({ connectionString: z.string().optional() }).strict(),
    agentTransport: z.object({ workloadTokenFile: z.string().optional() }).strict(),
    delegation: z.object({
      issuer: z.string().min(1).default("https://mock-manager.sre.local"),
      mockSecret: z.string().min(32).default("local-only-delegation-secret-change-me-0001"),
      jwksUri: z.string().optional(),
      privateKeyPkcs8: z.string().optional(),
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
      rag: env.SRE_CLIENT_RAG,
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
    llm: { tierSUrl: env.SRE_LLM_TIER_S_URL, tierLUrl: env.SRE_LLM_TIER_L_URL },
    toolhive: { url: env.SRE_TOOLHIVE_URL },
    toolCredential: { issuer: env.SRE_TOOL_CREDENTIAL_ISSUER, audiencePrefix: env.SRE_TOOL_CREDENTIAL_AUDIENCE_PREFIX, tokenEndpoint: env.SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT },
    rag: { url: env.SRE_RAG_URL },
    postgres: { connectionString: env.SRE_POSTGRES_URL },
    agentTransport: { workloadTokenFile: env.SRE_WORKLOAD_TOKEN_FILE },
    delegation: {
      issuer: env.SRE_DELEGATION_ISSUER,
      mockSecret: env.SRE_DELEGATION_MOCK_SECRET,
      jwksUri: env.SRE_DELEGATION_JWKS_URI,
      privateKeyPkcs8: env.SRE_DELEGATION_PRIVATE_KEY_PKCS8,
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
  if (config.env === "production") {
    for (const [name, mode] of Object.entries(config.clients)) {
      if (mode === "mock") problems.push(`client "${name}" is mock in production`);
    }
    // in-process specialist execution is a local-dev convenience only
    if (config.clients.agent === "inprocess") problems.push('client "agent" is inprocess in production (use real distributed agents)');
  }
  if (config.clients.oidc === "real" && !config.oidc.jwksUri) {
    problems.push("oidc client is real but SRE_OIDC_JWKS_URI is unset");
  }
  if (config.clients.agent === "real" && !config.internalOidc.jwksUri) {
    problems.push("agent client is real but SRE_INTERNAL_OIDC_JWKS_URI is unset");
  }
  if (config.clients.llm === "real" && (!config.llm.tierSUrl || !config.llm.tierLUrl)) {
    problems.push("llm client is real but SRE_LLM_TIER_S_URL or SRE_LLM_TIER_L_URL is unset");
  }
  if (config.clients.toolhive === "real" && !config.toolhive.url) {
    problems.push("toolhive client is real but SRE_TOOLHIVE_URL is unset");
  }
  if (config.clients.toolhive === "real" && !config.toolCredential.tokenEndpoint) {
    problems.push("toolhive client is real but SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT (RFC 8693 token exchange) is unset — see INTEGRATION BLOCKER");
  }
  if (config.clients.rag === "real" && !config.rag.url) {
    problems.push("rag client is real but SRE_RAG_URL is unset");
  }
  if (config.clients.postgres === "real" && !config.postgres.connectionString) {
    problems.push("postgres client is real but SRE_POSTGRES_URL is unset");
  }
  if (config.clients.agent === "real" && !config.agentTransport.workloadTokenFile) {
    problems.push("agent client is real but SRE_WORKLOAD_TOKEN_FILE is unset");
  }
  if (config.clients.delegation === "real" && !config.delegation.jwksUri && !config.delegation.privateKeyPkcs8) {
    problems.push("delegation is real but neither SRE_DELEGATION_JWKS_URI nor SRE_DELEGATION_PRIVATE_KEY_PKCS8 is set");
  }
  if (config.telemetry.exporter === "otlp" && !config.telemetry.otlpEndpoint) {
    problems.push("telemetry exporter is otlp but SRE_OTEL_ENDPOINT is unset");
  }
  if (problems.length > 0) {
    throw new ConfigValidationError(`unsafe configuration:\n- ${problems.join("\n- ")}`);
  }
  return config;
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
