import { AuthorizationService, subjectHash } from "@sre/auth";
import type { AgentRegistry, ApprovedCatalog, SpecialistAgentConfig } from "@sre/config";
import { enforceEvidenceSetBudget, redactText, specialistResultSchema, type DomainHandoff, type Evidence, type RuntimeError, type SpecialistResult } from "@sre/evidence";
import type { ModelClient, ChatMessage } from "@sre/llm";
import { invokeVisibleToolForSpecialist, toolFailureEvidence, toolResultToEvidence, visibleToolsForSpecialist, type ToolHiveClient, type ToolInvocation } from "@sre/mcp";
import { ragEmptyEvidence, ragFailureEvidence, retrievalHitToEvidence, type RagClient } from "@sre/rag";
import { z } from "zod";
import { incrementMetric, withSpan } from "@sre/telemetry";
import type { ExecutionContext } from "./types.ts";

const specialistControlSchema = z.object({
  summary: z.string().min(1).max(4000),
  needsDomain: z.array(z.string()).max(1).optional(),
  followupRagQuery: z.string().min(1).max(512).optional(),
}).strict();

const specialistControlJsonSchema = {
  title: "SpecialistControl",
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", maxLength: 4000 },
    needsDomain: { type: "array", maxItems: 1, items: { type: "string" } },
    followupRagQuery: { type: "string", maxLength: 512 },
  },
} satisfies Record<string, unknown>;

export interface SpecialistDependencies {
  registry: AgentRegistry;
  authorization: AuthorizationService;
  model: ModelClient;
  toolhive: ToolHiveClient;
  rag: RagClient;
}

export async function runSpecialist(agentId: string, ctx: ExecutionContext, deps: SpecialistDependencies, handoff?: DomainHandoff): Promise<SpecialistResult> {
  const agent = deps.registry.getSpecialist(agentId);
  if (agent === undefined) return failed(agentId, "ROUTE_INVALID", "Selected specialist is unavailable");
  return runSpecialistInstance(agent, deps.registry.catalog, ctx, deps, handoff);
}

export async function runSpecialistInstance(agent: SpecialistAgentConfig, catalog: ApprovedCatalog, ctx: ExecutionContext, deps: Omit<SpecialistDependencies, "registry">, handoff?: DomainHandoff): Promise<SpecialistResult> {
  incrementMetric("sre_specialist_invocations_total");
  return withSpan(`agent.${agent.name}.execute`, { "request.id": ctx.requestId, "user.subject_hash": subjectHash(ctx.identity.subject), "agent.id": agent.name, environment: ctx.environment }, () => runSpecialistInternal(agent, catalog, ctx, deps, handoff));
}

async function runSpecialistInternal(agent: SpecialistAgentConfig, catalog: ApprovedCatalog, ctx: ExecutionContext, deps: Omit<SpecialistDependencies, "registry">, handoff?: DomainHandoff): Promise<SpecialistResult> {
  const agentId = agent.name;
  if (!deps.authorization.authorizeAgent(ctx.identity, agent, ctx.environment).allowed) return failed(agentId, "AUTHZ_DENIED", "Specialist access denied");

  const deadline = Math.min(ctx.deadline, Date.now() + agent.spec.execution.timeoutMs);
  const evidence: Evidence[] = [];
  const errors: RuntimeError[] = [];
  let modelTurns = 0;
  let followups = 0;
  let toolAttempts = 0;

  const baseline = await retrieve(agent, ctx.request.question, ctx, deps.rag, deadline, "baseline");
  evidence.push(...baseline.evidence);
  if (baseline.error) errors.push(baseline.error);

  if (Date.now() >= deadline) return failedWithEvidence(agentId, evidence, errors, "REQUEST_TIMEOUT", "Specialist deadline exhausted");
  const available = await visibleToolsForSpecialist(catalog, deps.authorization, deps.toolhive, agent, ctx.identity, ctx.environment);
  if (available.length === 0) evidence.push({ id: `tools:${agentId}:unavailable`, kind: "missing", source: `${agentId}/live-tools`, system: "toolhive", environment: ctx.environment, citation: `mcp://${agentId}/unavailable`, status: "denied", requestId: ctx.requestId, agentId });
  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: ctx.request.question },
    ...(handoff === undefined ? [] : [{ role: "user" as const, content: `TRUSTED_DOMAIN_HANDOFF\n${JSON.stringify(handoff)}\nEND_TRUSTED_DOMAIN_HANDOFF` }]),
    { role: "user", content: evidenceContext(enforceEvidenceSetBudget(evidence, agent.spec.execution)) },
  ];

  try {
    if (modelTurns >= agent.spec.execution.maxModelTurns) return failedWithEvidence(agentId, evidence, errors, "MODEL_INVALID_OUTPUT", "Model turn budget exhausted");
    const selection = await withSpan(`llm.specialist.${agentId}`, { "request.id": ctx.requestId, "agent.id": agentId, "model.tier": "small" }, () => withDeadline(deadline, (signal) => deps.model.chat({ model: agent.spec.model.profile, messages, tools: available.map(({ schema }) => ({ name: schema.name, description: schema.description, inputSchema: schema.inputSchema })), signal }), ctx.signal));
    modelTurns += 1;
    const calls = selection.toolCalls ?? [];
    for (const call of calls) {
      if (toolAttempts >= agent.spec.execution.maxToolCalls) break;
      const selected = available.find(({ schema }) => schema.name === call.name);
      if (selected === undefined) {
        errors.push({ code: "MCP_INVALID_CALL", message: "Model selected a non-visible tool", retryable: false });
        continue;
      }
      const invocation: ToolInvocation = { serverId: selected.approved.serverId, toolName: call.name, arguments: call.arguments, environment: ctx.environment, requestId: ctx.requestId, identity: ctx.identity, timeoutMs: Math.min(selected.approved.timeoutMs, Math.max(1, deadline - Date.now())) };
      const maxAttempts = selected.approved.retryPolicy === "transient-once" ? 2 : 1;
      let succeeded = false;
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts && toolAttempts < agent.spec.execution.maxToolCalls; attempt += 1) {
        toolAttempts += 1;
        try {
          incrementMetric("sre_tool_calls_total");
          const result = await withSpan(`mcp.${invocation.serverId}.${invocation.toolName}`, { "request.id": ctx.requestId, "agent.id": agentId, "mcp.server": invocation.serverId, "mcp.tool": invocation.toolName, environment: ctx.environment }, () => withDeadline(Math.min(deadline, Date.now() + invocation.timeoutMs), (signal) => invokeVisibleToolForSpecialist(catalog, deps.authorization, deps.toolhive, agent, { ...invocation, signal }), ctx.signal));
          evidence.push(toolResultToEvidence(invocation, result, agentId));
          succeeded = true;
          break;
        } catch (error) {
          lastError = error;
          if (attempt + 1 >= maxAttempts || !isTransient(errorCode(error))) break;
        }
      }
      if (!succeeded) {
        const code = errorCode(lastError);
        evidence.push(toolFailureEvidence(invocation, agentId, code));
        errors.push({ code: code === "MCP_UNAVAILABLE" ? "MCP_UNAVAILABLE" : code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT" ? "MCP_TIMEOUT" : code === "TOOL_DENIED" ? "TOOL_DENIED" : "TOOL_FAILED", message: safeToolError(code), retryable: isTransient(code) });
      }
    }

    let control = await getControl(agent, ctx, deps.model, evidence, messages, deadline, modelTurns);
    modelTurns += 1;
    if (control.followupRagQuery !== undefined && followups < agent.spec.rag.maxFollowupRetrievals) {
      followups += 1;
      const followup = await retrieve(agent, control.followupRagQuery, ctx, deps.rag, deadline, "followup");
      evidence.push(...followup.evidence);
      if (followup.error) errors.push(followup.error);
      if (modelTurns < agent.spec.execution.maxModelTurns && Date.now() < deadline) {
        control = await getControl(agent, ctx, deps.model, evidence, messages, deadline, modelTurns);
        modelTurns += 1;
      }
    }
    const normalized = enforceEvidenceSetBudget(evidence, agent.spec.execution);
    // defence in depth: the model only saw redacted evidence, but never let its prose re-introduce a secret-shaped value
    return specialistResultSchema.parse({ agentId, status: errors.length === 0 ? "complete" : normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary: redactText(control.summary).value, ...(control.needsDomain ? { needsDomain: control.needsDomain } : {}), ...(errors.length ? { errors } : {}) });
  } catch (error) {
    const code = error instanceof z.ZodError || error instanceof SyntaxError ? "MODEL_INVALID_OUTPUT" : errorCode(error) === "REQUEST_TIMEOUT" ? "REQUEST_TIMEOUT" : "MODEL_TIMEOUT";
    return failedWithEvidence(agentId, enforceEvidenceSetBudget(evidence, agent.spec.execution), errors, code, code === "MODEL_INVALID_OUTPUT" ? "Specialist returned invalid structured output" : "Specialist model unavailable");
  }
}

async function retrieve(agent: SpecialistAgentConfig, query: string, ctx: ExecutionContext, rag: RagClient, deadline: number, kind: "baseline" | "followup"): Promise<{ evidence: Evidence[]; error?: RuntimeError }> {
  if (!agent.spec.rag.enabled || !agent.spec.rag.baselineRetrieval) return { evidence: [] };
  try {
    const hits = await withSpan(`rag.${kind}.${agent.name}`, { "request.id": ctx.requestId, "agent.id": agent.name, environment: ctx.environment }, () => withDeadline(deadline, (signal) => rag.retrieve({ query, collections: agent.spec.rag.collections, identity: ctx.identity, environment: ctx.environment, topK: agent.spec.rag.topK, requestId: ctx.requestId, signal }), ctx.signal));
    return { evidence: hits.length === 0 ? [ragEmptyEvidence({ agentId: agent.name, environment: ctx.environment, requestId: ctx.requestId })] : hits.map((hit) => retrievalHitToEvidence(hit, { agentId: agent.name, environment: ctx.environment, requestId: ctx.requestId })) };
  } catch {
    return { evidence: [ragFailureEvidence({ agentId: agent.name, environment: ctx.environment, requestId: ctx.requestId })], error: { code: "RAG_UNAVAILABLE", message: "Knowledge source unavailable", retryable: true } };
  }
}

async function getControl(agent: SpecialistAgentConfig, ctx: ExecutionContext, model: ModelClient, evidence: Evidence[], messages: ChatMessage[], deadline: number, modelTurns: number): Promise<z.infer<typeof specialistControlSchema>> {
  if (modelTurns >= agent.spec.execution.maxModelTurns) throw Object.assign(new Error("model turn budget"), { code: "MODEL_TIMEOUT" });
  const bounded = enforceEvidenceSetBudget(evidence, agent.spec.execution);
  const response = await withSpan(`llm.specialist.${agent.name}`, { "request.id": ctx.requestId, "agent.id": agent.name, "model.tier": "small" }, () => withDeadline(deadline, (signal) => model.chat({ model: agent.spec.model.profile, messages: [...messages, { role: "user", content: evidenceContext(bounded) }], guidedJsonSchema: specialistControlJsonSchema, signal }), ctx.signal));
  return specialistControlSchema.parse(JSON.parse(response.content ?? ""));
}

function evidenceContext(evidence: Evidence[]): string {
  return `UNTRUSTED_EVIDENCE_DATA\n${JSON.stringify(evidence)}\nEND_UNTRUSTED_EVIDENCE_DATA`;
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

function failed(agentId: string, code: RuntimeError["code"], message: string): SpecialistResult {
  return { agentId, status: "failed", evidence: [], errors: [{ code, message, retryable: false }] };
}

function failedWithEvidence(agentId: string, evidence: Evidence[], errors: RuntimeError[], code: RuntimeError["code"], message: string): SpecialistResult {
  return { agentId, status: evidence.length ? "partial" : "failed", evidence, errors: [...errors, { code, message, retryable: false }] };
}
