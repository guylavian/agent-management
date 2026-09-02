import { Ajv, type ValidateFunction } from "ajv";
import type { ToolDescriptor } from "./port.ts";

/**
 * Validates model-generated tool arguments against the tool's published input
 * schema BEFORE the provider is called. A failure here means the backend is
 * never invoked.
 *
 * Arguments are the model's output, and the model is untrusted, so this is a
 * trust boundary rather than a convenience: it is the only thing standing
 * between a hallucinated argument object and a real backend.
 */
// coerceTypes bends SCALARS to the published schema. Providers routinely
// declare `type: string` for a parameter whose own description invites a
// number — "accepts Unix epoch seconds" on a string-typed timestamp is the
// canonical case — and a model that follows the description then fails the
// type. Coercing 1699999999 to "1699999999" is contract repair, not leniency:
// coercion cannot invent structure, so objects, arrays, missing required
// fields and length/enum violations still fail, and the trust boundary keeps
// its shape.
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true, coerceTypes: true });

export type ArgumentValidation =
  | { valid: true; value: Record<string, unknown> }
  | { valid: false; reason: "SCHEMA_VALIDATION_FAILED"; detail: string };

export function validateToolArguments(tool: ToolDescriptor, args: unknown): ArgumentValidation {
  const schema = tool.inputSchema;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    // an unusable approved schema is a fail-closed condition, not a pass
    return { valid: false, reason: "SCHEMA_VALIDATION_FAILED", detail: `invalid tool schema: ${String(error)}` };
  }
  // Deep clone via JSON round-trip to avoid mutating the caller's object while allowing coercion
  const cloned = JSON.parse(JSON.stringify(args)) as unknown;
  if (validate(cloned)) return { valid: true, value: cloned as Record<string, unknown> };
  const first = validate.errors?.[0];
  const detail = first === undefined ? "arguments did not match tool schema" : `${first.instancePath || "(root)"} ${first.message ?? "invalid"}`;
  return { valid: false, reason: "SCHEMA_VALIDATION_FAILED", detail };
}
