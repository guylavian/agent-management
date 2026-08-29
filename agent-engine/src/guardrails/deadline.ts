import { engineError } from "../errors/index.ts";

/**
 * Deadline plumbing for the bounded loop. Every model turn and every tool call
 * runs under a signal derived from the request's single absolute deadline, so a
 * stage can shorten the budget but never extend it.
 */
export async function withDeadline<T>(deadline: number, action: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw engineError("REQUEST_TIMEOUT", "deadline exceeded");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(engineError("REQUEST_TIMEOUT", "deadline exceeded")), remaining);
  const signal = parent === undefined ? controller.signal : AbortSignal.any([controller.signal, parent]);
  try { return await action(signal); } finally { clearTimeout(timer); }
}
