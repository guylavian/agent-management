import { z } from "zod";

export const managerRouteSchema = z.object({
  agent: z.string(),
  task: z.string().min(1).max(2000),
}).strict();
export type ManagerRoute = z.infer<typeof managerRouteSchema>;

export const managerDecisionSchema = z.object({
  // one route per selected specialist; each carries a distinct focused task
  routes: z.array(managerRouteSchema),
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
