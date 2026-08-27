import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createRemoteJWKSet, exportJWK, importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import type { RequestIdentity } from "./identity.ts";

export interface OidcClient {
  readonly mode: "mock" | "real";
  verify(token: string, requestId: string, sessionId?: string): Promise<RequestIdentity>;
}

export interface OidcSettings {
  issuer: string;
  audience: string;
  jwksUri?: string;
}

interface Claims {
  sub: string;
  groups: string[];
  roles: string[];
}

export class MockOidcClient implements OidcClient {
  readonly mode = "mock" as const;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly #publicJwkPromise: Promise<JWK>;

  constructor(settings: OidcSettings) {
    this.#issuer = settings.issuer;
    this.#audience = settings.audience;
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = pair.privateKey;
    this.#publicJwkPromise = exportJWK(pair.publicKey);
  }

  async issueTestToken(user: "alice" | "bob", expiresInSeconds = 3600): Promise<string> {
    const claims: Record<"alice" | "bob", Claims> = {
      alice: { sub: "alice", groups: ["domain-services", "platform"], roles: ["infra-read"] },
      bob: { sub: "bob", groups: ["network"], roles: ["network-read"] },
    };
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ groups: claims[user].groups, roles: claims[user].roles })
      .setProtectedHeader({ alg: "RS256", kid: "mock-key" })
      .setIssuer(this.#issuer)
      .setAudience(this.#audience)
      .setSubject(claims[user].sub)
      .setIssuedAt(now)
      .setExpirationTime(now + expiresInSeconds)
      .setJti(randomUUID())
      .sign(this.#privateKey);
  }

  async verify(token: string, requestId: string, sessionId?: string): Promise<RequestIdentity> {
    const key = await importJWK(await this.#publicJwkPromise, "RS256");
    const verified = await jwtVerify(token, key, { issuer: this.#issuer, audience: this.#audience });
    return claimsToIdentity(verified.payload, requestId, sessionId);
  }
}

export class RealOidcClient implements OidcClient {
  readonly mode = "real" as const;
  readonly #settings: OidcSettings;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(settings: OidcSettings) {
    if (!settings.jwksUri) throw new Error("real OIDC requires jwksUri");
    this.#settings = settings;
    this.#jwks = createRemoteJWKSet(new URL(settings.jwksUri));
  }

  async verify(token: string, requestId: string, sessionId?: string): Promise<RequestIdentity> {
    const verified = await jwtVerify(token, this.#jwks, {
      issuer: this.#settings.issuer,
      audience: this.#settings.audience,
    });
    return claimsToIdentity(verified.payload, requestId, sessionId);
  }
}

function claimsToIdentity(
  payload: Record<string, unknown>, requestId: string, sessionId?: string,
): RequestIdentity {
  if (typeof payload.sub !== "string") throw new Error("OIDC subject missing");
  const groups = Array.isArray(payload.groups) ? payload.groups.filter((v): v is string => typeof v === "string") : [];
  const roles = Array.isArray(payload.roles) ? payload.roles.filter((v): v is string => typeof v === "string") : [];
  return { subject: payload.sub, groups, roles, requestId, ...(sessionId ? { sessionId } : {}) };
}

export function subjectHash(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}
