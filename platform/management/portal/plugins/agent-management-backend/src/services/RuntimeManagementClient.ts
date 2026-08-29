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

export class HttpRuntimeManagementClient implements RuntimeManagementClient {
  readonly configured: boolean;
  readonly #baseUrl?: string;
  readonly #staticToken?: string;
  readonly #oidc?: RuntimeOidcSettings;
  #cached?: { token: string; expiresAtMs: number };

  constructor(options: { baseUrl?: string; token?: string; oidc?: RuntimeOidcSettings }) {
    this.#baseUrl = options.baseUrl;
    this.#staticToken = options.token;
    this.#oidc = options.oidc;
    this.configured = Boolean(options.baseUrl);
  }

  /**
   * Runtime tokens are short-lived by design, so a token pasted into config
   * stops working minutes later. When OIDC settings are present the client
   * mints its own and refreshes before expiry.
   */
  async #accessToken(): Promise<string | undefined> {
    if (this.#oidc === undefined) return this.#staticToken;
    if (this.#cached && this.#cached.expiresAtMs - 15_000 > Date.now()) return this.#cached.token;
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
    return { status: response.status, body: (await response.json()) as T };
  }

  async #call(path: string, body?: unknown): Promise<Response> {
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
        const oidc = config.getOptionalConfig('sreAgent.managementApi.oidc');
        return new HttpRuntimeManagementClient({
          baseUrl: config.getOptionalString('sreAgent.managementApi.baseUrl'),
          token: config.getOptionalString('sreAgent.managementApi.token'),
          ...(oidc
            ? {
                oidc: {
                  tokenUrl: oidc.getString('tokenUrl'),
                  clientId: oidc.getString('clientId'),
                  clientSecret: oidc.getString('clientSecret'),
                  username: oidc.getString('username'),
                  password: oidc.getString('password'),
                },
              }
            : {}),
        });
      },
    }),
});
