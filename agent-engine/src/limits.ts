/**
 * Deadline plumbing for the bounded loop. Every model turn and every tool call
 * runs under a signal derived from the request's single absolute deadline, so a
 * stage can shorten the budget but never extend it.
 */
export async function withDeadline<T>(deadline: number, action: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("deadline exceeded"), { code: "REQUEST_TIMEOUT" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("deadline exceeded"), { code: "REQUEST_TIMEOUT" })), remaining);
  const signal = parent === undefined ? controller.signal : AbortSignal.any([controller.signal, parent]);
  try { return await action(signal); } finally { clearTimeout(timer); }
}

export function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "TOOL_FAILED";
}

export function isTransient(code: string): boolean {
  return ["MCP_TIMEOUT", "MCP_UNAVAILABLE", "REQUEST_TIMEOUT", "ECONNRESET"].includes(code);
}
