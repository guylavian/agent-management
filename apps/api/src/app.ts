import { createPublicKey, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { DispatchFunc, InjectOptions, Response as InjectResponse } from "light-my-request";
import {
  HttpAgentClient,
  ClientCredentialsWorkloadTokenProvider,
  MockAgentClient,
  MockWorkloadTokenProvider,
  ProjectedWorkloadTokenProvider,
  type AgentClient,
} from "@sre/agent-client";
import {
  MAX_AGENT_REQUEST_BYTES,
  MAX_AGENT_RESPONSE_BYTES,
  agentExecutionRequestSchema,
  assertSerializedLimit,
} from "@sre/agent-protocol";
import { loadAgentServiceRegistry, type AgentRegistry as AgentServiceRegistry } from "@sre/agent-registry";
import {
  AuthorizationService,
  JwksDelegatedIdentityVerifier,
  MockDelegationAuthority,
  MockOidcClient,
  MockToolCredentialAuthority,
  PrivateKeyDelegatedIdentityIssuer,
  PrivateKeyToolCredentialExchanger,
  PublicKeyDelegatedIdentityVerifier,
  RealOidcClient,
  RealTokenExchangeCredentialExchanger,
  subjectHash,
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
  type AppConfig,
  type ApprovedCatalog,
  type ManagerAgentConfig,
  type SpecialistAgentConfig,
} from "@sre/config";
import { redactText } from "@sre/evidence";
import { MockModelClient, RealOpenAiCompatibleClient, type ModelClient } from "@sre/llm";
import { DirectMcpClient, mcpEndpointsFromEnv, MockToolHiveClient, RealToolHiveClient, type ToolHiveClient } from "@sre/mcp";
import { classifyIntent, extractEntities } from "@sre/routing";
import { executeRequest, InProcessAgentClient, runSpecialistInstance, type ExecutionContext } from "@sre/runtime";
import { DisabledSessionStore, MockSessionStore, PostgresSessionStore, type BoundedSessionContext, type SessionStore } from "@sre/session";
import { incrementMetric, observeDuration, observeInflight, renderMetrics, withExtractedContext, withSpan } from "@sre/telemetry";
import { z } from "zod";
import { oidcAuthenticationMiddleware } from "./middleware/oidc.ts";

const bodySchema = z.object({ question: z.string().min(1).max(8_000), environment: z.string().min(1).optional(), sessionId: z.string().min(1).optional() }).strict();

/** Express app augmented with a socketless request injector for tests/dev harness. */
export type TestableApp = Express & {
  inject(options: InjectOptions | string): Promise<InjectResponse>;
  close(): Promise<void>;
};

interface CommonDependencies {
  config: AppConfig;
  model: ModelClient;
}

export interface ManagerDependencies extends CommonDependencies {
  mode: "manager";
  agent: ManagerAgentConfig;
  oidc: OidcClient;
  synthesisModel: ModelClient;
  registry: AgentServiceRegistry;
  agentClient: AgentClient;
  identityIssuer: DelegatedIdentityIssuer;
  sessionStore: SessionStore;
  delegationPublicJwk?: Record<string, unknown>;
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
  const agent = loadAgentInstance({ configFile: config.agentConfigFile, approvedCatalogFile: config.approvedCatalogFile });
  const model = config.clients.llm === "mock" ? new MockModelClient() : buildRealModel(config);
  const mockDelegation = config.clients.delegation === "mock"
    ? new MockDelegationAuthority({ issuer: config.delegation.issuer, secret: config.delegation.mockSecret })
    : undefined;

  if (agent.spec.type === "manager") {
    const managerAgent = agent as ManagerAgentConfig;
    const registry = loadAgentServiceRegistry(config.agentRegistryFile);
    for (const agentId of managerAgent.spec.agents.allowed) {
      if (registry.resolve(agentId) === undefined) throw new Error(`manager allows unregistered agent ${agentId}`);
    }
    let agentClient: AgentClient;
    if (config.clients.agent === "inprocess") {
      // single-process local PoC: the manager executes specialists in-process.
      // Uses the same delegation authority so the per-agent identity JWT verifies.
      const fullRegistry = loadAgentRegistry({ agentsDir: config.agentsDir, promptsDir: config.promptsDir, approvedCatalogFile: config.approvedCatalogFile });
      agentClient = new InProcessAgentClient(
        fullRegistry,
        {
          authorization: new AuthorizationService(fullRegistry),
          model,
          toolhive: buildToolhive(config, env),
        },
        mockDelegation as MockDelegationAuthority,
      );
    } else if (config.clients.agent === "mock") {
      agentClient = new MockAgentClient();
    } else if (config.clients.agent === "http-local") {
      // distributed local PoC: HTTP fan-out with a fixed mock workload token
      agentClient = new HttpAgentClient(registry, new MockWorkloadTokenProvider());
    } else {
      const tokenProvider = config.agentTransport.workloadTokenFile
        ? new ProjectedWorkloadTokenProvider(config.agentTransport.workloadTokenFile)
        : new ClientCredentialsWorkloadTokenProvider({
          tokenEndpoint: config.agentTransport.tokenEndpoint as string,
          clientId: config.agentTransport.clientId as string,
          clientSecret: config.agentTransport.clientSecret as string,
        });
      agentClient = new HttpAgentClient(registry, tokenProvider);
    }
    const delegationPrivateKey = readConfiguredSecret(config.delegation.privateKeyPkcs8, config.delegation.privateKeyFile);
    if (config.clients.delegation === "real" && delegationPrivateKey === undefined) throw new Error("manager mode requires a delegation private key");
    const identityIssuer = config.clients.delegation === "mock" ? mockDelegation as MockDelegationAuthority : new PrivateKeyDelegatedIdentityIssuer({ issuer: config.delegation.issuer, privateKeyPkcs8: delegationPrivateKey as string });
    const delegationPublicKey = config.delegation.publicKeyFile ? readFileSync(config.delegation.publicKeyFile, "utf8") : undefined;
    return {
      mode: "manager",
      config,
      agent: managerAgent,
      registry,
      agentClient,
      identityIssuer,
      model,
      synthesisModel: config.clients.llm === "mock" ? model : config.llm.baseUrl ? model : new RealOpenAiCompatibleClient(config.llm.tierLUrl as string, { modelMap: buildModelMap(config, config.llm.tierLModel ?? config.llm.model), ...(config.llm.systemSuffix ? { systemSuffix: config.llm.systemSuffix } : {}) }),
      oidc: config.clients.oidc === "mock" ? new MockOidcClient(config.oidc) : new RealOidcClient(config.oidc),
      sessionStore: config.clients.postgres === "mock" ? new MockSessionStore() : config.clients.postgres === "disabled" ? new DisabledSessionStore() : new PostgresSessionStore(config.postgres.connectionString as string),
      ...(delegationPublicKey ? { delegationPublicJwk: { ...createPublicKey(delegationPublicKey).export({ format: "jwk" }), kid: "sre-real-poc", use: "sig", alg: "RS256" } } : {}),
    };
  }

  const specialistAgent = agent as SpecialistAgentConfig;
  const catalog = loadApprovedCatalog(config.approvedCatalogFile);
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

export function createApp(deps: ApiDependencies): TestableApp {
  const bodyLimit = deps.mode === "specialist" ? MAX_AGENT_REQUEST_BYTES : 64 * 1024;
  const app = express();
  app.disable("x-powered-by");
  app.use((request: Request, _response: Response, next: NextFunction) => { request.requestId = randomUUID(); next(); });
  app.use(express.json({ limit: bodyLimit }));

  app.get("/health/live", (_request, response) => { response.json({ status: "ok", mode: deps.mode, agentId: deps.agent.name }); });
  app.get("/health/ready", (_request, response) => {
    response.json({ status: "ready", mode: deps.mode, agentId: deps.agent.name, configRevision: "real-poc-1", environmentMode: deps.config.env, dependencyModes: deps.config.clients });
  });
  app.get("/metrics", (_request, response) => { response.type("text/plain; version=0.0.4").send(renderMetrics()); });
  if (deps.mode === "manager" && deps.delegationPublicJwk) {
    app.get("/internal/.well-known/jwks.json", (_request, response) => { response.json({ keys: [deps.delegationPublicJwk] }); });
  }

  if (deps.mode === "manager") registerManagerRoutes(app, deps);
  else registerSpecialistRoutes(app, deps);

  // body-parse errors (malformed JSON / oversized) mapped to the per-mode shape
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const tooLarge = typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large";
    if (deps.mode === "specialist") {
      response.status(tooLarge ? 413 : 400).json({ code: tooLarge ? "AGENT_REQUEST_TOO_LARGE" : "AGENT_INVALID_RESPONSE", message: "Invalid agent request" });
      return;
    }
    response.status(tooLarge ? 413 : 400).json({ requestId: request.requestId, code: "MCP_INVALID_CALL", message: "Invalid request body" });
  });

  return attachInject(app);
}

function attachInject(app: Express): TestableApp {
  const testable = app as TestableApp;
  // light-my-request is a dev/test-only dependency; load it lazily so the
  // production image (npm ci --omit=dev) never needs it.
  testable.inject = async (options) => {
    const { inject } = await import("light-my-request");
    return inject(app as unknown as DispatchFunc, typeof options === "string" ? { url: options } : options);
  };
  testable.close = async () => {};
  return testable;
}

function registerManagerRoutes(app: Express, deps: ManagerDependencies): void {
  if (deps.config.env === "local" && deps.oidc instanceof MockOidcClient) {
    const mockOidc = deps.oidc;
    app.post("/dev/token/:user", (request, response) => {
      const parsed = z.object({ user: z.enum(["alice", "bob"]) }).safeParse(request.params);
      if (!parsed.success) { response.status(404).json({ code: "AUTHN_FAILED", message: "Unknown mock user" }); return; }
      void mockOidc.issueTestToken(parsed.data.user).then((token) => response.json({ token }));
    });
  }
  app.post("/v1/query", oidcAuthenticationMiddleware(deps.oidc), async (request, response) => {
    const requestId = request.requestId;
    const bodyResult = bodySchema.safeParse(request.body);
    if (!bodyResult.success) { response.status(400).json({ requestId, code: "MCP_INVALID_CALL", message: "Invalid request body" }); return; }
    const authenticated = request.identity;
    if (authenticated === undefined) { response.status(401).json({ requestId, code: "AUTHN_FAILED", message: "Authentication failed" }); return; }
    observeInflight(1);
    const endTimer = startTimer("sre_request_duration_seconds");
    try {
      const identity = { ...authenticated, ...(bodyResult.data.sessionId ? { sessionId: bodyResult.data.sessionId } : {}) };
      incrementMetric("sre_requests_total");
      // bounded follow-up context (SDD §14): entities + previous request ID only, keyed by user + session
      const session = bodyResult.data.sessionId === undefined ? undefined : await deps.sessionStore.get(authenticated.subject, bodyResult.data.sessionId);
      const resolvedEntities = session === undefined || session.entities.length === 0 ? undefined : Object.fromEntries(session.entities.map((entity) => [entity.alias, entity.canonical]));
      const conversation = resolvedEntities === undefined ? undefined : { resolvedEntities, ...(session?.previousRequestId ? { previousRequestId: session.previousRequestId } : {}) };
      const result = await withSpan("sre.query", { "request.id": requestId, "user.subject_hash": subjectHash(identity.subject), environment: bodyResult.data.environment ?? deps.config.defaultEnvironment }, () => executeRequest(
        { question: bodyResult.data.question, environment: bodyResult.data.environment, identity, ...(conversation ? { conversation } : {}) },
        {
          manager: deps.agent,
          registry: deps.registry,
          agentClient: deps.agentClient,
          identityIssuer: deps.identityIssuer,
          model: deps.model,
          synthesisModel: deps.synthesisModel,
          requestDeadlineMs: deps.config.requestDeadlineMs,
          defaultEnvironment: deps.config.defaultEnvironment,
        },
      ));
      if (bodyResult.data.sessionId !== undefined) {
        await deps.sessionStore.put(mergeSessionEntities(session, authenticated.subject, bodyResult.data.sessionId, bodyResult.data.question, requestId));
      }
      response.status(result.error?.code === "AUTHZ_DENIED" ? 403 : result.error?.code === "ROUTE_INVALID" ? 422 : 200).json(result);
    } catch {
      response.status(500).json({ requestId, code: "REQUEST_TIMEOUT", message: "Request processing failed" });
    } finally {
      endTimer();
      observeInflight(-1);
    }
  });
}

function registerSpecialistRoutes(app: Express, deps: SpecialistDependencies): void {
  app.post("/internal/v1/execute", async (request, response) => {
    const parsed = agentExecutionRequestSchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ code: "AGENT_INVALID_RESPONSE", message: "Invalid agent request" }); return; }
    // continue the Manager's W3C trace context so one distributed trace covers the whole request
    await withExtractedContext(request.headers, async () => {
      // phase 1 — admission: size, workload identity, delegated user identity, deadline.
      // Failures here are authorization/timeout signals, never execution failures.
      let identity;
      try {
        assertSerializedLimit(parsed.data, MAX_AGENT_REQUEST_BYTES, "agent request");
        await verifyWorkloadIdentity(deps, request.headers.authorization, parsed.data.requestId);
        identity = await deps.identityVerifier.verify(parsed.data.identityContext, `sre-agent:${deps.agent.name}`, parsed.data.requestId);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "AGENT_UNAUTHORIZED";
        const status = code === "AGENT_REQUEST_TOO_LARGE" ? 413 : code === "AGENT_TIMEOUT" ? 504 : 403;
        response.status(status).json({ code: status === 403 ? "AGENT_UNAUTHORIZED" : code, message: "Internal agent request rejected" });
        return;
      }
      const deadline = Date.parse(parsed.data.deadline);
      if (deadline <= Date.now()) { response.status(504).json({ code: "AGENT_TIMEOUT", message: "Request deadline expired" }); return; }
      // phase 2 — execution: internal failures are reported as such, not as authorization denials
      const endTimer = startTimer("sre_agent_duration_seconds");
      try {
        const abort = new AbortController();
        request.on("close", () => { if (!response.writableEnded) abort.abort(); });
        const safeQuestion = redactText(parsed.data.question).value;
        const executionContext: ExecutionContext = {
          request: {
            question: safeQuestion,
            environment: parsed.data.environment,
            identity,
            ...(parsed.data.conversationContext ? { conversation: parsed.data.conversationContext } : {}),
          },
          identity,
          environment: parsed.data.environment,
          intent: classifyIntent(safeQuestion),
          requestId: parsed.data.requestId,
          deadline,
          signal: abort.signal,
          ...(parsed.data.task ? { task: parsed.data.task } : {}),
        };
        const result = await runSpecialistInstance(deps.agent, deps.catalog, executionContext, {
          authorization: deps.authorization,
          model: deps.model,
          toolhive: deps.toolhive,
          credentialExchanger: deps.credentialExchanger,
        }, parsed.data.handoff);
        assertSerializedLimit(result, MAX_AGENT_RESPONSE_BYTES, "agent response");
        response.status(200).json(result);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "AGENT_EXECUTION_FAILED";
        if (code === "AGENT_RESPONSE_TOO_LARGE") response.status(502).json({ code, message: "Internal agent response rejected" });
        else if (code === "AGENT_TIMEOUT" || code === "REQUEST_TIMEOUT") response.status(504).json({ code: "AGENT_TIMEOUT", message: "Internal agent request timed out" });
        else response.status(500).json({ code: "AGENT_EXECUTION_FAILED", message: "Internal agent execution failed" });
      } finally {
        endTimer();
      }
    });
  });
}

function startTimer(metric: string): () => void {
  const startedAt = performanceNow();
  return () => observeDuration(metric, (performanceNow() - startedAt) / 1000);
}

function performanceNow(): number { return Number(process.hrtime.bigint() / 1_000_000n); }


function mergeSessionEntities(session: BoundedSessionContext | undefined, subject: string, sessionId: string, question: string, requestId: string): BoundedSessionContext {
  const merged = new Map((session?.entities ?? []).map((entity) => [entity.alias, entity]));
  for (const [type, value] of Object.entries(extractEntities(question))) merged.set(value, { alias: value, canonical: value, type });
  return {
    sessionId,
    subject,
    entities: [...merged.values()].slice(0, 32),
    previousRequestId: requestId,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

async function verifyWorkloadIdentity(deps: SpecialistDependencies, authorization: string | undefined, requestId: string): Promise<void> {
  const match = authorization?.match(/^Bearer (.+)$/u);
  if (match?.[1] === undefined) throw new Error("missing workload identity");
  if (deps.workloadOidc === undefined) {
    if (match[1] !== "mock-manager-workload-token-for-local-tests") throw new Error("invalid workload identity");
    return;
  }
  await deps.workloadOidc.verify(match[1], requestId);
}
