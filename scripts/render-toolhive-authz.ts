import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { agentDocumentSchema, audienceFor, type AgentDocument, type SpecialistSpec } from "@sre/agent-schema";
import { CONFIG_PATHS, isAgentEnabled, loadApprovedCatalog, loadDeploymentEnvironment } from "@sre/config";

/**
 * Agent → MCP → tool access, rendered as ToolHive authorization policy.
 *
 * ToolHive 0.46 authorizes with Cedar (`--authz-config`) and derives the
 * principal from the token's `sub`, but exposes every JWT claim as
 * `principal.claim_<name>`. Our tool credential carries the HUMAN in `sub` and
 * the Agent workload in `azp` (RFC 8693 §4.1), so the Agent-scoped rule is
 * expressed on `claim_azp`:
 *
 *   permit(principal, action == Action::"call_tool", resource == Tool::"list_realms")
 *     when { principal.claim_azp == "sre-agent-keycloak" };
 *
 * Cedar is default-deny, so a tool with no permit statement is refused at the
 * gateway — and a disabled Agent emits no statements at all.
 *
 * WHAT THIS DOES NOT DO — see docs/INTEGRATION-POINTS.md:
 * ToolHive reads this file when a proxy STARTS. There is no API in 0.46 to
 * reconcile the authorization policy of a running proxy, so applying a change
 * means restarting that proxy. This renders the desired state; it does not
 * claim to converge a live one.
 *
 * This never creates a proxy. One MCP server has one ToolHive proxy; Agent
 * access is a policy ON it, not a second copy of it.
 */

interface AgentGrant {
  workloadClientId: string;
  agentId: string;
  tools: string[];
  audience: string;
}

function canonicalAgents(): AgentDocument[] {
  return readdirSync(CONFIG_PATHS.agentsDir)
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => agentDocumentSchema.parse(parseYaml(readFileSync(join(CONFIG_PATHS.agentsDir, file), "utf8"))));
}

/** Cedar string literals must not be able to break out of the quotes they sit in. */
function cedarString(value: string): string {
  if (!/^[A-Za-z0-9:_.@-]+$/u.test(value)) throw new Error(`refusing to render an unexpected identifier into a Cedar policy: ${value}`);
  return `"${value}"`;
}

export function grantsByServer(environment: string): Map<string, AgentGrant[]> {
  const state = loadDeploymentEnvironment(`deploy/environments/${environment}`);
  const byServer = new Map<string, AgentGrant[]>();
  for (const doc of canonicalAgents()) {
    if (doc.spec.type !== "specialist") continue;
    const spec: SpecialistSpec = doc.spec;
    // an Agent that is not active, or not deployed here, gets no grant at all —
    // absence of a permit is the denial, which is what default-deny buys us
    if (!isAgentEnabled(spec)) continue;
    if (state.overlays.get(doc.metadata.name)?.enabled !== true) continue;
    for (const entry of spec.access) {
      const audience = audienceFor(spec, entry.mcp);
      if (audience === undefined) continue;
      const grants = byServer.get(entry.mcp) ?? [];
      grants.push({ workloadClientId: spec.identity.clientId, agentId: doc.metadata.name, tools: [...entry.tools].sort(), audience });
      byServer.set(entry.mcp, grants);
    }
  }
  return byServer;
}

export function renderAuthzConfig(serverId: string, grants: AgentGrant[], approvedTools: Set<string>): string {
  const policies: string[] = [];
  for (const grant of [...grants].sort((left, right) => left.agentId.localeCompare(right.agentId))) {
    for (const tool of grant.tools) {
      // the approved catalog is the outer bound; an Agent cannot be granted a
      // tool the platform never approved, even if its YAML asked for one
      if (!approvedTools.has(tool)) throw new Error(`${serverId}: agent ${grant.agentId} requests unapproved tool ${tool}`);
      policies.push(
        `permit(principal, action == Action::${cedarString("call_tool")}, resource == Tool::${cedarString(tool)}) when { principal.claim_azp == ${cedarString(grant.workloadClientId)} };`,
      );
    }
  }

  const header = [
    "# GENERATED FILE — DO NOT EDIT.",
    "# Produced by `npm run render:toolhive` from config/agents/*.yaml intersected",
    `# with deploy/environments/<env>. Cedar is default-deny: a tool with no`,
    "# permit below is refused by the gateway, and a disabled Agent has none.",
    "#",
    `# MCP server: ${serverId}`,
    ...(grants.length === 0
      ? ["# No Agent is granted access to this server in this environment."]
      : grants.map((grant) => `#   ${grant.agentId} (${grant.workloadClientId}) -> ${grant.tools.length} tool(s), aud ${grant.audience}`)),
  ].join("\n");

  const body = policies.length === 0
    ? 'version: "1.0"\ntype: cedarv1\ncedar:\n  policies: []\n  entities_json: "[]"\n'
    : `version: "1.0"\ntype: cedarv1\ncedar:\n  policies:\n${policies.map((policy) => `    - '${policy}'`).join("\n")}\n  entities_json: "[]"\n`;

  return `${header}\n${body}`;
}

export function render(environments: string[] = readdirSync("deploy/environments").sort()): string[] {
  const catalog = loadApprovedCatalog(CONFIG_PATHS.mcpServersDir);
  const written: string[] = [];

  for (const environment of environments) {
    const outputDir = join("deploy/environments", environment, "rendered", "toolhive");
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });

    const grants = grantsByServer(environment);
    // every approved server gets a file, including ones nobody may reach here:
    // an empty policy set is an explicit denial, not a missing configuration
    for (const serverId of [...new Set(catalog.tools.map((tool) => tool.serverId))].sort()) {
      const approved = new Set(catalog.tools.filter((tool) => tool.serverId === serverId).map((tool) => tool.toolName));
      const file = join(outputDir, `${serverId}.authz.yaml`);
      writeFileSync(file, renderAuthzConfig(serverId, grants.get(serverId) ?? [], approved), "utf8");
      written.push(file);
    }
  }
  return written;
}

if (process.argv[1]?.endsWith("render-toolhive-authz.ts")) {
  const written = render();
  for (const file of written) console.log(`rendered ${file}`);
  console.log(`rendered ${written.length} ToolHive authorization policy file(s)`);
}
