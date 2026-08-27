import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  HttpAgentClient,
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
  PrivateKeyDelegatedIdentityIssuer,
  RealOidcClient,
  subjectHash,
  type DelegatedIdentityIssuer,
  type DelegatedIdentityVerifier,
  type OidcClient,
} from "@sre/auth";
import {
  loadAgentInstance,
  loadAppConfig,
  loadApprovedCatalog,
  type AppConfig,
  type ApprovedCatalog,
  type ManagerAgentConfig,
  type SpecialistAgentConfig,
} from "@sre/config";
import { redactText } from "@sre/evidence";
import { MockModelClient, RealOpenAiCompatibleClient, type ModelClient } from "@sre/llm";
import { MockToolHiveClient, RealToolHiveClient, type ToolHiveClient } from "@sre/mcp";
import { MockRagClient, RealRagClient, type RagClient } from "@sre/rag";
import { classifyIntent } from "@sre/routing";
import { executeRequest, runSpecialistInstance, type ExecutionContext } from "@sre/runtime";
import { incrementMetric, renderMetrics, withSpan } from "@sre/telemetry";
import { z } from "zod";
import { oidcAuthenticationMiddleware } from "./middleware/oidc.ts";

const bodySchema = z.object({ question: z.string().min(1).max(8_000), environment: z.string().min(1).optional(), sessionId: z.string().min(1).optional() }).strict();

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
}

export interface SpecialistDependencies extends CommonDependencies {
  mode: "specialist";
  agent: SpecialistAgentConfig;
  catalog: ApprovedCatalog;
  authorization: AuthorizationService;
  toolhive: ToolHiveClient;
  rag: RagClient;
  identityVerifier: DelegatedIdentityVerifier;
  workloadOidc?: OidcClient;
}

export type ApiDependencies = ManagerDependencies | SpecialistDependencies;

export function buildDependencies(env: Record<string, string | undefined> = process.env): ApiDependencies {
  const config = loadAppConfig(env);
  const agent = loadAgentInstance({ configFile: config.agentConfigFile, approvedCatalogFile: config.approvedCatalogFile });
  const model = config.clients.llm === "mock" ? new MockModelClient() : new RealOpenAiCompatibleClient(config.llm.tierSUrl as string);
  const mockDelegation = new MockDelegationAuthority({ issuer: config.delegation.issuer, secret: config.delegation.mockSecret });

  if (agent.spec.type === "manager") {
    const managerAgent = agent as ManagerAgentConfig;
    const registry = loadAgentServiceRegistry(config.agentRegistryFile);
    for (const agentId of managerAgent.spec.agents.allowed) {
      if (registry.resolve(agentId) === undefined) throw new Error(`manager allows unregistered agent ${agentId}`);
    }
    const agentClient = config.clients.agent === "mock"
      ? new MockAgentClient()
      : new HttpAgentClient(registry, new ProjectedWorkloadTokenProvider(config.agentTransport.workloadTokenFile as string));
    if (config.clients.delegation === "real" && config.delegation.privateKeyPkcs8 === undefined) throw new Error("manager mode requires SRE_DELEGATION_PRIVATE_KEY_PKCS8");
    const identityIssuer = config.clients.delegation === "mock" ? mockDelegation : new PrivateKeyDelegatedIdentityIssuer({ issuer: config.delegation.issuer, privateKeyPkcs8: config.delegation.privateKeyPkcs8 as string });
    return {
      mode: "manager",
      config,
      agent: managerAgent,
      registry,
      agentClient,
      identityIssuer,
      model,
      synthesisModel: config.clients.llm === "mock" ? model : new RealOpenAiCompatibleClient(config.llm.tierLUrl as string),
      oidc: config.clients.oidc === "mock" ? new MockOidcClient(config.oidc) : new RealOidcClient(config.oidc),
    };
  }

  const specialistAgent = agent as SpecialistAgentConfig;
  const catalog = loadApprovedCatalog(config.approvedCatalogFile);
  if (config.clients.delegation === "real" && config.delegation.jwksUri === undefined) throw new Error("specialist mode requires SRE_DELEGATION_JWKS_URI");
  const identityVerifier = config.clients.delegation === "mock" ? mockDelegation : new JwksDelegatedIdentityVerifier({ issuer: config.delegation.issuer, jwksUri: config.delegation.jwksUri as string });
  return {
    mode: "specialist",
    config,
    agent: specialistAgent,
    catalog,
    model,
    authorization: new AuthorizationService(),
    toolhive: config.clients.toolhive === "mock" ? new MockToolHiveClient() : new RealToolHiveClient(config.toolhive.url as string),
    rag: config.clients.rag === "mock" ? new MockRagClient() : new RealRagClient(config.rag.url as string),
    identityVerifier,
    ...(config.clients.agent === "real" ? { workloadOidc: new RealOidcClient(config.internalOidc) } : {}),
  };
}

export function createApp(deps: ApiDependencies): FastifyInstance {
  const bodyLimit = deps.mode === "specialist" ? MAX_AGENT_REQUEST_BYTES : 64 * 1024;
  const app = Fastify({ logger: false, bodyLimit, genReqId: () => randomUUID() });
  app.get("/health/live", async () => ({ status: "ok", mode: deps.mode, agentId: deps.agent.name }));
  app.get("/health/ready", async () => ({ status: "ready", mode: deps.mode, agentId: deps.agent.name, configRevision: "0.2.0" }));
  app.get("/metrics", async (_request, reply) => reply.type("text/plain; version=0.0.4").send(renderMetrics()));

  if (deps.mode === "manager") registerManagerRoutes(app, deps);
  else registerSpecialistRoutes(app, deps);
  return app;
}

function registerManagerRoutes(app: FastifyInstance, deps: ManagerDependencies): void {
  if (deps.config.env === "local" && deps.oidc instanceof MockOidcClient) {
    const mockOidc = deps.oidc;
    app.post("/dev/token/:user", async (request, reply) => {
      const parsed = z.object({ user: z.enum(["alice", "bob"]) }).safeParse(request.params);
      return parsed.success ? { token: await mockOidc.issueTestToken(parsed.data.user) } : reply.code(404).send({ code: "AUTHN_FAILED", message: "Unknown mock user" });
    });
  }
  app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", oidcAuthenticationMiddleware(deps.oidc));
    protectedApp.post("/v1/query", async (request, reply) => {
      const requestId = request.id;
      const bodyResult = bodySchema.safeParse(request.body);
      if (!bodyResult.success) return reply.code(400).send({ requestId, code: "MCP_INVALID_CALL", message: "Invalid request body" });
      try {
        const authenticated = request.identity;
        if (authenticated === undefined) return reply;
        const identity = { ...authenticated, ...(bodyResult.data.sessionId ? { sessionId: bodyResult.data.sessionId } : {}) };
        incrementMetric("sre_requests_total");
        const response = await withSpan("sre.query", { "request.id": requestId, "user.subject_hash": subjectHash(identity.subject), environment: bodyResult.data.environment ?? deps.config.defaultEnvironment }, () => executeRequest(
          { question: bodyResult.data.question, environment: bodyResult.data.environment, identity },
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
        return reply.code(response.error?.code === "AUTHZ_DENIED" ? 403 : response.error?.code === "ROUTE_INVALID" ? 422 : 200).send(response);
      } catch {
        return reply.code(401).send({ requestId, code: "AUTHN_FAILED", message: "Authentication failed" });
      }
    });
  });
}

function registerSpecialistRoutes(app: FastifyInstance, deps: SpecialistDependencies): void {
  app.post("/internal/v1/execute", async (request, reply) => {
    const parsed = agentExecutionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "AGENT_INVALID_RESPONSE", message: "Invalid agent request" });
    try {
      assertSerializedLimit(parsed.data, MAX_AGENT_REQUEST_BYTES, "agent request");
      await verifyWorkloadIdentity(deps, request.headers.authorization, parsed.data.requestId);
      const identity = await deps.identityVerifier.verify(parsed.data.identityContext, `sre-agent:${deps.agent.name}`, parsed.data.requestId);
      const deadline = Date.parse(parsed.data.deadline);
      if (deadline <= Date.now()) return reply.code(504).send({ code: "AGENT_TIMEOUT", message: "Request deadline expired" });
      const abort = new AbortController();
      request.raw.once("aborted", () => abort.abort());
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
      };
      const response = await runSpecialistInstance(deps.agent, deps.catalog, executionContext, {
        authorization: deps.authorization,
        model: deps.model,
        toolhive: deps.toolhive,
        rag: deps.rag,
      }, parsed.data.handoff);
      assertSerializedLimit(response, MAX_AGENT_RESPONSE_BYTES, "agent response");
      return reply.send(response);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "AGENT_UNAUTHORIZED";
      const status = code === "AGENT_RESPONSE_TOO_LARGE" ? 502 : code === "AGENT_TIMEOUT" ? 504 : 403;
      return reply.code(status).send({ code, message: "Internal agent request rejected" });
    }
  });
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
