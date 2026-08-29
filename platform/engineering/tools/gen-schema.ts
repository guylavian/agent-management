import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { agentDocumentSchema } from "../../libs/contracts/agent-schema/src/index.ts";
import { agentDeploymentOverlaySchema, modelBindingsSchema, renderedAgentValuesSchema } from "../../libs/shared/config-loader/src/agent-catalog.ts";

/**
 * JSON Schema is GENERATED from the Zod schemas the runtime actually enforces,
 * never hand-written. A hand-written copy is a second source of truth that
 * drifts silently; this one fails CI the moment it diverges.
 */
const outputs: Array<[string, z.core.$ZodType]> = [
  ["libs/contracts/agent-schema/generated/agent.schema.json", agentDocumentSchema],
  ["deploy/schemas/agent-overlay.schema.json", agentDeploymentOverlaySchema],
  ["deploy/schemas/model-bindings.schema.json", modelBindingsSchema],
  ["deploy/schemas/rendered-agent-values.schema.json", renderedAgentValuesSchema],
];

for (const [path, schema] of outputs) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-07" }), null, 2)}\n`, "utf8");
  console.log(`generated ${path}`);
}
