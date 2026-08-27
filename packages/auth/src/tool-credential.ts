import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { RequestIdentity } from "./identity.ts";

/**
 * Verified delegated credential presented by a Specialist to ToolHive
 * (architecture Rev 2.0 §4 / Gate #1). It replaces the unsigned
 * `x-effective-subject` header: ToolHive verifies this token itself and
 * derives the effective human principal from it, so authorization never
 * depends on a header the calling Agent could forge.
 */
export const toolCredentialSchema = z
  .object({
    token: z.string().min(16),
    tokenType: z.literal("urn:ietf:params:oauth:token-type:access_token"),
    issuer: z.string().min(1),
    audience: z.string().min(1),
    subjectHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type ToolCredential = z.infer<typeof toolCredentialSchema>;

export interface VerifiedToolPrincipal {
  subject: string;
  groups: string[];
  roles: string[];
}

/** Specialist-side: obtains a credential scoped to one ToolHive audience for the effective human. */
export interface ToolCredentialExchanger {
  readonly mode: "mock" | "real";
  exchange(identity: RequestIdentity, audience: string, deadline: number): Promise<ToolCredential>;
}

/** Gateway-side: verifies the credential and returns the effective principal. */
export interface ToolCredentialVerifier {
  verify(credential: ToolCredential, expectedAudience: string, requestId: string): Promise<VerifiedToolPrincipal>;
}

export function hashSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}

interface MockSettings { issuer: string; secret: string }

/**
 * Local/test authority that both issues and verifies the tool credential with a
 * shared HS256 key — it stands in for the enterprise token-exchange service and
 * the ToolHive verifier together, so the Gate #1 path is exercised end to end
 * without a real IdP. Production uses {@link RealTokenExchangeCredentialExchanger}
 * and ToolHive's own verifier.
 */
export class MockToolCredentialAuthority implements ToolCredentialExchanger, ToolCredentialVerifier {
  readonly mode = "mock" as const;
  readonly #issuer: string;
  readonly #key: Uint8Array;

  constructor(settings: MockSettings) {
    if (settings.secret.length < 32) throw new Error("mock tool-credential secret must be at least 32 characters");
    this.#issuer = settings.issuer;
    this.#key = new TextEncoder().encode(settings.secret);
  }

  async exchange(identity: RequestIdentity, audience: string, deadline: number): Promise<ToolCredential> {
    const now = Math.floor(Date.now() / 1000);
    const expiry = Math.min(now + 60, Math.floor(deadline / 1000));
    if (expiry <= now) throw Object.assign(new Error("tool credential deadline expired"), { code: "REQUEST_TIMEOUT" });
    const token = await new SignJWT({ groups: identity.groups, roles: identity.roles, request_id: identity.requestId })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(this.#issuer)
      .setAudience(audience)
      .setSubject(identity.subject)
      .setIssuedAt(now)
      .setNotBefore(now - 1)
      .setExpirationTime(expiry)
      .sign(this.#key);
    return toolCredentialSchema.parse({ token, tokenType: "urn:ietf:params:oauth:token-type:access_token", issuer: this.#issuer, audience, subjectHash: hashSubject(identity.subject) });
  }

  async verify(credential: ToolCredential, expectedAudience: string, requestId: string): Promise<VerifiedToolPrincipal> {
    if (credential.audience !== expectedAudience || credential.issuer !== this.#issuer) throw Object.assign(new Error("tool credential rejected"), { code: "TOOL_DENIED" });
    const verified = await jwtVerify(credential.token, this.#key, { issuer: this.#issuer, audience: expectedAudience, algorithms: ["HS256"] });
    const payload = verified.payload;
    if (payload.sub === undefined || payload.request_id !== requestId || hashSubject(payload.sub) !== credential.subjectHash) throw Object.assign(new Error("tool credential binding rejected"), { code: "TOOL_DENIED" });
    return {
      subject: payload.sub,
      groups: Array.isArray(payload.groups) ? payload.groups.filter((v): v is string => typeof v === "string") : [],
      roles: Array.isArray(payload.roles) ? payload.roles.filter((v): v is string => typeof v === "string") : [],
    };
  }
}

export interface RealTokenExchangeSettings {
  tokenEndpoint?: string;
  audiencePrefix: string;
}

/**
 * RFC 8693 OAuth 2.0 Token Exchange client — INTEGRATION BLOCKER.
 *
 * The shape is complete but exchange() cannot succeed until the enterprise STS
 * endpoint, the workload subject-token source, and the accepted audience values
 * are provisioned and pinned. It never falls back to an unsigned identity.
 */
export class RealTokenExchangeCredentialExchanger implements ToolCredentialExchanger {
  readonly mode = "real" as const;
  readonly #settings: RealTokenExchangeSettings;
  readonly #fetch: typeof fetch;

  constructor(settings: RealTokenExchangeSettings, fetchImplementation: typeof fetch = fetch) {
    this.#settings = settings;
    this.#fetch = fetchImplementation;
  }

  async exchange(identity: RequestIdentity, audience: string, deadline: number): Promise<ToolCredential> {
    if (this.#settings.tokenEndpoint === undefined) {
      throw Object.assign(new Error("INTEGRATION BLOCKER: enterprise token-exchange endpoint (RFC 8693) is not configured"), { code: "TOOL_DENIED" });
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw Object.assign(new Error("tool credential deadline expired"), { code: "REQUEST_TIMEOUT" });
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      // the effective human subject; the enterprise STS binds the workload actor separately
      subject_token: identity.subject,
    });
    const response = await this.#fetch(this.#settings.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(remainingMs),
    });
    if (!response.ok) throw Object.assign(new Error("token exchange failed"), { code: "TOOL_DENIED" });
    const json = (await response.json()) as { access_token?: string; issued_token_type?: string };
    if (json.access_token === undefined) throw Object.assign(new Error("token exchange returned no access token"), { code: "TOOL_DENIED" });
    return toolCredentialSchema.parse({
      token: json.access_token,
      tokenType: "urn:ietf:params:oauth:token-type:access_token",
      issuer: this.#settings.audiencePrefix,
      audience,
      subjectHash: hashSubject(identity.subject),
    });
  }
}
