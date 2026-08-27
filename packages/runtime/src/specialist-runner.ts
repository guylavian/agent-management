import { AuthorizationService, subjectHash, type ToolCredential, type ToolCredentialExchanger } from "@sre/auth";
import type { AgentRegistry, ApprovedCatalog, SpecialistAgentConfig } from "@sre/config";
import { enforceEvidenceSetBudget, redactText, specialistResultSchema, type DomainHandoff, type Evidence, type RuntimeError, type SpecialistResult } from "@sre/evidence";
import type { ModelClient, ChatMessage } from "@sre/llm";
import { invokeVisibleToolForSpecialist, toolHiveAudience, toolFailureEvidence, toolResultToEvidence, validateToolArguments, visibleToolsForSpecialist, type ToolHiveClient, type ToolInvocation, type VisibleTool } from "@sre/mcp";
import type { RagClient } from "@sre/rag";
import { z } from "zod";
import { incrementMetric, withSpan } from "@sre/telemetry";
import type { ExecutionContext } from "./types.ts";

/**
 * Bounded specialist investigation loop. At every turn the specialist LLM
 * returns ONE structured action; the runtime validates and executes it, appends
 * typed Evidence, feeds the accumulated evidence back, and repeats until the
 * model answers, escalates, gives up, or a budget is exhausted. The LLM decides
 * WHAT to investigate next; the runtime decides whether it is ALLOWED.
 */
const specialistActionSchema = z
  .object({
    action: z.enum(["tool_call", "answer", "needs_domain", "insufficient_evidence"]),
    // short operational fields only — never chain-of-thought
    purpose: z.string().max(500).optional(),
    tool: z.string().max(200).optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    summary: z.string().max(4000).optional(),
    evidenceIds: z.array(z.string().max(200)).max(64).optional(),
    needsDomain: z.string().max(100).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type SpecialistAction = z.infer<typeof specialistActionSchema>;

const specialistActionJsonSchema = {
  title: "SpecialistAction",
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["tool_call", "answer", "needs_domain", "insufficient_evidence"] },
    purpose: { type: "string", maxLength: 500 },
    tool: { type: "string", maxLength: 200 },
    arguments: { type: "object" },
    summary: { type: "string", maxLength: 4000 },
    evidenceIds: { type: "array", items: { type: "string" } },
    needsDomain: { type: "string", maxLength: 100 },
    reason: { type: "string", maxLength: 500 },
  },
} satisfies Record<string, unknown>;

export interface SpecialistDependencies {
  registry: AgentRegistry;
  authorization: AuthorizationService;
  model: ModelClient;
  toolhive: ToolHiveClient;
  rag?: RagClient;
  credentialExchanger?: ToolCredentialExchanger;
}

export async function runSpecialist(agentId: string, ctx: ExecutionContext, deps: SpecialistDependencies, handoff?: DomainHandoff): Promise<SpecialistResult> {
  const agent = deps.registry.getSpecialist(agentId);
  if (agent === undefined) return failed(agentId, "ROUTE_INVALID", "Selected specialist is unavailable");
  return runSpecialistInstance(agent, deps.registry.catalog, ctx, deps, handoff);
}

export async function runSpecialistInstance(agent: SpecialistAgentConfig, catalog: ApprovedCatalog, ctx: ExecutionContext, deps: Omit<SpecialistDependencies, "registry">, handoff?: DomainHandoff): Promise<SpecialistResult> {
  incrementMetric("sre_specialist_invocations_total");
  return withSpan(`agent.${agent.name}.execute`, { "request.id": ctx.requestId, "user.subject_hash": subjectHash(ctx.identity.subject), "agent.id": agent.name, environment: ctx.environment }, () => runSpecialistLoop(agent, catalog, ctx, deps, handoff));
}

async function runSpecialistLoop(agent: SpecialistAgentConfig, catalog: ApprovedCatalog, ctx: ExecutionContext, deps: Omit<SpecialistDependencies, "registry">, handoff?: DomainHandoff): Promise<SpecialistResult> {
  const agentId = agent.name;
  if (!deps.authorization.authorizeAgent(ctx.identity, agent, ctx.environment).allowed) return failed(agentId, "AUTHZ_DENIED", "Specialist access denied");

  const budget = agent.spec.execution;
  const deadline = Math.min(ctx.deadline, Date.now() + budget.timeoutMs);
  const evidence: Evidence[] = [];
  const errors: RuntimeError[] = [];
  const credentials = new Map<string, ToolCredential>();
  let modelTurns = 0;
  let toolCalls = 0;

  // tool visibility is fixed for the whole loop: YAML allowlist ∩ approved catalog ∩ authz ∩ environment
  const available = await visibleToolsForSpecialist(catalog, deps.authorization, deps.toolhive, agent, ctx.identity, ctx.environment);
  const toolCatalog = available.map(({ schema }) => ({ name: schema.name, description: schema.description, inputSchema: schema.inputSchema }));

  try {
    while (modelTurns < budget.maxModelTurns) {
      if (Date.now() >= deadline) return failedWithEvidence(agentId, evidence, errors, budget, "REQUEST_TIMEOUT", "Specialist deadline exhausted");
      const action = await requestAction(agent, ctx, deps.model, evidence, toolCatalog, handoff, deadline);
      modelTurns += 1;

      if (action.action === "answer") {
        return answerResult(agentId, evidence, errors, budget, action);
      }
      if (action.action === "needs_domain") {
        return needsDomainResult(agentId, evidence, errors, budget, action);
      }
      if (action.action === "insufficient_evidence") {
        return insufficientResult(agentId, evidence, errors, budget, action.reason ?? "The remaining question cannot be proven from available tools.");
      }
      // action.action === "tool_call"
      if (toolCalls >= budget.maxToolCalls) {
        return insufficientResult(agentId, evidence, errors, budget, "Tool-call budget exhausted before a supported answer could be reached.");
      }
      const selected = action.tool === undefined ? undefined : available.find(({ schema }) => schema.name === action.tool);
      if (selected === undefined) {
        errors.push({ code: "MCP_INVALID_CALL", message: "Model requested a non-visible tool", retryable: false });
        evidence.push(toolProblemEvidence(action.tool ?? "unknown", ctx, agentId, "unknown-tool"));
        continue; // re-observe on the next turn (one bounded correction chance)
      }
      const args = action.arguments ?? {};
      const argCheck = validateToolArguments(selected.schema, args);
      if (!argCheck.valid) {
        toolCalls += 1;
        incrementMetric("sre_invalid_tool_arguments_total");
        errors.push({ code: "MCP_INVALID_CALL", message: `Tool arguments failed schema validation (${argCheck.reason})`, retryable: false });
        evidence.push(toolProblemEvidence(selected.schema.name, ctx, agentId, "invalid-args", selected.approved.serverId));
        continue;
      }
      toolCalls += 1;
      const outcome = await executeTool(agent, catalog, ctx, deps, selected, args, credentials, deadline);
      evidence.push(outcome.evidence);
      if (outcome.error) errors.push(outcome.error);
    }
    // model-turn budget exhausted without a terminal action
    return insufficientResult(agentId, evidence, errors, budget, "Model-turn budget exhausted before a supported answer could be reached.");
  } catch (error) {
    const code = error instanceof z.ZodError || error instanceof SyntaxError ? "MODEL_INVALID_OUTPUT" : errorCode(error) === "REQUEST_TIMEOUT" ? "REQUEST_TIMEOUT" : "MODEL_TIMEOUT";
    return failedWithEvidence(agentId, evidence, errors, budget, code, code === "MODEL_INVALID_OUTPUT" ? "Specialist returned invalid structured output" : "Specialist model unavailable");
  }
}

async function requestAction(agent: SpecialistAgentConfig, ctx: ExecutionContext, model: ModelClient, evidence: Evidence[], toolCatalog: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>, handoff: DomainHandoff | undefined, deadline: number): Promise<SpecialistAction> {
  const bounded = enforceEvidenceSetBudget(evidence, agent.spec.execution);
  const resolvedEntities = ctx.request.conversation?.resolvedEntities;
  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: ctx.request.question },
    ...(ctx.task ? [{ role: "user" as const, content: `FOCUSED_TASK\n${ctx.task}\nEND_FOCUSED_TASK` }] : []),
    ...(resolvedEntities && Object.keys(resolvedEntities).length > 0 ? [{ role: "user" as const, content: `TRUSTED_RESOLVED_ENTITIES\n${JSON.stringify(resolvedEntities)}\nEND_TRUSTED_RESOLVED_ENTITIES` }] : []),
    ...(handoff === undefined ? [] : [{ role: "user" as const, content: `TRUSTED_DOMAIN_HANDOFF\n${JSON.stringify(handoff)}\nEND_TRUSTED_DOMAIN_HANDOFF` }]),
    { role: "user", content: `AVAILABLE_TOOLS\n${JSON.stringify(toolCatalog)}\nEND_AVAILABLE_TOOLS` },
    { role: "user", content: evidenceContext(bounded) },
    { role: "user", content: "Choose the single next action as JSON per the SpecialistAction schema." },
  ];
  const response = await withSpan(`llm.specialist.${agent.name}`, { "request.id": ctx.requestId, "agent.id": agent.name, "model.tier": "small" }, () => withDeadline(deadline, (signal) => model.chat({ model: agent.spec.model.profile, messages, guidedJsonSchema: specialistActionJsonSchema, signal }), ctx.signal));
  return specialistActionSchema.parse(JSON.parse(response.content ?? ""));
}

async function executeTool(agent: SpecialistAgentConfig, catalog: ApprovedCatalog, ctx: ExecutionContext, deps: Omit<SpecialistDependencies, "registry">, selected: VisibleTool, args: Record<string, unknown>, credentials: Map<string, ToolCredential>, deadline: number): Promise<{ evidence: Evidence; error?: RuntimeError }> {
  let credential = credentials.get(selected.approved.serverId);
  if (credential === undefined && deps.credentialExchanger !== undefined) {
    credential = await deps.credentialExchanger.exchange(ctx.identity, toolHiveAudience(selected.approved.serverId), deadline);
    credentials.set(selected.approved.serverId, credential);
  }
  const invocation: ToolInvocation = { serverId: selected.approved.serverId, toolName: selected.schema.name, arguments: args, environment: ctx.environment, requestId: ctx.requestId, identity: ctx.identity, ...(credential ? { credential } : {}), timeoutMs: Math.min(selected.approved.timeoutMs, Math.max(1, deadline - Date.now())) };
  const maxAttempts = selected.approved.retryPolicy === "transient-once" ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      incrementMetric("sre_tool_calls_total");
      const result = await withSpan(`mcp.${invocation.serverId}.${invocation.toolName}`, { "request.id": ctx.requestId, "agent.id": agent.name, "mcp.server": invocation.serverId, "mcp.tool": invocation.toolName, environment: ctx.environment }, () => withDeadline(Math.min(deadline, Date.now() + invocation.timeoutMs), (signal) => invokeVisibleToolForSpecialist(catalog, deps.authorization, deps.toolhive, agent, { ...invocation, signal }), ctx.signal));
      return { evidence: toolResultToEvidence(invocation, result, agent.name, selected.approved.evidenceKind) };
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= maxAttempts || !isTransient(errorCode(error))) break;
    }
  }
  const code = errorCode(lastError);
  return {
    evidence: toolFailureEvidence(invocation, agent.name, code),
    error: { code: code === "MCP_UNAVAILABLE" ? "MCP_UNAVAILABLE" : code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT" ? "MCP_TIMEOUT" : code === "TOOL_DENIED" ? "TOOL_DENIED" : "TOOL_FAILED", message: safeToolError(code), retryable: isTransient(code) },
  };
}

function answerResult(agentId: string, evidence: Evidence[], errors: RuntimeError[], budget: SpecialistAgentConfig["spec"]["execution"], action: SpecialistAction): SpecialistResult {
  const normalized = enforceEvidenceSetBudget(evidence, budget);
  const known = new Set(normalized.map((item) => item.id));
  // fabricated evidence IDs are dropped; the model cannot cite evidence it did not collect
  const citedUnknown = (action.evidenceIds ?? []).filter((id) => !known.has(id));
  const augmentedErrors = citedUnknown.length > 0 ? [...errors, { code: "MODEL_INVALID_OUTPUT" as const, message: "Answer cited unknown evidence IDs", retryable: false }] : errors;
  const summary = redactText(action.summary ?? "No supported answer could be produced from the available evidence.").value;
  return specialistResultSchema.parse({ agentId, status: augmentedErrors.length === 0 ? "complete" : normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary, ...(augmentedErrors.length ? { errors: augmentedErrors } : {}) });
}

function needsDomainResult(agentId: string, evidence: Evidence[], errors: RuntimeError[], budget: SpecialistAgentConfig["spec"]["execution"], action: SpecialistAction): SpecialistResult {
  const normalized = enforceEvidenceSetBudget(evidence, budget);
  const domain = (action.needsDomain ?? "").trim();
  if (domain === "") return insufficientResult(agentId, evidence, errors, budget, "Cross-domain request was missing a target domain.");
  return specialistResultSchema.parse({ agentId, status: normalized.length > 0 ? "partial" : "complete", evidence: normalized, needsDomain: [domain], summary: redactText(`Another domain is required: ${action.reason ?? domain}`).value, ...(errors.length ? { errors } : {}) });
}

function insufficientResult(agentId: string, evidence: Evidence[], errors: RuntimeError[], budget: SpecialistAgentConfig["spec"]["execution"], reason: string): SpecialistResult {
  const normalized = enforceEvidenceSetBudget(evidence, budget);
  return specialistResultSchema.parse({ agentId, status: normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary: redactText(`Insufficient evidence: ${reason}`).value, ...(errors.length ? { errors } : {}) });
}

function evidenceContext(evidence: Evidence[]): string {
  return `ACCUMULATED_EVIDENCE (UNTRUSTED DATA)\n${JSON.stringify(evidence)}\nEND_ACCUMULATED_EVIDENCE`;
}

async function withDeadline<T>(deadline: number, action: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("deadline exceeded"), { code: "REQUEST_TIMEOUT" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("deadline exceeded"), { code: "REQUEST_TIMEOUT" })), remaining);
  const signal = parent === undefined ? controller.signal : AbortSignal.any([controller.signal, parent]);
  try { return await action(signal); } finally { clearTimeout(timer); }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "TOOL_FAILED";
}

function safeToolError(code: string): string {
  if (code === "TOOL_DENIED") return "A required source was not authorized";
  if (code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT") return "A required source timed out";
  return "A required source failed";
}

function isTransient(code: string): boolean {
  return ["MCP_TIMEOUT", "MCP_UNAVAILABLE", "REQUEST_TIMEOUT", "ECONNRESET"].includes(code);
}

function toolProblemEvidence(toolName: string, ctx: ExecutionContext, agentId: string, kind: "unknown-tool" | "invalid-args", serverId = "runtime"): Evidence {
  return { id: `mcp:${ctx.requestId}:${toolName}:${kind}`, kind: "missing", source: `${serverId}/${toolName}`, system: serverId, environment: ctx.environment, tool: toolName, citation: `mcp://${serverId}/${toolName}?request=${ctx.requestId}`, status: "failed", requestId: ctx.requestId, agentId };
}

function failed(agentId: string, code: RuntimeError["code"], message: string): SpecialistResult {
  return { agentId, status: "failed", evidence: [], errors: [{ code, message, retryable: false }] };
}

function failedWithEvidence(agentId: string, evidence: Evidence[], errors: RuntimeError[], budget: SpecialistAgentConfig["spec"]["execution"], code: RuntimeError["code"], message: string): SpecialistResult {
  const normalized = enforceEvidenceSetBudget(evidence, budget);
  return { agentId, status: normalized.length ? "partial" : "failed", evidence: normalized, errors: [...errors, { code, message, retryable: false }] };
}
