/**
 * HTTP Specialist transport: the distributed path.
 *
 * Constructed only by the composition root. It resolves the specialist's
 * endpoint from the effective agent catalog, presents the Manager's own
 * workload identity, propagates trace context and enforces the protocol size
 * limits on both directions before anything is parsed.
 */
import { context, propagation } from "@opentelemetry/api";
import { readFile } from "node:fs/promises";
import { MOCK_WORKLOAD_TOKEN } from "@sre/auth";
import {
  AGENT_EXECUTION_PATH,
  AgentTransportError,
  MAX_AGENT_REQUEST_BYTES,
  MAX_AGENT_RESPONSE_BYTES,
  agentExecutionResponseSchema,
  assertSerializedLimit,
  type AgentExecutionRequest,
  type AgentExecutionResponse,
  type SpecialistTransport,
} from "@sre/agent-protocol";

export { AgentTransportError, type AgentTransportErrorCode } from "@sre/agent-protocol";
import type { AgentCatalog } from "@sre/config";


export interface WorkloadTokenProvider {
  getToken(audience: string): Promise<string>;
}

/** Reads a short-lived projected ServiceAccount/OIDC token for every call so rotation is observed. */
export class ProjectedWorkloadTokenProvider implements WorkloadTokenProvider {
  readonly tokenFile: string;
  constructor(tokenFile: string) { this.tokenFile = tokenFile; }
  async getToken(_audience: string): Promise<string> {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (token.length < 32) throw new AgentTransportError("AGENT_UNAUTHORIZED", "Workload identity token is unavailable", false);
    return token;
  }
}

/** Fetches a short-lived workload token from the real local Keycloak client-credentials flow. */
export class ClientCredentialsWorkloadTokenProvider implements WorkloadTokenProvider {
  readonly #tokenEndpoint: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #cache = new Map<string, { token: string; expiresAtMs: number }>();

  constructor(settings: { tokenEndpoint: string; clientId: string; clientSecret: string }, fetchImplementation: typeof fetch = fetch) {
    this.#tokenEndpoint = settings.tokenEndpoint;
    this.#clientId = settings.clientId;
    this.#clientSecret = settings.clientSecret;
    this.#fetch = fetchImplementation;
  }

  async getToken(audience: string): Promise<string> {
    const cached = this.#cache.get(audience);
    // ponytail: 5s skew guard matching workload-credential.ts style
    if (cached !== undefined && cached.expiresAtMs - 5_000 > Date.now()) {
      return cached.token;
    }

    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.#clientId, client_secret: this.#clientSecret });
    const response = await this.#fetch(this.#tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new AgentTransportError("AGENT_UNAUTHORIZED", "Workload identity token is unavailable", false);
    const payload = await response.json() as { access_token?: string; expires_in?: number };
    if (payload.access_token === undefined || payload.access_token.length < 32) throw new AgentTransportError("AGENT_UNAUTHORIZED", "Workload identity token is unavailable", false);
    
    const lifetimeMs = Math.min((payload.expires_in ?? 60) * 1000, 300_000);
    const expiresAtMs = Date.now() + lifetimeMs;
    this.#cache.set(audience, { token: payload.access_token, expiresAtMs });
    return payload.access_token;
  }
}

export class MockWorkloadTokenProvider implements WorkloadTokenProvider {
  async getToken(_audience: string): Promise<string> { return MOCK_WORKLOAD_TOKEN; }
}

export class HttpSpecialistTransport implements SpecialistTransport {
  readonly mode = "real" as const;
  readonly registry: AgentCatalog;
  readonly tokens: WorkloadTokenProvider;
  readonly fetchImplementation: typeof fetch;
  constructor(
    registry: AgentCatalog,
    tokens: WorkloadTokenProvider,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.registry = registry;
    this.tokens = tokens;
    this.fetchImplementation = fetchImplementation;
  }

  async execute(agentId: string, request: AgentExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResponse> {
    const entry = this.registry.resolve(agentId);
    if (entry === undefined || !entry.enabled) throw new AgentTransportError("AGENT_UNAVAILABLE", "Agent service is unavailable", false);
    assertSerializedLimit(request, MAX_AGENT_REQUEST_BYTES, "agent request");
    const deadlineMs = Date.parse(request.deadline) - Date.now();
    if (deadlineMs <= 0) throw new AgentTransportError("AGENT_TIMEOUT", "Agent request deadline expired", false);
    const timeoutSignal = AbortSignal.timeout(deadlineMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${await this.tokens.getToken(`sre-agent:${agentId}`)}`,
          "content-type": "application/json",
          "x-request-id": request.requestId,
        };
        propagation.inject(context.active(), headers);
        const response = await this.fetchImplementation(new URL(AGENT_EXECUTION_PATH, `${entry.endpoint}/`), {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: combined,
        });
        if (response.status === 401 || response.status === 403) throw new AgentTransportError("AGENT_UNAUTHORIZED", "Agent service denied the request", false);
        if (response.status === 500) throw new AgentTransportError("AGENT_EXECUTION_FAILED", "Agent service failed internally", false);
        if ([502, 503, 504].includes(response.status)) {
          // a specialist's own 502 carries AGENT_RESPONSE_TOO_LARGE — terminal, not a transport blip
          const body = await response.text().catch(() => "");
          if (body.includes("AGENT_RESPONSE_TOO_LARGE")) throw new AgentTransportError("AGENT_RESPONSE_TOO_LARGE", "Agent response exceeds the size limit", false);
          if (attempt === 0) continue;
          throw new AgentTransportError("AGENT_UNAVAILABLE", "Agent service is unavailable", true);
        }
        if (!response.ok) throw new AgentTransportError("AGENT_INVALID_RESPONSE", "Agent service returned an invalid status", false);
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > MAX_AGENT_RESPONSE_BYTES) throw new AgentTransportError("AGENT_RESPONSE_TOO_LARGE", "Agent response exceeds the size limit", false);
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_AGENT_RESPONSE_BYTES) throw new AgentTransportError("AGENT_RESPONSE_TOO_LARGE", "Agent response exceeds the size limit", false);
        return agentExecutionResponseSchema.parse(JSON.parse(text));
      } catch (error) {
        if (error instanceof AgentTransportError) throw error;
        lastError = error;
        if (combined.aborted) throw new AgentTransportError("AGENT_TIMEOUT", "Agent service timed out", false);
        if (attempt === 0) continue;
      }
    }
    void lastError;
    throw new AgentTransportError("AGENT_UNAVAILABLE", "Agent service is unavailable", true);
  }
}
