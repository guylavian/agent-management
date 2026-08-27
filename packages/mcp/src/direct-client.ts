import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestIdentity } from "@sre/auth";
import type { McpTool, ToolHiveClient, ToolInvocation, ToolResult } from "./toolhive-client.ts";

/**
 * LOCAL-DEV-ONLY MCP client. Reaches standalone MCP servers directly by a
 * per-server endpoint map, over Streamable HTTP, when no ToolHive gateway is
 * available locally. It is NOT the production path — production routes through
 * ToolHive (RealToolHiveClient). Read/query only; it registers no write tools.
 *
 * Endpoints come from config (SRE_MCP_ENDPOINT_<SERVER>), never hardcoded.
 */
export class DirectMcpClient implements ToolHiveClient {
  readonly mode = "real" as const;
  readonly #endpoints: ReadonlyMap<string, string>;

  constructor(endpoints: Record<string, string>) {
    this.#endpoints = new Map(Object.entries(endpoints));
  }

  #endpointFor(serverId: string): string {
    const endpoint = this.#endpoints.get(serverId);
    if (endpoint === undefined) throw Object.assign(new Error(`no direct MCP endpoint configured for server ${serverId}`), { code: "MCP_UNAVAILABLE" });
    return endpoint;
  }

  async listTools(serverId: string, identity: RequestIdentity, _environment: string): Promise<McpTool[]> {
    const client = await this.#connect(serverId, identity.requestId);
    try {
      const result = await client.listTools();
      return result.tools.map((tool) => ({ serverId, name: tool.name, description: tool.description ?? "", inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object" } }));
    } finally {
      await client.close();
    }
  }

  async invoke(call: ToolInvocation): Promise<ToolResult> {
    const client = await this.#connect(call.serverId, call.requestId, call.signal);
    try {
      const result = await client.callTool(
        { name: call.toolName, arguments: call.arguments },
        undefined,
        call.signal ? { signal: call.signal, timeout: call.timeoutMs } : { timeout: call.timeoutMs },
      );
      return { content: result.content, isError: result.isError === true, observedAt: new Date().toISOString() };
    } finally {
      await client.close();
    }
  }

  async #connect(serverId: string, requestId: string, signal?: AbortSignal): Promise<Client> {
    const client = new Client({ name: "sre-agent-runtime", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.#endpointFor(serverId)), {
      requestInit: { headers: { "x-request-id": requestId }, ...(signal ? { signal } : {}) },
    });
    await client.connect(transport);
    return client;
  }
}

/** Parse SRE_MCP_ENDPOINT_<SERVER> env vars into a serverId -> endpoint map. */
export function mcpEndpointsFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^SRE_MCP_ENDPOINT_(.+)$/u);
    if (match?.[1] !== undefined && value) out[match[1].toLowerCase().replace(/_/gu, "-")] = value;
  }
  return out;
}
