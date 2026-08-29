import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { agentDocumentSchema } from "../contracts/agent-schema/src/index.ts";
import { agentDeploymentOverlaySchema, modelBindingsSchema, renderedAgentValuesSchema } from "../shared/config-loader/src/agent-catalog.ts";
import { DEPLOY_ROOT } from "../shared/config-loader/src/app-config.ts";

/**
 * JSON Schema is GENERATED from the Zod schemas the runtime actually enforces,
 * never hand-written. A hand-written copy is a second source of truth that
 * drifts silently; this one fails CI the moment it diverges.
 */
const outputs: Array<[string, z.core.$ZodType]> = [
  ["contracts/agent-schema/generated/agent.schema.json", agentDocumentSchema],
  [`${DEPLOY_ROOT}/schemas/agent-overlay.schema.json`, agentDeploymentOverlaySchema],
  [`${DEPLOY_ROOT}/schemas/model-bindings.schema.json`, modelBindingsSchema],
  [`${DEPLOY_ROOT}/schemas/rendered-agent-values.schema.json`, renderedAgentValuesSchema],
];

for (const [path, schema] of outputs) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-07" }), null, 2)}\n`, "utf8");
  console.log(`generated ${path}`);
}
