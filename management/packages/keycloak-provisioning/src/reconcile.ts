import type { KeycloakAdmin } from "./admin-client.ts";
import type { DesiredClient } from "./desired-state.ts";

/**
 * Idempotent reconciliation of desired → actual Keycloak state (TDD §32).
 *
 * Running it twice against an unchanged Agent definition performs no writes and
 * reports "unchanged". It creates, updates and disables; it never deletes a
 * workload identity, because destroying one silently discards the audit
 * linkage of everything that identity ever did.
 */

export type ReconcileAction = "created" | "updated" | "disabled" | "unchanged";

export interface ReconcileResult {
  clientId: string;
  action: ReconcileAction;
  /** human-readable, non-sensitive description of each applied change */
  changes: string[];
}

export interface ReconcileOptions {
  /** report what would change without writing — used by the portal preview */
  dryRun?: boolean;
}

export async function reconcileClient(admin: KeycloakAdmin, desired: DesiredClient, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const dryRun = options.dryRun === true;
  const changes: string[] = [];
  const existing = await admin.getClient(desired.clientId);

  if (existing === undefined) {
    changes.push(`create confidential service-account client ${desired.clientId}`);
    for (const scope of desired.optionalClientScopes) changes.push(`attach optional scope ${scope.name} (aud=${scope.audience})`);
    for (const role of desired.roles) changes.push(`grant ${role.name}`);
    if (dryRun) return { clientId: desired.clientId, action: "created", changes };
    for (const scope of desired.optionalClientScopes) await admin.ensureAudienceScope(scope);
    const id = await admin.createClient(desired);
    for (const scope of desired.optionalClientScopes) await admin.addOptionalClientScope(id, scope.name);
    for (const role of desired.roles) await admin.createClientRole(id, role.name, role.description);
    return { clientId: desired.clientId, action: "created", changes };
  }

  const id = existing.id;

  // client-level settings. A drifted flow setting is a real privilege change:
  // a workload client must never expose an interactive or password flow.
  if (existing.enabled !== desired.enabled) changes.push(`set enabled=${desired.enabled}`);
  if (existing.serviceAccountsEnabled !== true) changes.push("enable service account");
  if (existing.standardFlowEnabled !== false) changes.push("disable standard flow");
  if (existing.publicClient !== false) changes.push("make client confidential");
  for (const [key, value] of Object.entries(desired.attributes)) {
    if (existing.attributes?.[key] !== value) changes.push(`set attribute ${key}=${value}`);
  }
  const clientChanged = changes.length > 0;

  // audience scopes: exactly the MCPs in the canonical access policy
  const actualScopes = new Set(await admin.listOptionalClientScopes(id));
  const desiredScopes = new Set(desired.optionalClientScopes.map((scope) => scope.name));
  const scopesToAdd = desired.optionalClientScopes.filter((scope) => !actualScopes.has(scope.name));
  const scopesToRemove = [...actualScopes].filter((name) => !desiredScopes.has(name) && name.startsWith("sre-toolhive-"));
  for (const scope of scopesToAdd) changes.push(`attach optional scope ${scope.name} (aud=${scope.audience})`);
  for (const name of scopesToRemove) changes.push(`detach optional scope ${name}`);

  // tool grants: revoking a removed grant is the whole point, so roles are removed
  const actualRoles = new Set(await admin.listClientRoles(id));
  const desiredRoles = new Set(desired.roles.map((role) => role.name));
  const rolesToAdd = desired.roles.filter((role) => !actualRoles.has(role.name));
  const rolesToRemove = [...actualRoles].filter((name) => !desiredRoles.has(name));
  for (const role of rolesToAdd) changes.push(`grant ${role.name}`);
  for (const name of rolesToRemove) changes.push(`revoke ${name}`);

  if (changes.length === 0) return { clientId: desired.clientId, action: "unchanged", changes };
  if (dryRun) return { clientId: desired.clientId, action: resolveAction(desired, clientChanged), changes };

  if (clientChanged) await admin.updateClient(id, desired);
  for (const scope of scopesToAdd) {
    await admin.ensureAudienceScope(scope);
    await admin.addOptionalClientScope(id, scope.name);
  }
  for (const name of scopesToRemove) await admin.removeOptionalClientScope(id, name);
  for (const role of rolesToAdd) await admin.createClientRole(id, role.name, role.description);
  for (const name of rolesToRemove) await admin.removeClientRole(id, name);

  return { clientId: desired.clientId, action: resolveAction(desired, clientChanged), changes };
}

function resolveAction(desired: DesiredClient, clientChanged: boolean): ReconcileAction {
  return clientChanged && !desired.enabled ? "disabled" : "updated";
}

/**
 * Reconcile every Agent. One failing client must not abort the rest, so the
 * caller sees the full picture rather than whatever happened before the first
 * error.
 */
export async function reconcileAll(admin: KeycloakAdmin, desired: DesiredClient[], options: ReconcileOptions = {}): Promise<Array<ReconcileResult | { clientId: string; error: string }>> {
  const settled = await Promise.allSettled(desired.map((client) => reconcileClient(admin, client, options)));
  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : { clientId: desired[index]?.clientId ?? "unknown", error: result.reason instanceof Error ? result.reason.message : String(result.reason) },
  );
}
