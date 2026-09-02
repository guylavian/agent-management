import type { DomainHandoff, SpecialistResult } from "@sre/evidence";
import type { AgentDefinition } from "../agent/definition.ts";
import type { Principal } from "../agent/principal.ts";
import type { Sanitizer } from "../guardrails/sanitizer.ts";
import type { CredentialProvider } from "../lifecycle/credentials.ts";
import type { Model } from "../model/port.ts";
import { hashSubject } from "../telemetry/subject.ts";
import { noopTelemetry, safeTelemetry, type Telemetry } from "../telemetry/port.ts";
import type { ToolPolicy, ToolProvider } from "../tools/port.ts";
import { runLoop } from "./loop.ts";

/**
 * Everything one bounded investigation needs to know.
 *
 * Deliberately narrow: no routing decision, no intent classification, no list of
 * other agents, no session. The engine receives a question, a principal, a
 * deadline and an optional assigned task, and investigates within the policy it
 * was given. It cannot learn what else exists, so it cannot reach it.
 */
export interface AgentRunContext {
  question: string;
  environment: string;
  requestId: string;
  principal: Principal;
  /** single absolute deadline for the whole run; stages may shorten, never extend */
  deadline: number;
  signal?: AbortSignal;
  /** focused task assigned by whatever orchestrates this Agent, if any */
  task?: string;
  /** facts an orchestrator already resolved; trusted DATA, never instructions */
  resolvedEntities?: Record<string, string>;
}

/**
 * The host-supplied ports.
 *
 * `sanitizer` has no default on purpose: redaction is a security property, and a
 * default would silently disable it. `telemetry` does default, because losing a
 * span loses observability, not safety.
 */
export interface EngineDependencies {
  model: Model;
  tools: ToolProvider;
  sanitizer: Sanitizer;
  telemetry?: Telemetry;
  credentials?: CredentialProvider;
}

/**
 * THE AGENT ENGINE.
 *
 * One implementation runs every Agent. Which prompt it uses, which servers and
 * tools it may reach, which model profile it asks for and every budget it must
 * respect arrive as an AgentDefinition — never from code, and never from the
 * caller of the question.
 *
 * The engine has no knowledge of an orchestrator. It cannot route, cannot select
 * another Agent and cannot call one; the strongest cross-domain signal it can
 * produce is a handoff REQUEST that whatever runs it may refuse.
 */
export async function runAgent(agent: AgentDefinition, policy: ToolPolicy, ctx: AgentRunContext, deps: EngineDependencies, handoff?: DomainHandoff): Promise<SpecialistResult> {
  try {
    const telemetry = safeTelemetry(deps.telemetry ?? noopTelemetry);
    telemetry.counter("agent.invocations");
    return await telemetry.span(`agent.${agent.id}.execute`, {
      "request.id": ctx.requestId,
      // the subject is hashed here and nowhere else carries it
      "user.subject_hash": hashSubject(ctx.principal.subject),
      "agent.id": agent.id,
      environment: ctx.environment,
    }, () => runLoop(agent, policy, ctx, { ...deps, telemetry }, handoff));
  } catch {
    // absolute last resort: whatever slipped past the loop's own boundaries,
    // the caller receives a typed result, never a rejection and never internals
    return { agentId: agent.id, status: "failed", evidence: [], errors: [{ code: "AGENT_EXECUTION_FAILED", message: "Agent execution failed", retryable: false }] };
  }
}
