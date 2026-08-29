import type { AgentDefinition, CredentialProvider, Sanitizer, SpanAttributes, Telemetry, ToolPolicy } from "@sre/agent-engine";
import { workloadIdentitySchema, type RequestIdentity, type ToolCredentialExchanger } from "@sre/auth";
import { accessServers, audienceFor, isAgentEnabled, type ApprovedCatalog, type SpecialistAgentConfig } from "@sre/config";
import { redactEvidence, redactText } from "@sre/redaction";
import { incrementMetric, withSpan } from "@sre/telemetry";

/**
 * THE PLATFORM → ENGINE ADAPTERS.
 *
 * The engine defines ports in its own vocabulary and knows nothing about this
 * platform. Everything that translates between the two lives here, at the
 * composition root, so that a change to either side is a change to this file
 * rather than to the other side.
 *
 * These adapters carry no policy. Each one is a projection or a rename: the
 * Agent document onto the engine's AgentDefinition, this platform's redaction
 * onto the Sanitizer port, its OpenTelemetry helpers onto the Telemetry port.
 * Every security DECISION stays where it is enforced — in the engine's
 * guardrails, or in the configuration this maps from.
 */

/**
 * The canonical Agent document projected onto what the engine needs.
 *
 * The projection is lossy on purpose. Routing, capabilities, cross-domain
 * policy and ownership are not passed through, because the engine cannot use
 * them and must not be able to read them.
 */
export function toAgentDefinition(agent: SpecialistAgentConfig): AgentDefinition {
  return {
    id: agent.name,
    systemPrompt: agent.systemPrompt,
    modelProfile: agent.spec.model.profile,
    budgets: agent.spec.execution,
    access: accessServers(agent.spec).map((server) => {
      const audience = audienceFor(agent.spec, server);
      return {
        server,
        tools: agent.spec.access.find((entry) => entry.mcp === server)?.tools ?? [],
        ...(audience ? { audience } : {}),
      };
    }),
    // lifecycle collapses to a boolean here; only "active" may execute
    enabled: isAgentEnabled(agent.spec),
    requiredRoles: agent.spec.authorization.requiredRoles,
    readOnly: agent.spec.security.readOnly,
    workload: { clientId: agent.spec.identity.clientId, provider: agent.spec.identity.provider },
    lifecycleLabel: agent.spec.lifecycle,
  };
}

/** The approved catalog is already the engine's ToolPolicy shape; this names the fact. */
export function toToolPolicy(catalog: ApprovedCatalog): ToolPolicy {
  return { tools: catalog.tools };
}

/** This platform's deterministic redaction, as the engine's required Sanitizer. */
export const platformSanitizer: Sanitizer = {
  text: redactText,
  evidence: redactEvidence,
};

/**
 * Engine span and metric names mapped onto the platform's TDD §25/§26 names.
 *
 * The engine emits names in its own vocabulary — it must not know that this
 * platform calls its tool gateway ToolHive. The dashboards, alerts and span
 * assertions that already exist keep working because the translation happens
 * here rather than by making the engine speak the platform's dialect.
 */
const SPAN_PREFIXES: Array<[string, string]> = [
  ["tool.call.", "toolhive.call."],
  ["model.turn.", "llm.specialist."],
];

const ATTRIBUTE_NAMES: Record<string, string> = {
  "tool.server": "mcp.server",
  "tool.name": "mcp.tool",
};

const METRIC_NAMES: Record<string, string> = {
  "agent.invocations": "sre_specialist_invocations_total",
  "tool.calls": "sre_tool_calls_total",
  "tool.arguments.invalid": "sre_invalid_tool_arguments_total",
};

export const platformTelemetry: Telemetry = {
  async span(name, attributes, action) {
    const mapped = SPAN_PREFIXES.find(([prefix]) => name.startsWith(prefix));
    const spanName = mapped ? `${mapped[1]}${name.slice(mapped[0].length)}` : name;
    const renamed: SpanAttributes = {};
    for (const [key, value] of Object.entries(attributes)) renamed[ATTRIBUTE_NAMES[key] ?? key] = value;
    return withSpan(spanName, renamed, action);
  },
  counter(name, value = 1) {
    const mapped = METRIC_NAMES[name];
    // an unmapped counter is dropped rather than published under an engine-shaped
    // name, so the metric surface stays exactly the documented one
    if (mapped !== undefined) incrementMetric(mapped, value);
  },
};

/**
 * This platform's RFC 8693 token exchange, as the engine's CredentialProvider.
 *
 * The engine hands back the workload it was configured with and the delegated
 * principal; the exchange itself, the client secret and the token never enter
 * engine code.
 */
export function toCredentialProvider(exchanger: ToolCredentialExchanger): CredentialProvider {
  return {
    async exchange(workload, principal, audience, deadline) {
      if (workload === undefined) throw Object.assign(new Error("Tool access denied"), { code: "TOOL_DENIED" });
      const identity: RequestIdentity = { subject: principal.subject, groups: principal.groups ?? [], roles: principal.roles, requestId: principal.requestId, ...(principal.sessionId ? { sessionId: principal.sessionId } : {}) };
      // validated, not cast: an engine-shaped workload that is not a valid
      // platform workload identity fails here rather than reaching Keycloak
      return exchanger.exchange(workloadIdentitySchema.parse(workload), identity, audience, deadline);
    },
  };
}
