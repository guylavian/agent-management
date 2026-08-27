import { z } from "zod";

export const managerDecisionSchema = z.object({
  agents: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  alternates: z.array(z.string()).optional(),
  abstain: z.boolean(),
  reasonCodes: z.array(z.string()).optional(),
}).strict();
export type ManagerDecision = z.infer<typeof managerDecisionSchema>;

export type RequestIntent = "factual" | "diagnostic";

export interface Stage1RoutingResult {
  resolved: boolean;
  decision?: { agents: string[]; reasonCode: string };
  candidates?: string[];
  entities: Record<string, string>;
  intent: RequestIntent;
}
