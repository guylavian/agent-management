import { Ajv, type ValidateFunction } from "ajv";
import type { McpTool } from "./toolhive-client.ts";

/**
 * Validates model-generated tool arguments against the MCP tool's inputSchema
 * BEFORE ToolHive is called (TDD §13 pre-flight). A failure here means the
 * backend is never invoked.
 */
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const compiled = new WeakMap<object, ValidateFunction>();

export interface ArgumentValidation {
  valid: boolean;
  reason?: "SCHEMA_VALIDATION_FAILED";
  detail?: string;
}

export function validateToolArguments(tool: McpTool, args: unknown): ArgumentValidation {
  const schema = tool.inputSchema;
  const cached = compiled.get(schema);
  let validate: ValidateFunction;
  if (cached === undefined) {
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      // an unusable approved schema is a fail-closed condition, not a pass
      return { valid: false, reason: "SCHEMA_VALIDATION_FAILED", detail: `invalid tool schema: ${String(error)}` };
    }
    compiled.set(schema, validate);
  } else {
    validate = cached;
  }
  if (validate(args)) return { valid: true };
  const first = validate.errors?.[0];
  const detail = first === undefined ? "arguments did not match tool schema" : `${first.instancePath || "(root)"} ${first.message ?? "invalid"}`;
  return { valid: false, reason: "SCHEMA_VALIDATION_FAILED", detail };
}
