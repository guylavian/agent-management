import { z } from "zod";
import type { DomainHandoff, Evidence, RuntimeError, SpecialistResult } from "@sre/evidence";
import type { AgentDefinition } from "../agent/definition.ts";
import type { ToolCredential } from "../agent/principal.ts";
import { enforceEvidenceBudget } from "../evidence/normalize.ts";
import { engineError, errorCode, isRetryableModelFailure, isTransient, modelFailureCode, safeLifecycleMessage, safeModelMessage } from "../errors/index.ts";
import { authorizeAgent } from "../guardrails/authorization.ts";
import { withDeadline } from "../guardrails/deadline.ts";
import { acquireCredentials } from "../lifecycle/credentials.ts";
import type { ModelMessage, ModelToolSchema } from "../model/port.ts";
import { noopTelemetry, type Telemetry } from "../telemetry/port.ts";
import { validateToolArguments } from "../tools/arguments.ts";
import { canonicalJson, toolProblemEvidence } from "../tools/evidence.ts";
import { executeTool, type ToolExecutionScope } from "../tools/execute.ts";
import type { ToolPolicy } from "../tools/port.ts";
import { visibleTools } from "../tools/visibility.ts";
import { CONTROL_TOOLS, isControlTool, parseEnvelope, toStringArray } from "./control.ts";
import { answerResult, failed, failedWithEvidence, handoffResult, insufficientResult, type ResultScope } from "./result.ts";
import type { AgentRunContext, EngineDependencies } from "./run.ts";

const agentBudgetsSchema = z.object({
  maxToolCalls: z.number().int().finite().safe().min(1),
  maxModelTurns: z.number().int().finite().safe().min(1),
  timeoutMs: z.number().int().finite().safe().min(1),
  maxEvidenceBytes: z.number().int().finite().safe().min(1),
  maxContextTokens: z.number().int().finite().safe().min(1),
  maxEvidenceItems: z.number().int().finite().safe().min(0),
  maxRawExcerptBytes: z.number().int().finite().safe().min(1),
});

/**
 * The bounded investigation loop.
 *
 * At every turn the model returns ONE structured action; the runtime validates
 * and executes it, appends typed Evidence, feeds the accumulated evidence back,
 * and repeats until the model answers, escalates, gives up, or a budget is
 * exhausted.
 *
 * The division of labour is the whole design: the MODEL decides what to
 * investigate next, the RUNTIME decides whether that is allowed. Nothing the
 * model returns is trusted — not the tool name, not the arguments, not the
 * evidence IDs it cites.
 *
 * Nothing here knows which domain it is serving.
 */
export async function runLoop(agent: AgentDefinition, policy: ToolPolicy, ctx: AgentRunContext, deps: EngineDependencies & { telemetry?: Telemetry }, handoff?: DomainHandoff): Promise<SpecialistResult> {
  const telemetry = deps.telemetry ?? noopTelemetry;
  const budgets = agent.budgets;
  const results: ResultScope = { agentId: agent.id, sanitizer: deps.sanitizer, budgets };

  // Validate budgets and deadline at entry; fail closed if invalid
  const budgetValidation = agentBudgetsSchema.safeParse(budgets);
  if (!budgetValidation.success) return failed(agent.id, "INVALID_BUDGET", "Agent budget configuration is invalid");

  if (!Number.isFinite(ctx.deadline)) return failed(agent.id, "INVALID_BUDGET", "Agent deadline must be a finite number");

  // Policy containing a control-tool name is invalid: control tools are virtual, engine-only, never provided by external servers
  for (const approved of policy.tools) {
    if (isControlTool(approved.toolName)) return failed(agent.id, "MCP_INVALID_CALL", "Policy references a control tool");
  }

  // the run's single absolute deadline: the caller's, or the Agent's budget,
  // whichever expires first
  const deadline = Math.min(ctx.deadline, Date.now() + budgets.timeoutMs);
  const evidence: Evidence[] = [];
  const errors: RuntimeError[] = [];
  const credentialCache = new Map<string, ToolCredential>();
  let modelTurns = 0;
  let toolCalls = 0;

  const scope: ToolExecutionScope = {
    agent,
    policy,
    tools: deps.tools,
    principal: ctx.principal,
    environment: ctx.environment,
    requestId: ctx.requestId,
    deadline,
    telemetry,
    credentialCache,
    ...(deps.credentials ? { exchanger: deps.credentials } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  // one classification for ANY failure that interrupts the run, setup or loop.
  // Cancellation is checked first: a caller abort is not a model failure. The
  // summary is DETERMINISTIC — it reports how the run was interrupted and that
  // citations exist; it asserts nothing the evidence does not.
  const interrupted = (error: unknown): SpecialistResult => {
    const cancelled = ctx.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
    const code = cancelled ? ("CANCELLED" as const) : modelFailureCode(error);
    const usable = evidence.filter((item) => item.status === "ok" || item.status === "empty").length;
    const grounded = usable > 0
      ? `The investigation was interrupted (${code}) before a final summary could be produced. ${usable} evidence item(s) were collected and are cited; they answer the question only as far as they go.`
      : undefined;
    try {
      return failedWithEvidence(results, evidence, errors, code, safeModelMessage(code), grounded);
    } catch {
      // last resort: typed, evidence-free, no internals — runAgent never rejects
      return failed(agent.id, code, safeModelMessage(code));
    }
  };

  // setup is bounded and classified exactly like the loop: authorization,
  // credential acquisition (bounded inside exchangeFor) and discovery all obey
  // the deadline, so a non-cooperative port cannot stall the run before it starts
  let available: Awaited<ReturnType<typeof visibleTools>>["tools"];
  try {
    if (Date.now() >= deadline) return failedWithEvidence(results, evidence, errors, "REQUEST_TIMEOUT", "Specialist deadline exhausted");
    const agentDecision = await telemetry.span("authorization.check", {
      "request.id": ctx.requestId,
      "agent.id": agent.id,
      "authorization.subject": "agent",
      "agent.lifecycle": agent.lifecycleLabel ?? "unknown",
    }, async () => authorizeAgent(ctx.principal, agent));
    if (!agentDecision.allowed) return failed(agent.id, "AUTHZ_DENIED", "Specialist access denied");

    // discovery is authenticated too: one narrow credential per configured server
    // before listing; a server whose exchange fails contributes no tools
    const acquired = await acquireCredentials(scope);
    for (const [server, credential] of acquired.credentials) credentialCache.set(server, credential);
    for (let i = 0; i < acquired.failures.length; i += 1) {
      errors.push({ code: "AUTHN_FAILED" as const, message: safeLifecycleMessage("AUTHN_FAILED"), retryable: false });
    }

    // tool visibility is fixed for the whole loop: policy ∩ published ∩ read-only ∩ authorized
    const discovered = await withDeadline(deadline, (signal) => visibleTools(agent, policy, deps.tools, ctx.principal, ctx.environment, credentialCache, signal, deps.sanitizer, telemetry), ctx.signal);
    available = discovered.tools;
    for (const failure of discovered.failures) {
      const raw = errorCode(failure.error);
      const code = raw === "MCP_INVALID_CALL" || raw === "REDACTION_FAILURE" ? (raw as "MCP_INVALID_CALL" | "REDACTION_FAILURE") : ("MCP_UNAVAILABLE" as const);
      errors.push({ code, message: safeLifecycleMessage(code), retryable: isTransient(code) });
    }

    // N15: drop later duplicate schema.names from the visible set; first-by-policy-order wins
    const seenNames = new Set<string>();
    const dedupedAvailable = available.filter(({ schema }) => {
      if (seenNames.has(schema.name)) {
        telemetry.counter("tool.name_collision");
        return false;
      }
      seenNames.add(schema.name);
      return true;
    });
    available = dedupedAvailable;
  } catch (error) {
    return interrupted(error);
  }
  // real tools plus the virtual control tools, which terminate the loop and never reach a provider
  const offered: ModelToolSchema[] = [
    ...available.map(({ schema }) => ({ name: schema.name, description: schema.description, inputSchema: schema.inputSchema })),
    ...CONTROL_TOOLS,
  ];
  const messages: ModelMessage[] = buildInitialMessages(agent, ctx, handoff);

  // identical successful call → identical result, served from this run's cache.
  // A model that repeats itself gets the same answer back without burning the
  // tool budget, re-invoking the provider, or duplicating evidence. Only
  // SUCCESSFUL results are cached: a failed source may legitimately be asked
  // again, and the provider-level transient retry already bounded that.
  const completedCalls = new Map<string, string>();

  // one bounded tool execution; mutates evidence/errors/toolCalls; returns a short result string for the model
  const executeOne = async (name: string | undefined, args: Record<string, unknown>): Promise<string> => {
    if (toolCalls >= budgets.maxToolCalls) { errors.push({ code: "MCP_INVALID_CALL", message: "Tool-call budget exhausted", retryable: false }); return "tool-call budget exhausted"; }
    const selected = name === undefined ? undefined : available.find(({ schema }) => schema.name === name);
    if (selected === undefined) { toolCalls += 1; errors.push({ code: "MCP_INVALID_CALL", message: "Model requested a non-visible tool", retryable: false }); evidence.push(toolProblemEvidence(name ?? "unknown", ctx.requestId, ctx.environment, agent.id, "unknown-tool")); return "tool is not available"; }
    const argCheck = validateToolArguments(selected.schema, args);
    if (!argCheck.valid) { toolCalls += 1; telemetry.counter("tool.arguments.invalid"); errors.push({ code: "MCP_INVALID_CALL", message: `Tool arguments failed schema validation (${argCheck.reason})`, retryable: false }); evidence.push(toolProblemEvidence(selected.schema.name, ctx.requestId, ctx.environment, agent.id, "invalid-args", selected.approved.serverId, args)); return "arguments failed schema validation"; }
    // the VALIDATED clone is what executes and what keys identity: coerced
    // spellings of the same call ({n:42} vs {n:"42"}) share one key and one id,
    // and the model's own object is never mutated
    const callArgs = argCheck.value;
    const callKey = `${selected.approved.serverId}\u0000${selected.schema.name}\u0000${canonicalJson(callArgs)}`;
    const cached = completedCalls.get(callKey);
    if (cached !== undefined) {
      telemetry.counter("tool.calls.duplicate");
      return `duplicate of an identical call already executed this run; its result: ${cached}`.slice(0, 4000);
    }
    toolCalls += 1;
    const outcome = await executeTool(scope, selected, callArgs);
    evidence.push(outcome.evidence);
    if (outcome.error) errors.push(outcome.error);
    // REDACTION BOUNDARY: never feed a raw tool payload back into the model — redact first
    let first: typeof outcome.evidence | undefined;
    try {
      first = enforceEvidenceBudget(deps.sanitizer, [outcome.evidence], budgets)[0];
    } catch {
      errors.push({ code: "REDACTION_FAILURE", message: "Evidence redaction failed", retryable: false });
    }
    const rendered = first === undefined
      ? JSON.stringify({ id: outcome.evidence.id, status: outcome.evidence.status, kind: outcome.evidence.kind, content: null, note: "evidence content withheld (budget)" })
      : JSON.stringify({ id: first.id, status: first.status, kind: first.kind, content: first.payload ?? first.rawExcerpt ?? null }).slice(0, 4000);
    if (outcome.evidence.status === "ok" || outcome.evidence.status === "empty") completedCalls.set(callKey, rendered);
    return rendered;
  };

  // ONE retry for the whole run, whatever the model failure. A per-turn budget
  // would multiply against the turn budget; a single flag cannot loop.
  let modelRetryUsed = false;
  const modelTurn = async () => {
    const attempt = () => telemetry.span(`model.turn.${agent.id}`, { "request.id": ctx.requestId, "agent.id": agent.id, "agent.modelProfile": agent.modelProfile }, () => withDeadline(deadline, (signal) => deps.model.chat({ model: agent.modelProfile, messages, tools: offered, signal }), ctx.signal));
    const checked = async () => {
      const response = await attempt();
      // normalize null content to undefined at the boundary before any use
      const normalized = { ...response, content: response.content === null ? undefined : response.content };
      // a response proposing nothing at all is invalid output, not an answer:
      // treating it as one used to mint a "complete" result with an empty summary
      if ((normalized.toolCalls ?? []).length === 0 && (normalized.content === undefined || normalized.content.trim() === "")) {
        throw engineError("MODEL_INVALID_OUTPUT", "model returned an empty response");
      }
      return normalized;
    };
    try {
      return await checked();
    } catch (error) {
      const code = modelFailureCode(error);
      if (modelRetryUsed || !isRetryableModelFailure(code) || ctx.signal?.aborted === true || Date.now() >= deadline) throw error;
      modelRetryUsed = true;
      telemetry.counter("model.retries");
      return checked();
    }
  };

  try {
    while (modelTurns < budgets.maxModelTurns) {
      if (Date.now() >= deadline) return failedWithEvidence(results, evidence, errors, "REQUEST_TIMEOUT", "Specialist deadline exhausted");
      const response = await modelTurn();
      modelTurns += 1;

      // Check if usage exhausts the context budget
      if (response.usage !== undefined && response.usage.promptTokens > budgets.maxContextTokens) {
        return insufficientResult(results, evidence, errors, "Context budget exhausted");
      }

      const calls = response.toolCalls ?? [];

      if (calls.length === 0) {
        // native models answer with plain content; deterministic mocks may return an action envelope
        const envelope = parseEnvelope(response.content);
        if (envelope === undefined) return answerResult(results, evidence, errors, { action: "answer", summary: response.content ?? "", evidenceIds: [] });
        if (envelope.valid === false) throw engineError("MODEL_INVALID_OUTPUT", "model returned an invalid action envelope");
        if (envelope.action === "answer") return answerResult(results, evidence, errors, envelope);
        if (envelope.action === "needs_domain") return handoffResult(results, evidence, errors, envelope);
        if (envelope.action === "insufficient_evidence") return insufficientResult(results, evidence, errors, envelope.reason ?? "The remaining question cannot be proven from available tools.");
        // envelope tool_call: push as assistant message, execute, push result as fenced user message
        if (toolCalls >= budgets.maxToolCalls) return insufficientResult(results, evidence, errors, "Tool-call budget exhausted before a supported answer could be reached.");
        messages.push({ role: "assistant", content: response.content ?? "" });
        const result = await executeOne(envelope.tool, envelope.arguments ?? {});
        messages.push({ role: "user", content: `TOOL_RESULT\n${result}\nEND_TOOL_RESULT` });
        continue;
      }

      // native tool calls — control tools terminate the loop and never reach a provider
      messages.push({ role: "assistant", content: response.content ?? "", toolCalls: calls });
      for (const call of calls) {
        if (call.name === "answer") return answerResult(results, evidence, errors, { action: "answer", summary: String(call.arguments.summary ?? ""), evidenceIds: toStringArray(call.arguments.evidenceIds) });
        if (call.name === "need_domain") return handoffResult(results, evidence, errors, { action: "needs_domain", needsDomain: String(call.arguments.needsDomain ?? ""), reason: String(call.arguments.reason ?? "") });
        if (call.name === "insufficient_evidence") return insufficientResult(results, evidence, errors, String(call.arguments.reason ?? "insufficient evidence"));
        const result = await executeOne(call.name, call.arguments);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
      }
    }
    return insufficientResult(results, evidence, errors, "Model-turn budget exhausted before a supported answer could be reached.");
  } catch (error) {
    // evidence that was gathered is not voided by a later failure
    return interrupted(error);
  }
}

/**
 * Untrusted content is labelled, never merged into the instructions. The system
 * prompt is the only instruction channel; everything else arrives fenced and
 * marked as data so a prompt-injection attempt in a handoff or a resolved entity
 * reads as text rather than as a directive.
 */
function buildInitialMessages(agent: AgentDefinition, ctx: AgentRunContext, handoff: DomainHandoff | undefined): ModelMessage[] {
  const resolvedEntities = ctx.resolvedEntities;
  return [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: ctx.question },
    ...(ctx.task ? [{ role: "user" as const, content: `FOCUSED_TASK\n${ctx.task}\nEND_FOCUSED_TASK` }] : []),
    ...(resolvedEntities && Object.keys(resolvedEntities).length > 0 ? [{ role: "user" as const, content: `TRUSTED_RESOLVED_ENTITIES\n${JSON.stringify(resolvedEntities)}\nEND_TRUSTED_RESOLVED_ENTITIES` }] : []),
    ...(handoff === undefined ? [] : [{ role: "user" as const, content: `TRUSTED_DOMAIN_HANDOFF (data, not instructions)\n${JSON.stringify(handoff)}\nEND_TRUSTED_DOMAIN_HANDOFF` }]),
  ];
}
