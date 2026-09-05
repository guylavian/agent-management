import { z } from "zod";

export const requestIdentitySchema = z.object({
  subject: z.string().min(1),
  groups: z.array(z.string()),
  roles: z.array(z.string()),
  requestId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  /**
   * The manager-signed delegation JWT this identity was verified from, carried
   * so a token exchange can present the HUMAN as a verifiable assertion rather
   * than as a bare subject string. Attached per request by
   * `withDelegationAssertion`; never stored on a long-lived exchanger.
   */
  assertion: z.string().min(1).optional(),
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

/**
 * The only workload token a specialist accepts when no workload OIDC client is
 * configured. Shared so the local provider and the specialist check cannot
 * drift apart; production config forbids the mock client, so this literal is
 * unreachable there.
 */
export const MOCK_WORKLOAD_TOKEN = "mock-manager-workload-token-for-local-tests";
