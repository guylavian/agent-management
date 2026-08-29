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

// `Stage1RoutingResult` stood here: a pre-model routing verdict with `resolved`,
// `candidates` and a `reasonCode`, from when code decided who ran and the model
// was consulted only if code could not. There is no stage 1 any more — the
// Manager decides once, and the runtime's job is to refuse a bad answer.
