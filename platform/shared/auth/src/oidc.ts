import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  /**
   * MOCK ONLY: where the dev signing key lives between processes.
   *
   * Without it the mock generated a fresh RSA key on every start, so every
   * restart silently invalidated every token it had ever issued — the portal's
   * cached token, a pasted dev token, an in-flight session — and the first
   * symptom was an unexplained 401 somewhere else. Persisting the key is what
   * makes a local restart a restart rather than a key rotation.
   */
  mockKeyFile?: string;
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
  readonly #privateKey: KeyObject;
  readonly #publicJwkPromise: Promise<JWK>;

  constructor(settings: OidcSettings) {
    this.#issuer = settings.issuer;
    this.#audience = settings.audience;
    this.#privateKey = settings.mockKeyFile === undefined ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey : loadOrCreateKey(settings.mockKeyFile);
    this.#publicJwkPromise = exportJWK(createPublicKey(this.#privateKey));
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

/** A PEM on disk, created once with owner-only permissions. Local development only. */
function loadOrCreateKey(file: string): KeyObject {
  if (existsSync(file)) return createPrivateKey(readFileSync(file, "utf8"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  } catch (error) {
    // a read-only filesystem (a container) cannot keep the key; say so once and
    // rotate per process as before, rather than refusing to start
    console.warn(`mock OIDC key could not be persisted at ${file} (${(error as Error).message}); tokens will not survive a restart`);
  }
  return privateKey;
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
  const directRoles = Array.isArray(payload.roles) ? payload.roles.filter((v): v is string => typeof v === "string") : [];
  const realmAccess = typeof payload.realm_access === "object" && payload.realm_access !== null ? payload.realm_access as { roles?: unknown } : undefined;
  const realmRoles = Array.isArray(realmAccess?.roles) ? realmAccess.roles.filter((v): v is string => typeof v === "string") : [];
  const roles = [...new Set([...directRoles, ...realmRoles])];
  return { subject: payload.sub, groups, roles, requestId, ...(sessionId ? { sessionId } : {}) };
}

export function subjectHash(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}
