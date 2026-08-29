import { z } from "zod";
import { toolHiveAudience, workloadClientId } from "./identity.ts";

/**
 * THE canonical Agent definition — TDD §5 with the management-plane amendments.
 *
 * One schema is consumed by the runtime, the management portal, Git validation,
 * the tests and Keycloak provisioning. There is deliberately no second Agent
 * model anywhere: anything a component needs about an Agent is either a field
 * here or a pure derivation of one (see ./identity.ts).
 *
 * Every object is .strict(): unknown keys (loops, branches, expressions,
 * embedded code, workflow constructs) are rejected — TDD §5.3.
 *
 * Routing vocabulary (exact terms, entity patterns, capabilities, exclusions)
 * lives HERE, with the Agent it describes. It used to live in a separate
 * service registry that also carried endpoints and per-environment enablement,
 * which meant onboarding an Agent required editing two logical sources that
 * could disagree. Physical placement — where an Agent runs and whether it is
 * deployed in this environment — is a deployment concern and stays out of this
 * file entirely.
 */

export const EXECUTION_DEFAULTS = {
  maxToolCalls: 6,
  maxModelTurns: 3,
  timeoutMs: 25_000,
  maxEvidenceBytes: 262_144,
  maxContextTokens: 12_000,
  maxEvidenceItems: 32,
  maxRawExcerptBytes: 8_192,
} as const;

const agentName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "agent names are lowercase kebab-case");

/**
 * Explicit lifecycle — TDD §33. `active` is the only state that may route or
 * hold a usable workload credential; everything else fails closed in the
 * runtime and disables (never deletes) the Keycloak client.
 */
export const AGENT_LIFECYCLES = ["draft", "active", "disabled", "decommissioning", "removed"] as const;
export const agentLifecycleSchema = z.enum(AGENT_LIFECYCLES);
export type AgentLifecycle = z.infer<typeof agentLifecycleSchema>;

const specialistExecutionSchema = z
  .object({
    maxToolCalls: z.number().int().min(1).max(20).default(EXECUTION_DEFAULTS.maxToolCalls),
    maxModelTurns: z.number().int().min(1).max(10).default(EXECUTION_DEFAULTS.maxModelTurns),
    timeoutMs: z.number().int().min(1_000).max(180_000).default(EXECUTION_DEFAULTS.timeoutMs),
    maxEvidenceBytes: z.number().int().min(4_096).max(4_194_304).default(EXECUTION_DEFAULTS.maxEvidenceBytes),
    maxContextTokens: z.number().int().min(1_000).max(64_000).default(EXECUTION_DEFAULTS.maxContextTokens),
    maxEvidenceItems: z.number().int().min(1).max(128).default(EXECUTION_DEFAULTS.maxEvidenceItems),
    maxRawExcerptBytes: z.number().int().min(256).max(65_536).default(EXECUTION_DEFAULTS.maxRawExcerptBytes),
  })
  .strict();

export type SpecialistExecution = z.infer<typeof specialistExecutionSchema>;

/**
 * Workload identity — TDD §7/§8. Only the non-secret client identifier is ever
 * written to Git; a credential of any kind in this file is a validation error
 * (see assertNoSecretMaterial).
 */
const identitySchema = z
  .object({
    provider: z.literal("keycloak"),
    clientId: z.string().regex(/^sre-agent-[a-z][a-z0-9-]*$/, "workload client ids are sre-agent-<agent-name>"),
  })
  .strict();

export type AgentIdentity = z.infer<typeof identitySchema>;

/**
 * ONE canonical Agent → MCP → Tool policy — TDD §11. This single list drives
 * the runtime allowlist, the Keycloak authorization model and the ToolHive
 * audience, so the three can never disagree.
 *
 * `audience` is optional in YAML; when present it must equal the canonical
 * derivation, which turns a hand-edited audience into a validation failure
 * instead of a silent privilege change.
 */
const accessEntrySchema = z
  .object({
    mcp: z.string().min(1),
    audience: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type AgentAccessEntry = z.infer<typeof accessEntrySchema>;

/**
 * How the Manager decides this Agent is the right one. Precision matters more
 * than recall: `exactTerms` resolve routing on their own, `ambiguousTerms` are
 * documented specifically so they cannot, and `capabilities`/`exclusions` are
 * handed to the Manager model as descriptors rather than baked into a prompt.
 */
const routingSchema = z
  .object({
    // whole-phrase, case-insensitive terms that resolve to this agent (high precision)
    exactTerms: z.array(z.string().min(2)).default([]),
    // regexes (source strings) tested against the question; a match routes and yields an entity
    entityPatterns: z.array(z.string().min(1)).default([]),
    // overloaded terms that MUST NOT resolve routing on their own (precision guard, documentation)
    ambiguousTerms: z.array(z.string().min(1)).default([]),
    // free-text routing hints supplied to the Manager (what this specialist covers / does not)
    capabilities: z.array(z.string().min(1)).default([]),
    exclusions: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type AgentRouting = z.infer<typeof routingSchema>;

const ROUTING_DEFAULT: AgentRouting = { exactTerms: [], entityPatterns: [], ambiguousTerms: [], capabilities: [], exclusions: [] };

const specialistSpecSchema = z
  .object({
    type: z.literal("specialist"),
    lifecycle: agentLifecycleSchema.default("active"),
    model: z
      .object({
        tier: z.enum(["small", "large"]),
        profile: z.string().min(1),
      })
      .strict(),
    prompt: z.object({ systemFile: z.string().min(1) }).strict(),
    identity: identitySchema,
    // logical environments this Agent is defined for; whether it is DEPLOYED in
    // one of them is a deployment overlay decision, not a property of the Agent
    environments: z.array(z.string().min(1)).min(1),
    routing: routingSchema.default(ROUTING_DEFAULT),
    access: z.array(accessEntrySchema).min(1),
    execution: specialistExecutionSchema,
    discovery: z
      .object({
        allowedNeedsDomains: z.array(agentName),
      })
      .strict()
      .optional(),
    authorization: z
      .object({
        // every listed role is required (AND semantics)
        requiredRoles: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    security: z
      .object({
        // read-only is the only supported posture; a write agent is a red line, not a config value
        readOnly: z.literal(true),
      })
      .strict()
      .default({ readOnly: true }),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of spec.access.entries()) {
      if (seen.has(entry.mcp)) {
        ctx.addIssue({ code: "custom", path: ["access", index, "mcp"], message: `duplicate MCP "${entry.mcp}" in access policy` });
      }
      seen.add(entry.mcp);
      const canonical = toolHiveAudience(entry.mcp);
      if (entry.audience !== undefined && entry.audience !== canonical) {
        ctx.addIssue({ code: "custom", path: ["access", index, "audience"], message: `audience must be "${canonical}" for MCP "${entry.mcp}"` });
      }
      const tools = new Set<string>();
      for (const [toolIndex, tool] of entry.tools.entries()) {
        if (tools.has(tool)) {
          ctx.addIssue({ code: "custom", path: ["access", index, "tools", toolIndex], message: `duplicate tool "${tool}" for MCP "${entry.mcp}"` });
        }
        tools.add(tool);
      }
    }
  });

const managerSpecSchema = z
  .object({
    type: z.literal("manager"),
    lifecycle: agentLifecycleSchema.default("active"),
    model: z
      .object({
        tier: z.literal("small"),
        profile: z.string().min(1),
      })
      .strict(),
    prompt: z.object({ systemFile: z.string().min(1) }).strict(),
    agents: z.object({ allowed: z.array(agentName).min(1) }).strict(),
    execution: z
      .object({
        maxAgentsPerRequest: z.number().int().min(1).max(3),
        // Round 2 is a runtime feature, never a second Manager loop — TDD §5.1
        maxRounds: z.literal(1),
        timeoutMs: z.number().int().min(100).max(5_000),
      })
      .strict(),
    output: z.object({ schema: z.literal("ManagerDecision") }).strict(),
  })
  .strict();

export const agentDocumentSchema = z
  .object({
    apiVersion: z.literal("sre.ai/v1alpha1"),
    kind: z.literal("Agent"),
    metadata: z
      .object({
        name: agentName,
        owner: z.string().min(1),
        displayName: z.string().min(1).optional(),
        // shown to the Manager model as a routing descriptor and to the portal
        description: z.string().min(1).max(500).optional(),
        /**
         * PRESENTATION ONLY. The console renders it; the runtime reads nothing
         * from it, and an Agent without one is complete — the console falls
         * back to initials, which is why this is optional and stays optional.
         *
         * `asset` is a path INSIDE this repository, constrained by the pattern
         * to the two directories the platform manages. A URL cannot be written
         * here: rendering the console must not depend on a third party, and
         * which agents exist must not leak to whoever would host the image.
         */
        avatar: z
          .object({
            asset: z
              .string()
              .regex(/^assets\/(agents|icons)\/[a-z][a-z0-9-]*\.(png|jpg|webp)$/u, "must be a managed asset path under assets/agents or assets/icons"),
            // contain for a product logo, cover for an avatar-style image
            fit: z.enum(["cover", "contain"]).default("contain"),
          })
          .strict()
          .optional(),
      })
      .strict(),
    spec: z.discriminatedUnion("type", [managerSpecSchema, specialistSpecSchema]),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.spec.type !== "specialist") return;
    const expected = workloadClientId(doc.metadata.name);
    if (doc.spec.identity.clientId !== expected) {
      ctx.addIssue({ code: "custom", path: ["spec", "identity", "clientId"], message: `workload client id must be "${expected}" for agent "${doc.metadata.name}"` });
    }
    for (const [index, domain] of (doc.spec.discovery?.allowedNeedsDomains ?? []).entries()) {
      if (domain === doc.metadata.name) {
        ctx.addIssue({ code: "custom", path: ["spec", "discovery", "allowedNeedsDomains", index], message: "agent cannot discover itself" });
      }
    }
  });

export type AgentDocument = z.infer<typeof agentDocumentSchema>;
export type SpecialistSpec = Extract<AgentDocument["spec"], { type: "specialist" }>;
export type ManagerSpec = Extract<AgentDocument["spec"], { type: "manager" }>;

/** Presentation metadata, carried through so the console can render it. */
export interface AgentAvatar {
  asset: string;
  fit: "cover" | "contain";
}

export interface SpecialistAgentConfig {
  name: string;
  owner: string;
  displayName?: string;
  description?: string;
  avatar?: AgentAvatar;
  spec: SpecialistSpec;
  systemPrompt: string;
}

export interface ManagerAgentConfig {
  name: string;
  avatar?: AgentAvatar;
  owner: string;
  displayName?: string;
  description?: string;
  spec: ManagerSpec;
  systemPrompt: string;
}

/**
 * Secret material must never reach Git or the Backstage catalog — TDD §36.
 * Structural rejection: the schema has no field that could hold one, so any
 * key that looks like a credential fails config load rather than being ignored.
 */
// deliberately specific: it must catch credential fields without flagging
// legitimate limits such as maxContextTokens
const SECRET_KEY = /(secret|password|passwd|passphrase|credential|private[_-]?key|api[_-]?key|(?:access|refresh|id|bearer|auth)[_-]?token)/iu;

export function assertNoSecretMaterial(value: unknown, path = "spec"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`secret-like key "${path}.${key}" is not permitted in Agent configuration`);
    assertNoSecretMaterial(child, `${path}.${key}`);
  }
}

/** MCP servers this Agent may reach, derived from the canonical access policy. */
export function accessServers(spec: SpecialistSpec): string[] {
  return spec.access.map((entry) => entry.mcp);
}

/** Every tool name across all MCPs — use {@link isToolAllowed} for authorization. */
export function accessTools(spec: SpecialistSpec): string[] {
  return [...new Set(spec.access.flatMap((entry) => entry.tools))];
}

/**
 * Authoritative Agent → MCP → Tool check. Scoping is per MCP: a tool allowed on
 * one server is NOT thereby allowed on another that happens to expose the same
 * tool name.
 */
export function isToolAllowed(spec: SpecialistSpec, serverId: string, toolName: string): boolean {
  const entry = spec.access.find((item) => item.mcp === serverId);
  return entry !== undefined && entry.tools.includes(toolName);
}

/** Audience the credential for this Agent → MCP call must be bound to, or undefined when the MCP is not in policy. */
export function audienceFor(spec: SpecialistSpec, serverId: string): string | undefined {
  const entry = spec.access.find((item) => item.mcp === serverId);
  if (entry === undefined) return undefined;
  return entry.audience ?? toolHiveAudience(serverId);
}

/** Only an `active` Agent may route or obtain a workload credential — TDD §33/§34. */
export function isAgentEnabled(spec: { lifecycle: AgentLifecycle }): boolean {
  return spec.lifecycle === "active";
}

/** Approved tool catalog entry — TDD §12.1. */
export const approvedToolSchema = z
  .object({
    serverId: z.string().min(1),
    toolName: z.string().min(1),
    readOnlyVerified: z.literal(true), // fail closed: unverified tools cannot be approved
    owner: z.string().min(1),
    environments: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().min(100).max(30_000),
    retryPolicy: z.enum(["none", "transient-once"]),
    // Evidence.kind produced by this tool's results (default telemetry); knowledge tools use "wiki"
    evidenceKind: z.enum(["telemetry", "config", "wiki"]).default("telemetry"),
  })
  .strict();

export type ApprovedTool = z.infer<typeof approvedToolSchema>;

export const approvedCatalogSchema = z
  .object({
    apiVersion: z.literal("sre.ai/v1alpha1"),
    kind: z.literal("ApprovedToolCatalog"),
    tools: z.array(approvedToolSchema).min(1),
  })
  .strict();

export type ApprovedCatalog = z.infer<typeof approvedCatalogSchema>;

/**
 * ONE logical MCP server per file — TDD §12.1 expressed per server rather than
 * as a single flat catalog. `serverId` is stated once at the top instead of
 * repeated on every tool, which is what stops a tool being approved for the
 * wrong server by a copy-paste.
 */
export const mcpServerToolSchema = approvedToolSchema.omit({ serverId: true });
export type McpServerTool = z.infer<typeof mcpServerToolSchema>;

export const mcpServerDocumentSchema = z
  .object({
    apiVersion: z.literal("sre.ai/v1alpha1"),
    kind: z.literal("McpServer"),
    metadata: z
      .object({
        serverId: z.string().regex(/^[a-z][a-z0-9-]*$/u),
        owner: z.string().min(1),
        description: z.string().min(1).max(500),
      })
      .strict(),
    tools: z.array(mcpServerToolSchema).min(1),
  })
  .strict();

export type McpServerDocument = z.infer<typeof mcpServerDocumentSchema>;

/** Flatten per-server documents into the flat approved catalog the runtime enforces. */
export function toApprovedCatalog(servers: McpServerDocument[]): ApprovedCatalog {
  return approvedCatalogSchema.parse({
    apiVersion: "sre.ai/v1alpha1",
    kind: "ApprovedToolCatalog",
    tools: servers.flatMap((server) => server.tools.map((tool) => ({ ...tool, serverId: server.metadata.serverId }))),
  });
}

/**
 * LOGICAL model profiles. An Agent names a profile, never a provider or an
 * endpoint, so the same Agent definition deploys against Groq in the PoC and an
 * on-prem vLLM in production without being edited.
 */
export const modelProfilesSchema = z
  .object({
    apiVersion: z.literal("sre.ai/v1alpha1"),
    kind: z.literal("ModelProfiles"),
    profiles: z
      .array(
        z
          .object({
            id: z.string().min(1),
            tier: z.enum(["small", "large"]),
            description: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ModelProfiles = z.infer<typeof modelProfilesSchema>;

/**
 * Platform-wide tool policy. Read-only is already a schema literal on every
 * approved tool; this adds the name-shaped guard that used to live only in a
 * test, so a mutating-sounding tool cannot be approved by config alone.
 */
export const toolPolicySchema = z
  .object({
    apiVersion: z.literal("sre.ai/v1alpha1"),
    kind: z.literal("ToolPolicy"),
    requireReadOnlyVerified: z.literal(true),
    forbiddenToolNamePrefixes: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ToolPolicy = z.infer<typeof toolPolicySchema>;

/**
 * Tool access classification shown by the management portal — TDD §27.
 * A tool absent from the approved catalog is UNKNOWN, never READ: the portal
 * must show it as unselectable rather than silently treating it as safe.
 */
export type ToolClassification = "read" | "write" | "unknown";

export function classifyTool(catalog: ApprovedCatalog, serverId: string, toolName: string): ToolClassification {
  const approved = catalog.tools.find((tool) => tool.serverId === serverId && tool.toolName === toolName);
  if (approved === undefined) return "unknown";
  return approved.readOnlyVerified ? "read" : "write";
}
