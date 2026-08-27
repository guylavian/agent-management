import { writeFileSync } from "node:fs";
import { z } from "zod";
import { agentDocumentSchema } from "../packages/config/src/schemas.ts";

const schema = z.toJSONSchema(agentDocumentSchema, { target: "draft-07" });
writeFileSync("schemas/agent.schema.json", `${JSON.stringify(schema, null, 2)}\n`, "utf8");
