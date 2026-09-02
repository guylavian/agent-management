import { engineError } from "../errors/index.ts";

/**
 * Deadline plumbing for the bounded loop. Every model turn, tool call and
 * lifecycle stage runs under a signal derived from the request's single
 * absolute deadline, so a stage can shorten the budget but never extend it.
 *
 * The signal is a courtesy; the RACE is the guarantee. A port that ignores its
 * signal is abandoned when the timer fires — its promise keeps running but its
 * result is discarded and its rejection is swallowed, so a non-cooperative
 * adapter can delay nothing and crash nothing.
 */
export async function withDeadline<T>(deadline: number, action: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw engineError("REQUEST_TIMEOUT", "deadline exceeded");
  if (parent?.aborted === true) throw abortReason(parent.reason);
  const controller = new AbortController();
  // Node clamps a setTimeout delay above 2^31-1 to 1ms; an unclamped huge
  // deadline would spuriously abort every call almost immediately
  const timer = setTimeout(() => controller.abort(engineError("REQUEST_TIMEOUT", "deadline exceeded")), Math.min(remaining, 2 ** 31 - 1));
  const signal = parent === undefined ? controller.signal : AbortSignal.any([controller.signal, parent]);
  const rejection = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortReason(signal.reason)), { once: true });
  });
  // the signal may still abort after the race settles (parent cancellation, or
  // our own timer had the action thrown synchronously) — never let that surface
  rejection.catch(() => { /* handled by the race when it matters */ });
  // async-wrap so a SYNCHRONOUS throw from the action still routes through the
  // race and the finally, instead of skipping timer cleanup
  const pending = (async () => action(signal))();
  pending.catch(() => { /* abandoned after the race: must never surface as an unhandled rejection */ });
  try {
    return await Promise.race([pending, rejection]);
  } finally {
    clearTimeout(timer);
  }
}

/** An abort reason may be anything; only an Error travels the taxonomy well. */
function abortReason(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}
