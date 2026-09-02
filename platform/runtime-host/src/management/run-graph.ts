import type { RoutingTrace } from "@sre/orchestrator";
import type { RunNode, RunRecord } from "./run-store.ts";

/**
 * Builds the execution trace (TDD §45) from what the runtime actually did.
 *
 * Every node is derived from something that happened — an offered agent, a
 * routed task, a returned Evidence item, a refusal — so the trace cannot show a
 * step the runtime did not take, and cannot omit one it did.
 *
 * THE SHAPE OF THE ANSWER. Each tool the agent reached for produces up to three
 * nodes, and the split is the whole point:
 *
 *   tool.request        the agent's INTENT — it asked for this
 *   authorization.check the runtime's ENFORCEMENT — allowed, or refused and why
 *   toolhive.call       the EXECUTION — present only if something actually ran
 *
 * A refused call therefore has an intent and a refusal and no execution node,
 * which is the only honest way to render "it tried, and was stopped". Collapsing
 * these into one node — as this module used to — makes a blocked attempt and a
 * call that was never made look identical.
 *
 * Deliberately absent: the answer text, model reasoning, tool arguments and
 * tool payloads. The redacted question and the task each agent was given are
 * present; those are the request and the instruction, not the deliberation.
 */

/** The subset of SpecialistResult this module needs, so it does not depend on the runtime. */
export interface SpecialistResultLike {
  agentId: string;
  status: "complete" | "partial" | "failed";
  summary?: string;
  needsHandoff?: string[];
  errors?: Array<{ code: string; message: string }>;
  evidence: Array<{
    id: string;
    kind: string;
    system: string;
    tool?: string;
    status: string;
    agentId?: string;
    citation?: string;
    observedAt?: string;
  }>;
}

export interface BuildRunInput {
  requestId: string;
  userSubjectHash: string;
  environment: string;
  startedAt: Date;
  durationMs: number;
  /** agents the Manager routed to, in order */
  routedAgents: string[];
  results: SpecialistResultLike[];
  /** workload client id per agent, from the canonical Agent policy */
  workloadFor: (agentId: string) => string | undefined;
  modelProfileFor: (agentId: string) => string | undefined;
  status: RunRecord["status"];
  evidenceCount: number;
  synthesized: boolean;
  /** what the Manager was asked, chose and was refused; absent for older callers */
  routing?: RoutingTrace;
  /** why the run ended as it did, when the response carried an error or was degraded */
  outcomeReason?: string;
}

/**
 * Evidence status is richer than node status, and the mapping is not cosmetic.
 *
 * `denied` and `missing` were previously conflated into one "failed and
 * absent" test, which reported every refusal as a failure and every timeout as
 * a refusal — exactly backwards. The engine sets these deliberately
 * (`TOOL_DENIED` → denied, `TOOL_TIMEOUT` → missing) and they are read that way
 * here.
 */
function nodeStatus(evidenceStatus: string): RunNode["status"] {
  if (evidenceStatus === "denied") return "denied";
  if (evidenceStatus === "missing") return "timeout";
  if (evidenceStatus === "failed") return "failed";
  return "ok";
}

/** What a specialist concluded, in the platform's own control vocabulary. */
function agentOutcome(result: SpecialistResultLike): { label: string; status: RunNode["status"]; detail?: string } {
  if (result.status === "failed") {
    const error = result.errors?.[0];
    return { label: "failed", status: "failed", ...(error ? { detail: `${error.code}: ${error.message}` } : {}) };
  }
  const domain = result.needsHandoff?.[0];
  if (domain !== undefined) return { label: "needs_domain", status: "ok", detail: `handed off to ${domain}` };
  // the summary TEXT is the answer and is never stored; only whether one exists
  if (result.summary === undefined || result.summary.trim() === "") {
    return { label: "insufficient_evidence", status: "failed", detail: "the specialist produced no supported summary" };
  }
  return { label: "complete", status: "ok" };
}

export function buildRunRecord(input: BuildRunInput): RunRecord {
  const startedAtIso = input.startedAt.toISOString();
  const nodes: RunNode[] = [];
  const workloads = new Set<string>();
  const modelProfiles = new Set<string>();
  let toolCalls = 0;
  let deniedToolCalls = 0;

  const push = (node: RunNode) => { nodes.push(node); };
  /** every specialist that did not conclude, for the run's own explanation */
  const unresolved: string[] = [];
  const routing = input.routing;
  const question = routing?.question;
  const taskFor = new Map((routing?.selected ?? []).map((route) => [route.agent, route]));

  // ── the request ─────────────────────────────────────────────────────────
  const ROOT = "user.request";
  push({
    id: ROOT,
    kind: "user.request",
    label: question === undefined ? "question not recorded" : truncate(question, 200),
    status: "ok",
    startedAt: startedAtIso,
    durationMs: 0,
    actor: "user",
    // the full redacted question, where the label had to be cut for the tree
    ...(question === undefined ? {} : { detail: question }),
  });

  // ── the Manager's decision ──────────────────────────────────────────────
  const ROUTE = "manager.route";
  push({
    id: ROUTE,
    kind: "manager.route",
    label: `routed to ${input.routedAgents.length || "no"} specialist${input.routedAgents.length === 1 ? "" : "s"}`,
    parentId: ROOT,
    status: input.routedAgents.length > 0 ? "ok" : "failed",
    startedAt: startedAtIso,
    durationMs: 0,
    actor: "manager",
    round: 1,
    ...(routing === undefined ? {} : {
      metadata: {
        offered: routing.offered.length,
        selected: routing.selected.length,
        refused: routing.refused.length,
        abstained: routing.abstained,
      },
    }),
  });

  /*
   * A refused selection, recorded as its own node.
   *
   * This agent has no SpecialistResult and never will, so it appears nowhere
   * else in this record. Without this branch the trace would show the Manager
   * routing to two agents and only one running, with nothing to say why.
   */
  for (const refusal of routing?.refused ?? []) {
    push({
      id: `authz.${refusal.agent}`,
      kind: "authorization.check",
      label: refusal.agent,
      parentId: ROUTE,
      status: "denied",
      startedAt: startedAtIso,
      durationMs: 0,
      actor: "runtime",
      agentId: refusal.agent,
      detail: "selected by the Manager, refused by the runtime; this specialist never ran",
      metadata: { reason: refusal.reason },
      round: 1,
    });
  }

  // ── each specialist ─────────────────────────────────────────────────────
  const firstRound = new Set(input.routedAgents);
  for (const result of input.results) {
    // an agent that ran without being in the initial routing came from Round 2
    const round = firstRound.has(result.agentId) ? 1 : 2;
    const specialistId = `specialist.${result.agentId}`;
    const workload = input.workloadFor(result.agentId);
    if (workload !== undefined) workloads.add(workload);
    const profile = input.modelProfileFor(result.agentId);
    if (profile !== undefined) modelProfiles.add(profile);
    const route = taskFor.get(result.agentId);

    push({
      id: specialistId,
      kind: "specialist",
      label: result.agentId,
      parentId: ROUTE,
      status: result.status === "failed" ? "failed" : "ok",
      startedAt: startedAtIso,
      durationMs: 0,
      actor: "specialist",
      agentId: result.agentId,
      round,
      // the task is the Manager's instruction, and is the answer to "what did
      // this agent set out to do"
      ...(route?.task ? { detail: route.task } : {}),
      ...(route?.rationale || profile ? {
        metadata: {
          ...(route?.rationale ? { rationale: route.rationale } : {}),
          ...(profile ? { modelProfile: profile } : {}),
        },
      } : {}),
    });

    if (workload !== undefined) {
      push({
        id: `${specialistId}.workload`,
        kind: "workload.token",
        // the client id is an identifier, never the token itself
        label: workload,
        parentId: specialistId,
        status: "ok",
        startedAt: startedAtIso,
        durationMs: 0,
        actor: "runtime",
        agentId: result.agentId,
        round,
      });
    }

    for (const [index, evidence] of result.evidence.entries()) {
      const status = nodeStatus(evidence.status);
      const at = evidence.observedAt ?? startedAtIso;
      const base = { startedAt: at, durationMs: 0, agentId: result.agentId, round } as const;

      // evidence with no tool came from the runtime itself (a transport
      // failure, a refused follow-up) and hangs off the specialist directly
      let evidenceParent = specialistId;

      if (evidence.tool !== undefined) {
        toolCalls += 1;
        const requestId = `${specialistId}.request.${index}`;
        push({
          ...base,
          id: requestId,
          kind: "tool.request",
          label: `${evidence.system}/${evidence.tool}`,
          parentId: specialistId,
          // the intent itself always succeeded — the agent did ask
          status: "ok",
          actor: "specialist",
          mcp: evidence.system,
          tool: evidence.tool,
          detail: "the agent asked to call this tool",
        });
        evidenceParent = requestId;

        if (status === "denied") {
          deniedToolCalls += 1;
          push({
            ...base,
            id: `${specialistId}.authz.${index}`,
            kind: "authorization.check",
            label: `${evidence.system}/${evidence.tool}`,
            parentId: requestId,
            status: "denied",
            actor: "runtime",
            mcp: evidence.system,
            tool: evidence.tool,
            detail: "refused by the tool policy; the call was never sent",
            metadata: { reason: "TOOL_DENIED" },
          });
        } else {
          const callId = `${specialistId}.tool.${index}`;
          push({
            ...base,
            id: callId,
            kind: "toolhive.call",
            label: `${evidence.system}/${evidence.tool}`,
            parentId: requestId,
            status,
            actor: "runtime",
            mcp: evidence.system,
            tool: evidence.tool,
          });
          evidenceParent = callId;
        }
      }

      push({
        ...base,
        id: `${specialistId}.evidence.${index}`,
        kind: "evidence",
        label: `${evidence.kind}: ${evidence.id}`,
        parentId: evidenceParent,
        status,
        actor: "runtime",
        ...(evidence.tool ? { mcp: evidence.system, tool: evidence.tool } : {}),
        // the citation is a reference, not a payload
        ...(evidence.citation ? { metadata: { citation: evidence.citation } } : {}),
      });
    }

    for (const domain of result.needsHandoff ?? []) {
      push({
        id: `${specialistId}.escalate.${domain}`,
        kind: "domain.escalation",
        label: `needs ${domain}`,
        parentId: specialistId,
        status: "ok",
        startedAt: startedAtIso,
        durationMs: 0,
        actor: "specialist",
        agentId: result.agentId,
        detail: "returned through the Manager; specialists never call each other",
        round,
      });
    }

    const outcome = agentOutcome(result);
    if (outcome.status !== "ok") unresolved.push(`${result.agentId} ${outcome.label}`);
    push({
      id: `${specialistId}.result`,
      kind: "agent.result",
      label: outcome.label,
      parentId: specialistId,
      status: outcome.status,
      startedAt: startedAtIso,
      durationMs: 0,
      actor: "specialist",
      agentId: result.agentId,
      round,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    });
  }

  // ── the one bounded cross-domain hop ────────────────────────────────────
  if (routing?.followup !== undefined) {
    push({
      id: "followup.route",
      kind: "followup.route",
      label: routing.followup.agent,
      parentId: ROUTE,
      status: "ok",
      startedAt: startedAtIso,
      durationMs: 0,
      actor: "manager",
      agentId: routing.followup.agent,
      detail: "Round 2: the Manager dispatched a follow-up after a domain handoff",
      metadata: { reason: routing.followup.reason },
      round: 2,
    });
  }

  // ── the end ─────────────────────────────────────────────────────────────
  push({
    id: "synthesis",
    kind: "synthesis",
    label: input.synthesized ? "synthesized across specialists" : "deterministic response",
    // fan-in: every specialist converges here
    parentId: ROUTE,
    status: input.status === "failed" ? "failed" : "ok",
    startedAt: startedAtIso,
    durationMs: input.durationMs,
    actor: "runtime",
  });

  push({
    id: "run.completed",
    kind: "run.completed",
    label: input.status,
    parentId: ROOT,
    status: input.status === "failed" ? "failed" : input.status === "partial" ? "timeout" : "ok",
    startedAt: startedAtIso,
    durationMs: input.durationMs,
    actor: "runtime",
    /*
     * Why the run ended this way, in descending order of directness: the
     * reason the response reported, else what the specialists themselves
     * concluded. A degraded run with no recorded gap still has an
     * explanation — usually that every specialist returned
     * insufficient_evidence — and "no reason reported" was throwing that away.
     */
    ...(detailFor(input.status, input.outcomeReason, unresolved) ? { detail: detailFor(input.status, input.outcomeReason, unresolved) as string } : {}),
  });

  return {
    requestId: input.requestId,
    startedAt: startedAtIso,
    durationMs: input.durationMs,
    status: input.status,
    ...(question === undefined ? {} : { question: truncate(question, 2_000) }),
    userSubjectHash: input.userSubjectHash,
    environment: input.environment,
    agents: input.results.map((result) => result.agentId),
    workloads: [...workloads],
    toolCalls,
    deniedToolCalls,
    evidenceCount: input.evidenceCount,
    modelProfiles: [...modelProfiles],
    nodes,
  };
}

function detailFor(status: RunRecord["status"], reported: string | undefined, unresolved: string[]): string | undefined {
  if (reported !== undefined) return reported;
  if (status === "complete" || unresolved.length === 0) return undefined;
  return `no specialist concluded — ${unresolved.join("; ")}`;
}

/** Cut with a visible marker, so a shortened question never reads as the whole one. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
