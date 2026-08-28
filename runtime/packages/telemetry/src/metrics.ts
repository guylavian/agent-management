/**
 * Minimal Prometheus text-exposition registry with correct metric types
 * (TDD §26): counters for events, histograms for durations, a gauge for
 * in-flight requests. No high-cardinality labels are ever accepted here.
 */

const COUNTERS = [
  "sre_requests_total", "sre_route_stage1_total", "sre_manager_invocations_total",
  "sre_manager_abstentions_total", "sre_specialist_invocations_total", "sre_round2_total",
  "sre_tool_calls_total", "sre_tool_errors_total", "sre_evidence_total", "sre_missing_evidence_total",
  "sre_tier_l_invocations_total", "sre_tier_l_failures_total", "sre_agent_failures_total",
  "sre_authz_denials_total", "sre_invalid_model_outputs_total", "sre_invalid_tool_arguments_total",
] as const;

// interactive SRE latency buckets, in seconds
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 15, 30, 45] as const;
const HISTOGRAMS = [
  "sre_request_duration_seconds", "sre_agent_duration_seconds",
  "sre_tool_call_duration_seconds", "sre_rag_duration_seconds", "sre_synthesis_duration_seconds",
] as const;
const GAUGES = ["sre_inflight_requests"] as const;

type Histogram = { buckets: number[]; counts: number[]; sum: number; count: number };

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const histograms = new Map<string, Histogram>();

function reset(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
  for (const name of COUNTERS) counters.set(name, 0);
  for (const name of GAUGES) gauges.set(name, 0);
  for (const name of HISTOGRAMS) histograms.set(name, { buckets: [...DURATION_BUCKETS], counts: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 });
}
reset();

export function incrementMetric(name: string, value = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

export function observeInflight(delta: number): void {
  gauges.set("sre_inflight_requests", Math.max(0, (gauges.get("sre_inflight_requests") ?? 0) + delta));
}

export function observeDuration(name: string, seconds: number): void {
  const histogram = histograms.get(name);
  if (histogram === undefined) return;
  histogram.sum += seconds;
  histogram.count += 1;
  for (let i = 0; i < histogram.buckets.length; i += 1) {
    if (seconds <= (histogram.buckets[i] as number)) histogram.counts[i] = (histogram.counts[i] as number) + 1;
  }
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, value] of [...counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
  }
  for (const [name, value] of [...gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
  }
  for (const [name, histogram] of [...histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# TYPE ${name} histogram`);
    let cumulative = 0;
    for (let i = 0; i < histogram.buckets.length; i += 1) {
      cumulative = histogram.counts[i] as number;
      lines.push(`${name}_bucket{le="${histogram.buckets[i]}"} ${cumulative}`);
    }
    lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`, `${name}_sum ${histogram.sum}`, `${name}_count ${histogram.count}`);
  }
  return `${lines.join("\n")}\n`;
}

export function resetMetrics(): void { reset(); }
