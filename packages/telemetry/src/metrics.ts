const METRICS = [
  "sre_requests_total", "sre_request_duration_seconds", "sre_route_stage1_total",
  "sre_manager_invocations_total", "sre_manager_abstentions_total", "sre_specialist_invocations_total",
  "sre_round2_total", "sre_tool_calls_total", "sre_tool_call_duration_seconds", "sre_tool_errors_total",
  "sre_rag_duration_seconds", "sre_evidence_total", "sre_missing_evidence_total", "sre_tier_l_invocations_total",
  "sre_authz_denials_total", "sre_invalid_model_outputs_total",
] as const;
const counters = new Map<string, number>(METRICS.map((name) => [name, 0]));

export function incrementMetric(name: string, value = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

export function renderMetrics(): string {
  return [...counters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `# TYPE ${name} counter\n${name} ${value}`).join("\n") + "\n";
}

export function resetMetrics(): void { counters.clear(); for (const name of METRICS) counters.set(name, 0); }
