import { z } from "zod";

export const requestIdentitySchema = z.object({
  subject: z.string().min(1),
  groups: z.array(z.string()),
  roles: z.array(z.string()),
  requestId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
}).strict();

export type RequestIdentity = z.infer<typeof requestIdentitySchema>;

/**
 * Workload identity of one Agent — TDD §7. Kept strictly separate from
 * {@link RequestIdentity}: the human authorizes the request, the workload
 * executes it, and neither substitutes for the other.
 */
export const workloadIdentitySchema = z.object({
  clientId: z.string().min(1),
  provider: z.literal("keycloak"),
  agentId: z.string().min(1),
}).strict();

export type WorkloadIdentity = z.infer<typeof workloadIdentitySchema>;
