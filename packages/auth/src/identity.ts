import { z } from "zod";

export const requestIdentitySchema = z.object({
  subject: z.string().min(1),
  groups: z.array(z.string()),
  roles: z.array(z.string()),
  requestId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
}).strict();

export type RequestIdentity = z.infer<typeof requestIdentitySchema>;
