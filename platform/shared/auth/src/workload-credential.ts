import { createRemoteJWKSet, jwtVerify } from "jose";
import { hashSubject, toolCredentialSchema, type ToolCredential, type ToolCredentialExchanger } from "./tool-credential.ts";
import type { RequestIdentity, WorkloadIdentity } from "./identity.ts";

/**
 * Keycloak workload authentication (TDD §8/§9).
 *
 * The Agent authenticates as ITS OWN service-account client and asks for the
 * single client scope that carries the target MCP's audience, so the issued
 * token is bound to exactly one ToolHive resource. A token minted for
 * sre-toolhive:keycloak therefore cannot be replayed against Prometheus.
 *
 * The client secret is supplied by a callback rather than stored here, so the
 * process can source it from an OpenShift Secret or a vault and rotate it
 * without reconstructing this object. It is never logged, never placed in a
 * span, and never written to Agent YAML.
 */
export interface KeycloakWorkloadSettings {
  tokenEndpoint: string;
  /** the client id THIS process is provisioned as, e.g. sre-agent-keycloak */
  clientId: string;
  clientSecret: () => Promise<string> | string;
  /** expected token issuer, used to populate the credential envelope */
  issuer: string;
  /** JWKS of the issuer; when present the acquired token is verified before use */
  jwksUri?: string;
  fetchImplementation?: typeof fetch;
}

/** Client-scope name that mints one MCP audience. Mirrors @sre/keycloak-provisioning. */
export function audienceScopeFor(audience: string): string {
  const mcp = audience.startsWith("sre-toolhive:") ? audience.slice("sre-toolhive:".length) : audience;
  return `sre-toolhive-${mcp}`;
}

interface CacheEntry { credential: ToolCredential; expiresAtMs: number }

export class KeycloakWorkloadCredentialExchanger implements ToolCredentialExchanger {
  readonly mode = "real" as const;
  readonly #settings: KeycloakWorkloadSettings;
  readonly #fetch: typeof fetch;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(settings: KeycloakWorkloadSettings) {
    this.#settings = settings;
    this.#fetch = settings.fetchImplementation ?? fetch;
    this.#jwks = settings.jwksUri === undefined ? undefined : createRemoteJWKSet(new URL(settings.jwksUri));
  }

  async exchange(workload: WorkloadIdentity, identity: RequestIdentity, audience: string, deadline: number, signal?: AbortSignal): Promise<ToolCredential> {
    // an Agent may only ever present its own workload identity; a mismatch means
    // the process was handed another Agent's config and must fail closed
    if (workload.clientId !== this.#settings.clientId) {
      throw Object.assign(new Error("workload identity mismatch"), { code: "TOOL_DENIED" });
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw Object.assign(new Error("tool credential deadline expired"), { code: "REQUEST_TIMEOUT" });

    // the SUBJECT is part of the key. Caching on (client, audience) alone and
    // re-stamping subjectHash handed one human's token to the next, with an
    // envelope that claimed otherwise — a token is never shared across people.
    const cacheKey = `${workload.clientId}|${audience}|${hashSubject(identity.subject)}`;
    const cached = this.#cache.get(cacheKey);
    // 5s skew guard so a token cannot expire mid-flight
    if (cached !== undefined && cached.expiresAtMs - 5_000 > Date.now()) {
      return cached.credential;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.#settings.clientId,
      client_secret: String(await this.#settings.clientSecret()),
      // exactly one MCP audience — never a token valid against every MCP
      scope: audienceScopeFor(audience),
    });
    const response = await this.#fetch(this.#settings.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      // caller cancellation aborts the exchange alongside the remaining-time budget
      signal: signal === undefined ? AbortSignal.timeout(remainingMs) : AbortSignal.any([AbortSignal.timeout(remainingMs), signal]),
    });
    if (!response.ok) throw Object.assign(new Error("workload token request failed"), { code: "TOOL_DENIED" });
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (json.access_token === undefined) throw Object.assign(new Error("workload token response had no access token"), { code: "TOOL_DENIED" });

    await this.#assertAudience(json.access_token, audience);

    const lifetimeMs = Math.min((json.expires_in ?? 60) * 1000, 300_000);
    const credential = toolCredentialSchema.parse({
      token: json.access_token,
      tokenType: "urn:ietf:params:oauth:token-type:access_token",
      issuer: this.#settings.issuer,
      audience,
      subjectHash: hashSubject(identity.subject),
      workloadClientId: workload.clientId,
      expiresAt: Date.now() + lifetimeMs,
    });
    this.#cache.set(cacheKey, { credential, expiresAtMs: Date.now() + lifetimeMs });
    return credential;
  }

  /**
   * Trust but verify: if Keycloak returned a token whose `aud` is not the one we
   * asked for (misconfigured scope, drifted mapper), using it would silently
   * widen the Agent's reach. Reject instead.
   */
  async #assertAudience(token: string, audience: string): Promise<void> {
    if (this.#jwks === undefined) return;
    const { payload } = await jwtVerify(token, this.#jwks, { issuer: this.#settings.issuer });
    const actual = Array.isArray(payload.aud) ? payload.aud : payload.aud === undefined ? [] : [payload.aud];
    if (!actual.includes(audience)) {
      throw Object.assign(new Error("workload token audience mismatch"), { code: "TOOL_DENIED" });
    }
  }
}
