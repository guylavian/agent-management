import type { RunNode, RunRecord } from "./run-store.ts";

/**
 * Builds the multi-agent execution graph (TDD §45) from the SpecialistResults
 * the runtime already produces. Every node is derived from something that
 * actually happened — a routed agent, a recorded Evidence item, a returned
 * error — so the graph cannot show a step the runtime did not take.
 *
 * The graph is a tree with fan-out (Manager → N specialists → synthesis) and
 * represents the bounded Round 2 as an explicit escalation node, rather than
 * flattening everything into one timeline.
 *
 * Deliberately absent: the answer text, model reasoning, tool arguments and
 * tool payloads. A run graph shows the shape of an investigation, not its
 * contents.
 */

/** The subset of SpecialistResult this module needs, so it does not depend on the runtime. */
export interface SpecialistResultLike {
  agentId: string;
  status: "complete" | "partial" | "failed";
  summary?: string;
  needsDomain?: string[];
  errors?: Array<{ code: string; message: string }>;
  evidence: Array<{
    id: string;
    kind: string;
    system: string;
    tool?: string;
    status: string;
    agentId?: string;
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
}

export function buildRunRecord(input: BuildRunInput): RunRecord {
  const startedAtIso = input.startedAt.toISOString();
  const nodes: RunNode[] = [];
  const workloads = new Set<string>();
  const modelProfiles = new Set<string>();
  let toolCalls = 0;
  let deniedToolCalls = 0;

  nodes.push({
    id: "manager.route",
    kind: "manager.route",
    label: `routed to ${input.routedAgents.length || "no"} specialist${input.routedAgents.length === 1 ? "" : "s"}`,
    status: input.routedAgents.length > 0 ? "ok" : "failed",
    startedAt: startedAtIso,
    durationMs: 0,
    round: 1,
  });

  const firstRound = new Set(input.routedAgents);
  for (const result of input.results) {
    // an agent that ran without being in the initial routing came from Round 2
    const round = firstRound.has(result.agentId) ? 1 : 2;
    const specialistId = `specialist.${result.agentId}`;
    const workload = input.workloadFor(result.agentId);
    if (workload !== undefined) workloads.add(workload);
    const profile = input.modelProfileFor(result.agentId);
    if (profile !== undefined) modelProfiles.add(profile);

    nodes.push({
      id: specialistId,
      kind: "specialist",
      label: result.agentId,
      parentId: "manager.route",
      status: result.status === "failed" ? "failed" : "ok",
      startedAt: startedAtIso,
      durationMs: 0,
      agentId: result.agentId,
      round,
    });

    if (workload !== undefined) {
      nodes.push({
        id: `${specialistId}.workload`,
        kind: "workload.token",
        // the client id is an identifier, never the token itself
        label: workload,
        parentId: specialistId,
        status: "ok",
        startedAt: startedAtIso,
        durationMs: 0,
        agentId: result.agentId,
        round,
      });
    }

    for (const [index, evidence] of result.evidence.entries()) {
      const denied = evidence.status === "failed" && evidence.kind === "missing";
      if (evidence.tool !== undefined) {
        toolCalls += 1;
        if (denied) deniedToolCalls += 1;
        nodes.push({
          id: `${specialistId}.tool.${index}`,
          kind: "toolhive.call",
          label: `${evidence.system}/${evidence.tool}`,
          parentId: specialistId,
          status: denied ? "denied" : evidence.status === "failed" ? "failed" : "ok",
          startedAt: startedAtIso,
          durationMs: 0,
          agentId: result.agentId,
          mcp: evidence.system,
          tool: evidence.tool,
          round,
        });
      }
      nodes.push({
        id: `${specialistId}.evidence.${index}`,
        kind: "evidence",
        label: `${evidence.kind}: ${evidence.id}`,
        parentId: evidence.tool === undefined ? specialistId : `${specialistId}.tool.${index}`,
        status: evidence.status === "failed" ? "failed" : "ok",
        startedAt: startedAtIso,
        durationMs: 0,
        agentId: result.agentId,
        round,
      });
    }

    for (const domain of result.needsDomain ?? []) {
      nodes.push({
        id: `${specialistId}.escalate.${domain}`,
        kind: "domain.escalation",
        label: `needs ${domain}`,
        parentId: specialistId,
        status: "ok",
        startedAt: startedAtIso,
        durationMs: 0,
        agentId: result.agentId,
        round,
      });
    }
  }

  nodes.push({
    id: "synthesis",
    kind: "synthesis",
    label: input.synthesized ? "synthesized across specialists" : "deterministic response",
    // fan-in: every specialist converges here
    parentId: "manager.route",
    status: input.status === "failed" ? "failed" : "ok",
    startedAt: startedAtIso,
    durationMs: input.durationMs,
  });

  return {
    requestId: input.requestId,
    startedAt: startedAtIso,
    durationMs: input.durationMs,
    status: input.status,
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
