import { createServiceFactory, createServiceRef, coreServices, type RootConfigService } from '@backstage/backend-plugin-api';

/**
 * Client for the SRE runtime's read-only management API.
 *
 * The portal is the management plane and the runtime is the execution plane;
 * they talk over this API rather than sharing a process. That keeps the
 * canonical Agent schema and every authorization decision in the runtime, so
 * Backstage cannot become a second source of truth or a way around the
 * runtime's enforcement.
 */
export interface RuntimeManagementClient {
  readonly configured: boolean;
  get<T>(path: string): Promise<T>;
  /** bytes, for assets that must not go through JSON */
  getBinary(path: string): Promise<{ status: number; contentType: string; bytes: Buffer } | undefined>;
  post<T>(path: string, body: unknown): Promise<{ status: number; body: T }>;
}

export interface RuntimeOidcSettings {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface RuntimeManagementClientOptions {
  baseUrl?: string;
  token?: string;
  oidc?: RuntimeOidcSettings;
  /**
   * LOCAL ONLY: the runtime's mock-OIDC minting route (`/dev/token/alice`).
   * A pasted dev token expires in an hour and dies with every runtime restart,
   * so the backend mints and refreshes its own, exactly as it does with real
   * OIDC. The runtime registers that route only when SRE_ENV=local.
   */
  devTokenUrl?: string;
}

/**
 * Read the optional runtime connection without making an empty YAML object
 * mandatory. Backstage keeps the `oidc` object when all of its environment
 * placeholders are unset, so checking only `getOptionalConfig()` would turn a
 * deliberately unconfigured local backend into a startup failure.
 *
 * A partially configured credential is different: silently ignoring it would
 * make an operator believe OIDC is active when it is not, so that remains a
 * clear configuration error naming the missing fields.
 */
export function readRuntimeManagementClientOptions(config: RootConfigService): RuntimeManagementClientOptions {
  const oidcConfig = config.getOptionalConfig('sreAgent.managementApi.oidc');
  const oidcValues = oidcConfig
    ? {
        tokenUrl: oidcConfig.getOptionalString('tokenUrl'),
        clientId: oidcConfig.getOptionalString('clientId'),
        clientSecret: oidcConfig.getOptionalString('clientSecret'),
        username: oidcConfig.getOptionalString('username'),
        password: oidcConfig.getOptionalString('password'),
      }
    : undefined;

  const configuredOidcValues = oidcValues
    ? Object.entries(oidcValues).filter((entry): entry is [keyof RuntimeOidcSettings, string] => entry[1] !== undefined)
    : [];
  if (configuredOidcValues.length > 0 && configuredOidcValues.length < 5) {
    const missing = Object.entries(oidcValues ?? {})
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    throw new Error(`incomplete sreAgent.managementApi.oidc configuration; missing: ${missing.join(', ')}`);
  }

  return {
    baseUrl: config.getOptionalString('sreAgent.managementApi.baseUrl'),
    token: config.getOptionalString('sreAgent.managementApi.token'),
    ...(config.getOptionalString('sreAgent.managementApi.devTokenUrl') ? { devTokenUrl: config.getOptionalString('sreAgent.managementApi.devTokenUrl') } : {}),
    ...(configuredOidcValues.length === 5
      ? { oidc: Object.fromEntries(configuredOidcValues) as unknown as RuntimeOidcSettings }
      : {}),
  };
}

export class HttpRuntimeManagementClient implements RuntimeManagementClient {
  readonly configured: boolean;
  readonly #baseUrl?: string;
  readonly #staticToken?: string;
  readonly #oidc?: RuntimeOidcSettings;
  readonly #devTokenUrl?: string;
  #cached?: { token: string; expiresAtMs: number };

  constructor(options: RuntimeManagementClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#staticToken = options.token;
    this.#oidc = options.oidc;
    this.#devTokenUrl = options.devTokenUrl;
    this.configured = Boolean(options.baseUrl);
  }

  /**
   * Runtime tokens are short-lived by design, so a token pasted into config
   * stops working minutes later. When OIDC settings are present the client
   * mints its own and refreshes before expiry.
   */
  async #accessToken(): Promise<string | undefined> {
    if (this.#cached && this.#cached.expiresAtMs - 15_000 > Date.now()) return this.#cached.token;
    if (this.#oidc === undefined) {
      if (this.#devTokenUrl === undefined) return this.#staticToken;
      const minted = await fetch(this.#devTokenUrl, { method: 'POST' });
      if (!minted.ok) throw new Error(`runtime dev token request failed with ${minted.status}`);
      const { token } = (await minted.json()) as { token?: string };
      if (token === undefined) throw new Error('runtime dev token response had no token');
      // the mock issues one-hour tokens; refresh well inside that
      this.#cached = { token, expiresAtMs: Date.now() + 30 * 60_000 };
      return token;
    }
    const response = await fetch(this.#oidc.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: this.#oidc.clientId,
        client_secret: this.#oidc.clientSecret,
        username: this.#oidc.username,
        password: this.#oidc.password,
      }),
    });
    if (!response.ok) throw new Error(`runtime token request failed with ${response.status}`);
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (json.access_token === undefined) throw new Error('runtime token response had no access token');
    this.#cached = { token: json.access_token, expiresAtMs: Date.now() + (json.expires_in ?? 60) * 1000 };
    return json.access_token;
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.#call(path);
    if (!response.ok) throw new Error(`runtime management GET ${path} failed with ${response.status}`);
    return (await response.json()) as T;
  }

  /**
   * Fetch bytes rather than JSON — an avatar is an image, and putting it
   * through `response.json()` would corrupt it while still looking like a
   * successful request.
   */
  async getBinary(path: string): Promise<{ status: number; contentType: string; bytes: Buffer } | undefined> {
    const response = await this.#call(path);
    if (!response.ok) return undefined;
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }

  async post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await this.#call(path, body);
    // a proxy error page or an unknown route answers HTML; that is a runtime
    // status to report, not a JSON parse failure to crash on
    const parsed = await response.json().catch(() => ({ code: 'RUNTIME_UNAVAILABLE', message: `the runtime answered ${response.status} without a JSON body for ${path}` }));
    return { status: response.status, body: parsed as T };
  }

  async #call(path: string, body?: unknown): Promise<Response> {
    const response = await this.#send(path, body);
    // A minted token can die before it expires — the runtime restarted and the
    // mock issuer signs with a new key, or a session was revoked. One re-mint
    // and retry turns that into nothing anyone notices.
    if (response.status === 401 && this.#cached !== undefined) {
      this.#cached = undefined;
      return this.#send(path, body);
    }
    return response;
  }

  async #send(path: string, body?: unknown): Promise<Response> {
    if (this.#baseUrl === undefined) throw new Error('runtime management API is not configured');
    const token = await this.#accessToken();
    return fetch(`${this.#baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

export const runtimeManagementClientRef = createServiceRef<RuntimeManagementClient>({
  id: 'agent-management.runtime-client',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { config: coreServices.rootConfig },
      async factory({ config }: { config: RootConfigService }) {
        return new HttpRuntimeManagementClient(readRuntimeManagementClientOptions(config));
      },
    }),
});
