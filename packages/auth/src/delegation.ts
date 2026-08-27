import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTPayload } from "jose";
import {
  delegatedIdentityContextSchema,
  hashDelegatedSubject,
  type DelegatedIdentityContext,
} from "@sre/agent-protocol";
import type { RequestIdentity } from "./identity.ts";

export interface DelegatedIdentityIssuer {
  issue(identity: RequestIdentity, audience: string, deadline: number): Promise<DelegatedIdentityContext>;
}

export interface DelegatedIdentityVerifier {
  verify(context: DelegatedIdentityContext, expectedAudience: string, requestId: string): Promise<RequestIdentity>;
}

interface DelegationSettings {
  issuer: string;
  secret: string;
}

/** Local/test authority. The shared key must be injected; production rejects this implementation. */
export class MockDelegationAuthority implements DelegatedIdentityIssuer, DelegatedIdentityVerifier {
  readonly #issuer: string;
  readonly #key: Uint8Array;

  constructor(settings: DelegationSettings) {
    if (settings.secret.length < 32) throw new Error("mock delegation secret must be at least 32 characters");
    this.#issuer = settings.issuer;
    this.#key = new TextEncoder().encode(settings.secret);
  }

  async issue(identity: RequestIdentity, audience: string, deadline: number): Promise<DelegatedIdentityContext> {
    const now = Math.floor(Date.now() / 1000);
    const expiry = Math.min(now + 60, Math.floor(deadline / 1000));
    if (expiry <= now) throw Object.assign(new Error("delegation deadline expired"), { code: "AGENT_TIMEOUT" });
    const token = await new SignJWT({ groups: identity.groups, roles: identity.roles, request_id: identity.requestId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.#issuer)
      .setAudience(audience)
      .setSubject(identity.subject)
      .setIssuedAt(now)
      .setNotBefore(now - 1)
      .setExpirationTime(expiry)
      .sign(this.#key);
    return delegatedIdentityContextSchema.parse({
      token,
      tokenType: "urn:ietf:params:oauth:token-type:jwt",
      issuer: this.#issuer,
      audience,
      subjectHash: hashDelegatedSubject(identity.subject),
    });
  }

  async verify(context: DelegatedIdentityContext, expectedAudience: string, requestId: string): Promise<RequestIdentity> {
    if (context.audience !== expectedAudience || context.issuer !== this.#issuer) throw new Error("delegated identity context rejected");
    const verified = await jwtVerify(context.token, this.#key, { issuer: this.#issuer, audience: expectedAudience, algorithms: ["HS256"] });
    return verifiedIdentity(verified.payload, context, requestId);
  }
}

/** Production verifier for audience-specific JWTs issued by the enterprise identity/token-exchange service. */
export class JwksDelegatedIdentityVerifier implements DelegatedIdentityVerifier {
  readonly #issuer: string;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(settings: { issuer: string; jwksUri: string }) {
    this.#issuer = settings.issuer;
    this.#jwks = createRemoteJWKSet(new URL(settings.jwksUri));
  }

  async verify(context: DelegatedIdentityContext, expectedAudience: string, requestId: string): Promise<RequestIdentity> {
    if (context.audience !== expectedAudience || context.issuer !== this.#issuer) throw new Error("delegated identity context rejected");
    const verified = await jwtVerify(context.token, this.#jwks, { issuer: this.#issuer, audience: expectedAudience });
    return verifiedIdentity(verified.payload, context, requestId);
  }
}

/** Production-compatible signer for a platform-held asymmetric workload key. Prefer enterprise token exchange when available. */
export class PrivateKeyDelegatedIdentityIssuer implements DelegatedIdentityIssuer {
  readonly #issuer: string;
  readonly #keyPromise: ReturnType<typeof importPKCS8>;

  constructor(settings: { issuer: string; privateKeyPkcs8: string }) {
    this.#issuer = settings.issuer;
    this.#keyPromise = importPKCS8(settings.privateKeyPkcs8, "RS256");
  }

  async issue(identity: RequestIdentity, audience: string, deadline: number): Promise<DelegatedIdentityContext> {
    const now = Math.floor(Date.now() / 1000);
    const expiry = Math.min(now + 60, Math.floor(deadline / 1000));
    if (expiry <= now) throw Object.assign(new Error("delegation deadline expired"), { code: "AGENT_TIMEOUT" });
    const token = await new SignJWT({ groups: identity.groups, roles: identity.roles, request_id: identity.requestId })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.#issuer)
      .setAudience(audience)
      .setSubject(identity.subject)
      .setIssuedAt(now)
      .setExpirationTime(expiry)
      .sign(await this.#keyPromise);
    return delegatedIdentityContextSchema.parse({ token, tokenType: "urn:ietf:params:oauth:token-type:jwt", issuer: this.#issuer, audience, subjectHash: hashDelegatedSubject(identity.subject) });
  }
}

function verifiedIdentity(payload: JWTPayload, context: DelegatedIdentityContext, requestId: string): RequestIdentity {
  if (payload.sub === undefined || payload.request_id !== requestId || hashDelegatedSubject(payload.sub) !== context.subjectHash) throw new Error("delegated identity binding rejected");
  const groups = Array.isArray(payload.groups) ? payload.groups.filter((value): value is string => typeof value === "string") : [];
  const roles = Array.isArray(payload.roles) ? payload.roles.filter((value): value is string => typeof value === "string") : [];
  return { subject: payload.sub, groups, roles, requestId };
}
