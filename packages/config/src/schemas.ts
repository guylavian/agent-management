import { z } from "zod";

/**
 * Agent YAML schema per TDD §5 with binding amendments.
 * Every object is .strict(): unknown keys (loops, branches, expressions,
 * embedded code, workflow constructs) are rejected — TDD §5.3.
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

const specialistSpecSchema = z
  .object({
    type: z.literal("specialist"),
    model: z
      .object({
        tier: z.enum(["small", "large"]),
        profile: z.string().min(1),
      })
      .strict(),
    prompt: z.object({ systemFile: z.string().min(1) }).strict(),
    mcp: z
      .object({
        servers: z.array(z.string().min(1)).min(1),
        allowedTools: z.array(z.string().min(1)).min(1),
      })
      .strict(),
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
  })
  .strict();

const managerSpecSchema = z
  .object({
    type: z.literal("manager"),
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
      })
      .strict(),
    spec: z.discriminatedUnion("type", [managerSpecSchema, specialistSpecSchema]),
  })
  .strict();

export type AgentDocument = z.infer<typeof agentDocumentSchema>;
export type SpecialistSpec = z.infer<typeof specialistSpecSchema>;
export type ManagerSpec = z.infer<typeof managerSpecSchema>;

export interface SpecialistAgentConfig {
  name: string;
  owner: string;
  spec: SpecialistSpec;
  systemPrompt: string;
}

export interface ManagerAgentConfig {
  name: string;
  owner: string;
  spec: ManagerSpec;
  systemPrompt: string;
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
