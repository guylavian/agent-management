import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ListToolsOptions, Principal, ToolCallRequest, ToolCallResult, ToolCredential, ToolDescriptor, ToolProvider } from "@sre/agent-engine";
import { toolCredentialSchema, type ToolCredentialVerifier } from "@sre/auth";
import { toolHiveAudience as canonicalAudience } from "@sre/config";

/**
 * ToolHive as the engine's ToolProvider.
 *
 * The engine asks for tools; this decides that "tools" means MCP servers behind
 * a ToolHive gateway, that discovery and invocation both carry a verified
 * delegated credential, and that the credential is a bearer token on an HTTP
 * request. None of that reaches the engine.
 */

/** A ToolProvider that also declares whether it is backed by a real gateway. */
export interface ToolHiveClient extends ToolProvider {
  readonly mode: "mock" | "real";
}

// the audience derivation is canonical in @sre/agent-schema so runtime, portal,
// Keycloak provisioning and ToolHive cannot disagree about it
export { toolHiveAudience } from "@sre/config";

export interface AuditEvent {
  requestId: string;
  subject: string;
  serverId: string;
  toolName: string;
  decision: "allowed" | "denied";
  backendCalled: boolean;
  /** Agent workload that executed the call, from the verified credential — TDD §13 */
  workloadClientId?: string;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

export const MOCK_TOOLS: ToolDescriptor[] = [
  { serverId: "active-directory", name: "get_replication_status", description: "Read AD replication health", inputSchema: objectSchema({ sourceDc: { type: "string" }, targetDc: { type: "string" }, mode: { type: "string", enum: ["ok", "failure", "timeout", "denied", "empty"] } }) },
  { serverId: "active-directory", name: "get_dc_health", description: "Read domain controller health", inputSchema: objectSchema({ dc: { type: "string" }, mode: { type: "string" } }, ["dc"]) },
  { serverId: "active-directory", name: "list_domain_controllers", description: "List domain controllers", inputSchema: objectSchema({ site: { type: "string" }, mode: { type: "string" } }) },
  { serverId: "active-directory", name: "get_dns_health", description: "Read AD-integrated DNS health", inputSchema: objectSchema({ dc: { type: "string" }, mode: { type: "string" } }) },
  { serverId: "splunk", name: "search_ad_events", description: "Search read-only AD events", inputSchema: objectSchema({ query: { type: "string" }, mode: { type: "string" } }, ["query"]) },
  { serverId: "prometheus", name: "query_ad_metrics", description: "Query AD metrics", inputSchema: objectSchema({ query: { type: "string" }, mode: { type: "string" } }, ["query"]) },
  { serverId: "openshift", name: "get_pod_status", description: "Read pod status", inputSchema: objectSchema({ namespace: { type: "string" }, pod: { type: "string" }, mode: { type: "string" } }, ["namespace"]) },
  { serverId: "openshift", name: "list_namespace_events", description: "Read namespace events", inputSchema: objectSchema({ namespace: { type: "string" }, mode: { type: "string" } }, ["namespace"]) },
  { serverId: "openshift", name: "get_route_status", description: "Read route status", inputSchema: objectSchema({ namespace: { type: "string" }, route: { type: "string" }, mode: { type: "string" } }, ["namespace"]) },
  { serverId: "openshift", name: "get_deployment_status", description: "Read deployment status", inputSchema: objectSchema({ namespace: { type: "string" }, deployment: { type: "string" }, mode: { type: "string" } }, ["namespace"]) },
  { serverId: "prometheus", name: "query_cluster_metrics", description: "Query cluster metrics", inputSchema: objectSchema({ query: { type: "string" }, mode: { type: "string" } }, ["query"]) },
  { serverId: "splunk", name: "search_platform_logs", description: "Search platform logs", inputSchema: objectSchema({ query: { type: "string" }, mode: { type: "string" } }, ["query"]) },
  { serverId: "prometheus", name: "query_prometheus", description: "Execute a read-only PromQL query", inputSchema: objectSchema({ query: { type: "string" }, mode: { type: "string" } }, ["query"]) },
  { serverId: "network", name: "get_interface_status", description: "Read interface counters", inputSchema: objectSchema({ device: { type: "string" }, interface: { type: "string" }, mode: { type: "string" } }, ["device"]) },
  { serverId: "network", name: "get_path_health", description: "Read path reachability", inputSchema: objectSchema({ source: { type: "string" }, target: { type: "string" }, mode: { type: "string" } }, ["target"]) },
  { serverId: "network", name: "get_bgp_status", description: "Read BGP neighbor state", inputSchema: objectSchema({ device: { type: "string" }, mode: { type: "string" } }, ["device"]) },
  { serverId: "splunk", name: "search_network_logs", description: "Search network logs", inputSchema: objectSchema({ query: { type: "string" }, mode: { type: "string" } }, ["query"]) },
  { serverId: "network", name: "get_load_balancer_pool", description: "Read load balancer pool state", inputSchema: objectSchema({ pool: { type: "string" }, mode: { type: "string" } }, ["pool"]) },
  { serverId: "keycloak", name: "keycloak_health", description: "Read Keycloak connectivity and visible realms", inputSchema: objectSchema({ mode: { type: "string" } }) },
  { serverId: "keycloak", name: "list_realms", description: "List Keycloak realms", inputSchema: objectSchema({ mode: { type: "string" } }) },
  { serverId: "keycloak", name: "list_clients", description: "List clients in a Keycloak realm", inputSchema: objectSchema({ realm: { type: "string" }, mode: { type: "string" } }) },
  { serverId: "keycloak", name: "find_user", description: "Find a user in a Keycloak realm", inputSchema: objectSchema({ realm: { type: "string" }, username: { type: "string" }, mode: { type: "string" } }, ["username"]) },
  { serverId: "keycloak", name: "keycloak_read", description: "Run a read-only Keycloak Admin API operation", inputSchema: objectSchema({ operation: { type: "string" }, mode: { type: "string" } }, ["operation"]) },
  { serverId: "wiki", name: "wiki_search", description: "Top-k internal wiki reference-note hits for a domain", inputSchema: objectSchema({ domain: { type: "string" }, q: { type: "string" }, k: { type: "integer" }, mode: { type: "string" } }, ["domain", "q"]) },
  { serverId: "wiki", name: "wiki_read_page", description: "Read an internal wiki page/note by slug", inputSchema: objectSchema({ slug: { type: "string" }, offset: { type: "integer" }, mode: { type: "string" } }, ["slug"]) },
  { serverId: "wiki", name: "wiki_route", description: "Route a query to its likely wiki domain(s)", inputSchema: objectSchema({ q: { type: "string" }, mode: { type: "string" } }, ["q"]) },
];

export class MockToolHiveClient implements ToolHiveClient {
  readonly mode = "mock" as const;
  readonly audit: AuditEvent[] = [];
  readonly backendCalls: ToolCallRequest[] = [];
  readonly #verifier?: ToolCredentialVerifier;

  /**
   * When a verifier is supplied the gateway derives the effective principal
   * from the presented credential (Gate #1), never from a caller-supplied
   * header. Without one it authorizes from the invocation identity — used only
   * by narrow unit tests that do not exercise the credential path.
   */
  constructor(verifier?: ToolCredentialVerifier) {
    this.#verifier = verifier;
  }

  async listTools(serverId: string, principal: Principal, _environment: string): Promise<ToolDescriptor[]> {
    return MOCK_TOOLS.filter((tool) => tool.serverId === serverId && canUse(principal, tool.name));
  }

  async invoke(call: ToolCallRequest): Promise<ToolCallResult> {
    // effective principal comes from the verified credential when a verifier is configured
    let principalSubject = call.principal.subject;
    let principalRoles = call.principal.roles;
    let workloadClientId: string | undefined;
    if (this.#verifier !== undefined) {
      try {
        const verified = await this.#verifier.verify(toolCredentialSchema.parse(requireCredential(call)), canonicalAudience(call.serverId), call.requestId);
        principalSubject = verified.subject;
        principalRoles = verified.roles;
        workloadClientId = verified.workloadClientId;
      } catch {
        this.audit.push({ requestId: call.requestId, subject: call.credential?.subjectHash ?? "unverified", serverId: call.serverId, toolName: call.toolName, decision: "denied", backendCalled: false });
        throw Object.assign(new Error("tool access denied"), { code: "TOOL_DENIED" });
      }
    }
    const allowed = canUse({ ...call.principal, subject: principalSubject, roles: principalRoles }, call.toolName) && MOCK_TOOLS.some((tool) => tool.serverId === call.serverId && tool.name === call.toolName) && call.arguments.mode !== "denied";
    this.audit.push({ requestId: call.requestId, subject: principalSubject, serverId: call.serverId, toolName: call.toolName, decision: allowed ? "allowed" : "denied", backendCalled: allowed, ...(workloadClientId ? { workloadClientId } : {}) });
    if (!allowed) throw Object.assign(new Error("tool access denied"), { code: "TOOL_DENIED" });
    this.backendCalls.push(call);
    if (call.arguments.mode === "timeout") await new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("mock timeout"), { code: "TOOL_TIMEOUT" })), Math.min(call.timeoutMs + 5, 50));
      call.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(call.signal?.reason); }, { once: true });
    });
    if (call.arguments.mode === "failure") throw Object.assign(new Error("mock backend failure"), { code: "TOOL_FAILED" });
    if (call.arguments.mode === "empty") return { content: [], observedAt: new Date().toISOString() };
    return { content: cannedResult(call), observedAt: new Date().toISOString() };
  }
}

export class RealToolHiveClient implements ToolHiveClient {
  readonly mode = "real" as const;
  readonly baseUrl?: string;
  readonly #endpoints: ReadonlyMap<string, string>;
  constructor(baseUrl?: string, endpoints: Record<string, string> = {}) {
    if (baseUrl === undefined && Object.keys(endpoints).length === 0) throw new Error("real ToolHive requires a gateway URL or per-server proxy endpoints");
    this.baseUrl = baseUrl;
    this.#endpoints = new Map(Object.entries(endpoints));
  }
  async invoke(call: ToolCallRequest): Promise<ToolCallResult> {
    const client = await this.#connect(call.serverId, requireCredential(call), call.environment, call.requestId, call.signal);
    try {
      // the MCP SDK forwards this AbortSignal to the underlying HTTP request, so a
      // client disconnect or deadline cancels the in-flight backend call
      const result = await client.callTool({ name: call.toolName, arguments: call.arguments }, undefined, call.signal ? { signal: call.signal, timeout: call.timeoutMs } : { timeout: call.timeoutMs });
      return { content: result.content, isError: result.isError === true, observedAt: new Date().toISOString() };
    } finally { await client.close(); }
  }
  async #connect(serverId: string, credential: ToolCredential, environment: string, requestId: string, signal?: AbortSignal): Promise<Client> {
    const client = new Client({ name: "sre-agent-runtime", version: "0.1.0" });
    const configured = this.#endpoints.get(serverId);
    const url = configured ? new URL(configured) : new URL(`/mcp/${encodeURIComponent(serverId)}`, this.baseUrl as string);
    // ToolHive verifies this bearer credential itself and derives the effective human;
    // no unsigned identity header is sent.
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { "x-request-id": requestId, authorization: `Bearer ${credential.token}`, "x-sre-environment": environment }, ...(signal ? { signal } : {}) } });
    await client.connect(transport);
    return client;
  }
  async listTools(serverId: string, principal: Principal, environment: string, options: ListToolsOptions = {}): Promise<ToolDescriptor[]> {
    const credential = options.credential;
    if (credential === undefined) throw Object.assign(new Error("verified ToolHive credential is required for discovery"), { code: "TOOL_DENIED" });
    const client = await this.#connect(serverId, credential, environment, options.requestId ?? principal.requestId, options.signal);
    try {
      const result = await client.listTools(undefined, options.signal ? { signal: options.signal } : undefined);
      return result.tools.map((tool) => ({
        serverId,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
        ...(tool.annotations ? { annotations: { readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.destructiveHint } } : {}),
      }));
    } finally {
      await client.close();
    }
  }
}

function requireCredential(call: ToolCallRequest): ToolCredential {
  if (call.credential === undefined) throw Object.assign(new Error("tool credential missing"), { code: "TOOL_DENIED" });
  return call.credential;
}

function canUse(principal: Principal, toolName: string): boolean {
  if (principal.roles.includes("infra-read")) return true;
  return principal.roles.includes("network-read") && ["query_prometheus", "search_network_logs", "get_interface_status", "get_path_health", "get_bgp_status", "get_load_balancer_pool"].includes(toolName);
}

function cannedResult(call: ToolCallRequest): unknown {
  const entity = Object.values(call.arguments).find((value) => typeof value === "string" && !["ok", "failure"].includes(value));
  if (call.toolName === "keycloak_health") return { url: "https://keycloak.sre.local", auth_realm: "sre-test", visible_realms: ["sre-test"], read_operations: 148 };
  if (call.toolName === "list_realms") return [{ realm: "master" }, { realm: "sre-test" }];
  if (call.toolName === "list_clients") return [{ clientId: "sre-test-client", enabled: true }, { clientId: "account", enabled: true }];
  if (call.toolName === "find_user") return { username: call.arguments.username ?? "sre-test-user", enabled: true, realm: call.arguments.realm ?? "sre-test" };
  if (call.toolName === "keycloak_read") return { operation: call.arguments.operation, ok: true };
  if (call.toolName === "wiki_route") return { domains: ["keycloak"], confident: true };
  if (call.toolName === "wiki_search") return [{ id: "kc-login-troubleshooting", title: "Keycloak login failure troubleshooting", score: 0.91, snippet: "Documented procedure: check clock skew, LDAP federation, and realm event logs.", updatedAt: "2026-02-10" }];
  if (call.toolName === "wiki_read_page") return { slug: call.arguments.slug ?? "kc-login-troubleshooting", title: "Keycloak login failure troubleshooting", version: "3", updatedAt: "2026-02-10", body: "Documented steps: 1) verify clock skew, 2) check LDAP federation, 3) review realm login events." };
  if (call.toolName === "get_replication_status") return { sourceDc: call.arguments.sourceDc ?? "DC-TLV-01", targetDc: call.arguments.targetDc ?? "DC-HFA-02", failures: 0, largestDeltaSeconds: 42, state: "healthy" };
  if (call.toolName.includes("pod")) return { namespace: call.arguments.namespace, pod: call.arguments.pod ?? "payments-api-0", phase: "Running", restarts: 0 };
  if (call.toolName.includes("prometheus") || call.toolName.includes("metrics")) return { query: call.arguments.query, samples: [{ value: 0.12, labels: { environment: call.environment } }] };
  return { entity: entity ?? "default", state: "healthy", tool: call.toolName, environment: call.environment };
}
