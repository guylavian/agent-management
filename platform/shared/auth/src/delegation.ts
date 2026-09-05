import { createRemoteJWKSet, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";
import {
  delegatedIdentityContextSchema,
  hashDelegatedSubject,
  type DelegatedIdentityContext,
} from "@sre/agent-protocol";
import type { RequestIdentity } from "./identity.ts";

/**
 * How long a delegated assertion lives.
 *
 * It must cover the WHOLE investigation, because the specialist presents this
 * same assertion as the `subject_token` every time it re-exchanges an expired
 * tool credential. Capping it at a flat 60s meant a 120s run could obtain a
 * credential at t=0 and then have every refresh after minute one rejected by
 * the identity provider.
 *
 * It never outlives the run: the assertion is bound to one human, one agent
 * audience and one request id, so beyond the deadline it authorizes nothing
 * anyone should still be doing. The ceiling bounds a caller that passes an
 * absurd deadline.
 */
const MAX_DELEGATION_SECONDS = 900;

function delegationExpiry(nowSeconds: number, deadline: number): number {
  return Math.min(Math.floor(deadline / 1000), nowSeconds + MAX_DELEGATION_SECONDS);
}

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
    const expiry = delegationExpiry(now, deadline);
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

/** Verifies the local PoC's asymmetric delegated tokens from a mounted public key. */
export class PublicKeyDelegatedIdentityVerifier implements DelegatedIdentityVerifier {
  readonly #issuer: string;
  readonly #keyPromise: ReturnType<typeof importSPKI>;

  constructor(settings: { issuer: string; publicKeySpki: string }) {
    this.#issuer = settings.issuer;
    this.#keyPromise = importSPKI(settings.publicKeySpki, "RS256");
  }

  async verify(context: DelegatedIdentityContext, expectedAudience: string, requestId: string): Promise<RequestIdentity> {
    if (context.audience !== expectedAudience || context.issuer !== this.#issuer) throw new Error("delegated identity context rejected");
    const verified = await jwtVerify(context.token, await this.#keyPromise, { issuer: this.#issuer, audience: expectedAudience, algorithms: ["RS256"] });
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
    const expiry = delegationExpiry(now, deadline);
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
