import type { ModelClient } from "@sre/llm";
import { z } from "zod";
import type { GradeInput, GradeResult, Grader } from "./grader.ts";

const outputSchema = z.object({ claims: z.array(z.object({ claim: z.string(), supported: z.boolean(), supportingEvidenceIds: z.array(z.string()), reasonCode: z.string() }).strict()) }).strict();
const jsonSchema = { title: "ClaimGrades", type: "object", additionalProperties: false, required: ["claims"], properties: { claims: { type: "array", items: { type: "object", additionalProperties: false, required: ["claim", "supported", "supportingEvidenceIds", "reasonCode"], properties: { claim: { type: "string" }, supported: { type: "boolean" }, supportingEvidenceIds: { type: "array", items: { type: "string" } }, reasonCode: { type: "string" } } } } } } satisfies Record<string, unknown>;

export class TierLJudgeGrader implements Grader {
  readonly kind = "tier-l-judge" as const;
  readonly #model: ModelClient;
  constructor(model: ModelClient) { this.#model = model; }
  async grade(input: GradeInput): Promise<GradeResult> {
    const response = await this.#model.chat({ model: "tier-l-judge", messages: [{ role: "system", content: "Grade each material claim as supported only when the cited evidence materially supports it. Return structured JSON." }, { role: "user", content: JSON.stringify(input) }], guidedJsonSchema: jsonSchema });
    const output = outputSchema.parse(JSON.parse(response.content ?? ""));
    return { claims: output.claims, unsupportedClaimRate: output.claims.length === 0 ? 0 : output.claims.filter((claim) => !claim.supported).length / output.claims.length };
  }
}
