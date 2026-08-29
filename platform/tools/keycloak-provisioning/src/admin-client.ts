import type { DesiredAudienceScope, DesiredClient } from "./desired-state.ts";

/**
 * The narrow slice of the Keycloak Admin REST API the reconciler needs.
 * Deliberately an interface: the runtime never depends on it (TDD §31), and
 * tests reconcile against an in-memory realm without weakening Keycloak
 * security to make them pass.
 *
 * There is no deleteClient: a workload identity is disabled, never destroyed
 * automatically (TDD §32).
 */
export interface KeycloakAdmin {
  getClient(clientId: string): Promise<ActualClient | undefined>;
  createClient(desired: DesiredClient): Promise<string>;
  updateClient(id: string, desired: DesiredClient): Promise<void>;
  setClientEnabled(id: string, enabled: boolean): Promise<void>;
  listClientRoles(id: string): Promise<string[]>;
  createClientRole(id: string, name: string, description: string): Promise<void>;
  removeClientRole(id: string, name: string): Promise<void>;
  ensureAudienceScope(scope: DesiredAudienceScope): Promise<void>;
  listOptionalClientScopes(id: string): Promise<string[]>;
  addOptionalClientScope(id: string, scopeName: string): Promise<void>;
  removeOptionalClientScope(id: string, scopeName: string): Promise<void>;
}

export interface ActualClient {
  /** Keycloak's internal UUID, not the clientId */
  id: string;
  clientId: string;
  enabled: boolean;
  serviceAccountsEnabled: boolean;
  standardFlowEnabled: boolean;
  publicClient: boolean;
  attributes: Record<string, string>;
}

export interface HttpKeycloakAdminSettings {
  baseUrl: string;
  realm: string;
  /**
   * Supplies a fresh admin access token. Taking a callback rather than a stored
   * credential keeps secrets out of this object and lets the caller source them
   * from OpenShift Secrets or a vault (TDD §36).
   */
  accessToken: () => Promise<string>;
  fetchImplementation?: typeof fetch;
}

/** Keycloak Admin REST API implementation — management path only, never the request path. */
export class HttpKeycloakAdmin implements KeycloakAdmin {
  readonly #settings: HttpKeycloakAdminSettings;
  readonly #fetch: typeof fetch;

  constructor(settings: HttpKeycloakAdminSettings) {
    this.#settings = settings;
    this.#fetch = settings.fetchImplementation ?? fetch;
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.#settings.accessToken();
    const response = await this.#fetch(`${this.#settings.baseUrl}/admin/realms/${this.#settings.realm}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    if (!response.ok && response.status !== 409) {
      // the message deliberately omits the response body: it can echo policy internals
      throw new Error(`keycloak admin ${init.method ?? "GET"} ${path} failed with ${response.status}`);
    }
    return response;
  }

  async getClient(clientId: string): Promise<ActualClient | undefined> {
    const response = await this.#call(`/clients?clientId=${encodeURIComponent(clientId)}`);
    const found = (await response.json()) as ActualClient[];
    return found[0];
  }

  async createClient(desired: DesiredClient): Promise<string> {
    await this.#call("/clients", { method: "POST", body: JSON.stringify(representation(desired)) });
    const created = await this.getClient(desired.clientId);
    if (created === undefined) throw new Error(`client ${desired.clientId} missing after create`);
    return created.id;
  }

  async updateClient(id: string, desired: DesiredClient): Promise<void> {
    await this.#call(`/clients/${id}`, { method: "PUT", body: JSON.stringify(representation(desired)) });
  }

  async setClientEnabled(id: string, enabled: boolean): Promise<void> {
    await this.#call(`/clients/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) });
  }

  async listClientRoles(id: string): Promise<string[]> {
    const response = await this.#call(`/clients/${id}/roles`);
    return ((await response.json()) as Array<{ name: string }>).map((role) => role.name);
  }

  async createClientRole(id: string, name: string, description: string): Promise<void> {
    await this.#call(`/clients/${id}/roles`, { method: "POST", body: JSON.stringify({ name, description }) });
  }

  async removeClientRole(id: string, name: string): Promise<void> {
    await this.#call(`/clients/${id}/roles/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  async ensureAudienceScope(scope: DesiredAudienceScope): Promise<void> {
    const existing = (await (await this.#call("/client-scopes")).json()) as Array<{ id: string; name: string }>;
    if (existing.some((item) => item.name === scope.name)) return;
    await this.#call("/client-scopes", {
      method: "POST",
      body: JSON.stringify({
        name: scope.name,
        protocol: "openid-connect",
        attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "false" },
        protocolMappers: [
          {
            name: `audience-${scope.mcp}`,
            protocol: "openid-connect",
            protocolMapper: "oidc-audience-mapper",
            config: { "included.custom.audience": scope.audience, "access.token.claim": "true", "id.token.claim": "false" },
          },
        ],
      }),
    });
  }

  async listOptionalClientScopes(id: string): Promise<string[]> {
    const response = await this.#call(`/clients/${id}/optional-client-scopes`);
    return ((await response.json()) as Array<{ name: string }>).map((scope) => scope.name);
  }

  async addOptionalClientScope(id: string, scopeName: string): Promise<void> {
    const scopes = (await (await this.#call("/client-scopes")).json()) as Array<{ id: string; name: string }>;
    const scope = scopes.find((item) => item.name === scopeName);
    if (scope === undefined) throw new Error(`client scope ${scopeName} does not exist`);
    await this.#call(`/clients/${id}/optional-client-scopes/${scope.id}`, { method: "PUT" });
  }

  async removeOptionalClientScope(id: string, scopeName: string): Promise<void> {
    const scopes = (await (await this.#call("/client-scopes")).json()) as Array<{ id: string; name: string }>;
    const scope = scopes.find((item) => item.name === scopeName);
    if (scope === undefined) return;
    await this.#call(`/clients/${id}/optional-client-scopes/${scope.id}`, { method: "DELETE" });
  }
}

function representation(desired: DesiredClient): Record<string, unknown> {
  return {
    clientId: desired.clientId,
    name: desired.name,
    description: desired.description,
    enabled: desired.enabled,
    protocol: "openid-connect",
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    attributes: desired.attributes,
  };
}
