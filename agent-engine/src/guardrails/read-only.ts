import type { ToolDescriptor } from "../tools/port.ts";

const MUTATION_NAME = /(?:^|_)(?:create|update|delete|remove|write|set|put|patch|sync|apply|assign|unassign|propose|render|reload|quit|snapshot|clean|run|exec|restart|scale|rollout)(?:_|$)/iu;

/**
 * Runtime backstop for the read-only posture, in ADDITION to the approved
 * catalog's `readOnlyVerified` flag and the Agent's own `readOnly` setting.
 *
 * Safety is never inferred from the name alone — the name check only ever
 * REMOVES a tool that the catalog already approved. A tool is visible only when
 * the catalog approved it, the Agent's policy grants it, authorization allows
 * it, the server did not mark it destructive, and its name does not look like a
 * mutation. Any one of those failing hides it.
 */
export function isReadOnlyTool(tool: ToolDescriptor): boolean {
  return tool.annotations?.destructiveHint !== true && tool.annotations?.readOnlyHint !== false && !MUTATION_NAME.test(tool.name);
}
