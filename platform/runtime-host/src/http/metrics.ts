import { observeDuration } from "@sre/telemetry";

/** Starts a duration timer for a request-scoped metric; call the returned function when the request ends. */
export function startTimer(metric: string): () => void {
  const startedAt = performanceNow();
  return () => observeDuration(metric, (performanceNow() - startedAt) / 1000);
}

function performanceNow(): number { return Number(process.hrtime.bigint() / 1_000_000n); }


