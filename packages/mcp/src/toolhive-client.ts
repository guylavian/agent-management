import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestIdentity } from "@sre/auth";

export interface McpTool {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolInvocation {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  environment: string;
  requestId: string;
  identity: RequestIdentity;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: unknown;
  isError?: boolean;
  observedAt: string;
}

export interface AuditEvent {
  requestId: string;
  subject: string;
  serverId: string;
  toolName: string;
  decision: "allowed" | "denied";
  backendCalled: boolean;
}

export interface ToolHiveClient {
  readonly mode: "mock" | "real";
  listTools(serverId: string, identity: RequestIdentity, environment: string): Promise<McpTool[]>;
  invoke(call: ToolInvocation): Promise<ToolResult>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

export const MOCK_TOOLS: McpTool[] = [
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
];

export class MockToolHiveClient implements ToolHiveClient {
  readonly mode = "mock" as const;
  readonly audit: AuditEvent[] = [];
  readonly backendCalls: ToolInvocation[] = [];

  async listTools(serverId: string, identity: RequestIdentity, _environment: string): Promise<McpTool[]> {
    return MOCK_TOOLS.filter((tool) => tool.serverId === serverId && canUse(identity, tool.name));
  }

  async invoke(call: ToolInvocation): Promise<ToolResult> {
    const allowed = canUse(call.identity, call.toolName) && MOCK_TOOLS.some((tool) => tool.serverId === call.serverId && tool.name === call.toolName) && call.arguments.mode !== "denied";
    this.audit.push({ requestId: call.requestId, subject: call.identity.subject, serverId: call.serverId, toolName: call.toolName, decision: allowed ? "allowed" : "denied", backendCalled: allowed });
    if (!allowed) throw Object.assign(new Error("tool access denied"), { code: "TOOL_DENIED" });
    this.backendCalls.push(call);
    if (call.arguments.mode === "timeout") await new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("mock timeout"), { code: "MCP_TIMEOUT" })), Math.min(call.timeoutMs + 5, 50));
      call.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(call.signal?.reason); }, { once: true });
    });
    if (call.arguments.mode === "failure") throw Object.assign(new Error("mock backend failure"), { code: "TOOL_FAILED" });
    if (call.arguments.mode === "empty") return { content: [], observedAt: new Date().toISOString() };
    return { content: cannedResult(call), observedAt: new Date().toISOString() };
  }
}

export class RealToolHiveClient implements ToolHiveClient {
  readonly mode = "real" as const;
  readonly baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl; }
  async listTools(serverId: string, identity: RequestIdentity, environment: string): Promise<McpTool[]> {
    const client = await this.#connect(serverId, identity, environment, identity.requestId);
    try {
      const result = await client.listTools();
      return result.tools.map((tool) => ({ serverId, name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema as Record<string, unknown> }));
    } finally { await client.close(); }
  }
  async invoke(call: ToolInvocation): Promise<ToolResult> {
    const client = await this.#connect(call.serverId, call.identity, call.environment, call.requestId);
    try {
      const result = await client.callTool({ name: call.toolName, arguments: call.arguments });
      return { content: result.content, isError: result.isError === true, observedAt: new Date().toISOString() };
    } finally { await client.close(); }
  }
  async #connect(serverId: string, identity: RequestIdentity, environment: string, requestId: string): Promise<Client> {
    const client = new Client({ name: "sre-agent-runtime", version: "0.1.0" });
    const url = new URL(`/mcp/${encodeURIComponent(serverId)}`, this.baseUrl);
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { "x-request-id": requestId, "x-effective-subject": identity.subject, "x-sre-environment": environment } } });
    await client.connect(transport);
    return client;
  }
}

function canUse(identity: RequestIdentity, toolName: string): boolean {
  if (identity.roles.includes("infra-read")) return true;
  return identity.roles.includes("network-read") && ["query_prometheus", "search_network_logs", "get_interface_status", "get_path_health", "get_bgp_status", "get_load_balancer_pool"].includes(toolName);
}

function cannedResult(call: ToolInvocation): unknown {
  const entity = Object.values(call.arguments).find((value) => typeof value === "string" && !["ok", "failure"].includes(value));
  if (call.toolName === "get_replication_status") return { sourceDc: call.arguments.sourceDc ?? "DC-TLV-01", targetDc: call.arguments.targetDc ?? "DC-HFA-02", failures: 0, largestDeltaSeconds: 42, state: "healthy" };
  if (call.toolName.includes("pod")) return { namespace: call.arguments.namespace, pod: call.arguments.pod ?? "payments-api-0", phase: "Running", restarts: 0 };
  if (call.toolName.includes("prometheus") || call.toolName.includes("metrics")) return { query: call.arguments.query, samples: [{ value: 0.12, labels: { environment: call.environment } }] };
  return { entity: entity ?? "default", state: "healthy", tool: call.toolName, environment: call.environment };
}
