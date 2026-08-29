import { z } from "zod";

export const managerRouteSchema = z.object({
  agent: z.string(),
  task: z.string().min(1).max(2000),
  /**
   * One sentence on why this specialist, for the run trace.
   *
   * This is an audit summary the Manager is asked to state, not a window into
   * how it decided — the distinction that matters is that the model is
   * answering "which agent, and why that one" on the record, rather than
   * having private deliberation captured. Nothing reads it back: it is
   * recorded and displayed, never fed to another model or used to authorize.
   */
  rationale: z.string().max(300).optional(),
}).strict();
export type ManagerRoute = z.infer<typeof managerRouteSchema>;

export const managerDecisionSchema = z.object({
  // one route per selected specialist; each carries a distinct focused task
  routes: z.array(managerRouteSchema),
  // No longer requested of the model: nothing read it, and every required
  // property is a token the model must spend before `abstain` arrives. Still
  // accepted, so a producer that sends one is not rejected at the boundary.
  confidence: z.number().min(0).max(1).optional(),
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
