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
  post<T>(path: string, body: unknown): Promise<{ status: number; body: T }>;
}

export class HttpRuntimeManagementClient implements RuntimeManagementClient {
  readonly configured: boolean;
  readonly #baseUrl?: string;
  readonly #token?: string;

  constructor(options: { baseUrl?: string; token?: string }) {
    this.#baseUrl = options.baseUrl;
    this.#token = options.token;
    this.configured = Boolean(options.baseUrl);
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.#call(path);
    if (!response.ok) throw new Error(`runtime management GET ${path} failed with ${response.status}`);
    return (await response.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await this.#call(path, body);
    return { status: response.status, body: (await response.json()) as T };
  }

  async #call(path: string, body?: unknown): Promise<Response> {
    if (this.#baseUrl === undefined) throw new Error('runtime management API is not configured');
    return fetch(`${this.#baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
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
        return new HttpRuntimeManagementClient({
          baseUrl: config.getOptionalString('sreAgent.managementApi.baseUrl'),
          token: config.getOptionalString('sreAgent.managementApi.token'),
        });
      },
    }),
});
