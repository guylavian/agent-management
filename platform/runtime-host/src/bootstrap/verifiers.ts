import type { SpecialistAgentConfig, ApprovedCatalog } from "@sre/config";
import type { IdentityVerifier, SubsystemResult, ToolAccessVerifier } from "./reconciler.ts";

/**
 * What the reconciler is allowed to say it verified.
 *
 * The reconciler's contract is strict: a subsystem that was not actually
 * checked reports NOT ready, and the reason names what could not be looked at.
 * These two verifiers therefore each state, in `detail`, the exact property
 * they established — never "ok", because an operator reading a stale
 * attestation needs to know what was true and what was merely assumed.
 */

const PROBE_TIMEOUT_MS = 5_000;

export interface KeycloakIdentitySettings {
  /** admin base URL, e.g. https://rhbk.internal */
  adminUrl: string;
  /** realm the workload clients live in */
  realm: string;
  /** realm holding the admin service account (usually `master`) */
  adminRealm: string;
  clientId: string;
  clientSecret: () => Promise<string> | string;
  fetchImplementation?: typeof fetch;
}

/**
 * Identity attestation: the Agent's workload client exists in the IdP and is
 * enabled.
 *
 * A disabled client cannot obtain a token, so an Agent whose identity was
 * revoked must stop routing — and it must stop because the reconciler LOOKED,
 * not because a credential happened to fail on the request path later.
 */
export class KeycloakIdentityVerifier implements IdentityVerifier {
  readonly #settings: KeycloakIdentitySettings;
  readonly #fetch: typeof fetch;

  constructor(settings: KeycloakIdentitySettings) {
    this.#settings = settings;
    this.#fetch = settings.fetchImplementation ?? fetch;
  }

  async verify(agent: SpecialistAgentConfig, _environment: string): Promise<SubsystemResult> {
    const clientId = agent.spec.identity?.clientId;
    if (clientId === undefined) {
      return { ready: false, detail: "the Agent declares no workload client id" };
    }
    try {
      const token = await this.#adminToken();
      const url = new URL(`/admin/realms/${encodeURIComponent(this.#settings.realm)}/clients`, this.#settings.adminUrl);
      url.searchParams.set("clientId", clientId);
      const response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) return { ready: false, detail: `the IdP refused the client lookup (${response.status})` };
      const clients = (await response.json()) as Array<{ clientId?: string; enabled?: boolean; serviceAccountsEnabled?: boolean }>;
      const client = clients.find((candidate) => candidate.clientId === clientId);
      if (client === undefined) return { ready: false, detail: `no workload client "${clientId}" exists in realm ${this.#settings.realm}` };
      if (client.enabled !== true) return { ready: false, detail: `the workload client "${clientId}" is disabled in the IdP` };
      if (client.serviceAccountsEnabled !== true) return { ready: false, detail: `the workload client "${clientId}" has no service account, so it cannot obtain a token` };
      return { ready: true, detail: `the workload client "${clientId}" exists, is enabled and has a service account` };
    } catch (error) {
      return { ready: false, detail: `the IdP could not be reached: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async #adminToken(): Promise<string> {
    const url = new URL(`/realms/${encodeURIComponent(this.#settings.adminRealm)}/protocol/openid-connect/token`, this.#settings.adminUrl);
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.#settings.clientId, client_secret: String(await this.#settings.clientSecret()) }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`admin token request failed (${response.status})`);
    const payload = (await response.json()) as { access_token?: string };
    if (payload.access_token === undefined) throw new Error("admin token response carried no access token");
    return payload.access_token;
  }
}

export interface GatewayToolAccessSettings {
  /** the approved catalog this environment ships — the same one the runtime enforces from */
  catalog: ApprovedCatalog;
  /** per-server gateway endpoints, so the probe asks the endpoint the Agent would actually call */
  endpoints: ReadonlyMap<string, string>;
  /**
   * Attest tool access even though the gateway's loaded per-Agent policy cannot
   * be read back.
   *
   * ToolHive reads its authorization configuration when a proxy starts and
   * exposes no way to ask what it currently holds. Without that, this verifier
   * can confirm the grants and that the gateway rejects anonymous calls, but
   * not that a REVOKED grant actually stopped working — which is the property
   * the operational plane exists to guarantee. Default closed; an operator who
   * accepts the weaker basis says so here, and the acceptance is recorded in
   * the attestation's detail rather than inferred from its absence.
   */
  acceptUnintrospectablePolicy?: boolean;
  fetchImplementation?: typeof fetch;
}

/**
 * Tool-access attestation, and an honest account of its limits.
 *
 * Two things are established. First, every tool this Agent's policy grants is
 * present in the approved catalog and verified read-only — a grant naming a
 * tool the catalog never approved is a configuration error that would
 * otherwise only surface as a denial mid-investigation. Second, the gateway
 * for each of its servers is reachable AND refuses an unauthenticated call,
 * which is the observable proof that authorization is switched on.
 *
 * What it does NOT establish: that the gateway has loaded THIS Agent's
 * specific policy. ToolHive reads its authorization config when a proxy starts
 * and exposes no API to introspect the running one, so no honest check exists;
 * the detail string says so rather than implying a guarantee.
 */
export class GatewayToolAccessVerifier implements ToolAccessVerifier {
  readonly #settings: GatewayToolAccessSettings;
  readonly #fetch: typeof fetch;

  constructor(settings: GatewayToolAccessSettings) {
    this.#settings = settings;
    this.#fetch = settings.fetchImplementation ?? fetch;
  }

  async verify(agent: SpecialistAgentConfig, _environment: string): Promise<SubsystemResult> {
    const approved = new Map(this.#settings.catalog.tools.map((tool) => [`${tool.serverId}:${tool.toolName}`, tool]));
    const servers = new Set<string>();
    for (const access of agent.spec.access ?? []) {
      servers.add(access.mcp);
      for (const toolName of access.tools) {
        const tool = approved.get(`${access.mcp}:${toolName}`);
        if (tool === undefined) return { ready: false, detail: `the Agent is granted ${access.mcp}:${toolName}, which the approved catalog does not contain` };
        if (tool.readOnlyVerified !== true) return { ready: false, detail: `${access.mcp}:${toolName} is not verified read-only in the approved catalog` };
      }
    }
    if (servers.size === 0) return { ready: false, detail: "the Agent is granted no tool servers, so it can establish nothing" };

    const unreachable: string[] = [];
    const unprotected: string[] = [];
    await Promise.all([...servers].map(async (server) => {
      const endpoint = this.#settings.endpoints.get(server);
      if (endpoint === undefined) { unreachable.push(`${server} (no endpoint configured)`); return; }
      try {
        // no credential deliberately: a gateway that ANSWERS an unauthenticated
        // call is not enforcing the policy this attestation is about
        const response = await this.#fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (response.status !== 401 && response.status !== 403) unprotected.push(`${server} (answered ${response.status} unauthenticated)`);
      } catch (error) {
        unreachable.push(`${server} (${error instanceof Error ? error.message : String(error)})`);
      }
    }));

    if (unreachable.length > 0) return { ready: false, detail: `tool gateway not reachable: ${unreachable.join(", ")}` };
    if (unprotected.length > 0) return { ready: false, detail: `tool gateway is not enforcing authorization: ${unprotected.join(", ")}` };
    /*
     * WHAT THIS COULD NOT CHECK DECIDES THE ANSWER.
     *
     * Everything above is real: every grant is in the approved catalog and
     * read-only verified, and every gateway refused an unauthenticated call.
     * None of it shows which per-Agent policy the proxy actually holds, and
     * ToolHive exposes no way to ask.
     *
     * This used to return ready:true and say so in the detail. But `ready`
     * drives routing, and the operational plane exists so that disabling an
     * Agent revokes its ACCESS as well as its routing — a property this
     * verifier cannot observe. Attesting to it anyway is the one thing an
     * attestation must never do, so the default is now closed and an operator
     * who accepts the weaker basis records that acceptance here.
     */
    const verified = `every granted tool is approved and read-only verified, and ${servers.size} gateway(s) refused an unauthenticated call`;
    if (this.#settings.acceptUnintrospectablePolicy !== true) {
      return {
        ready: false,
        detail: `${verified}, but the per-Agent policy loaded in the gateway cannot be introspected, so revocation cannot be confirmed; set acceptUnintrospectablePolicy to attest on the weaker basis`,
      };
    }
    return {
      ready: true,
      detail: `${verified}; the loaded per-Agent policy was not introspectable and this weaker basis was explicitly accepted`,
    };
  }
}
