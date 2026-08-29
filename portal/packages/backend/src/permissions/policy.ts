import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import type { BackstageUserInfo } from '@backstage/backend-plugin-api';
import { AuthorizeResult, type PolicyDecision } from '@backstage/plugin-permission-common';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import type { PermissionPolicy, PolicyQuery, PolicyQueryUser } from '@backstage/plugin-permission-node';
import type { Config } from '@backstage/config';

/**
 * Management-plane permission policy.
 *
 * Replaces `plugin-permission-backend-module-allow-all-policy`, under which
 * every `agent.*` permission the plugin defines was granted to everyone,
 * including a guest. The permissions existed; nothing enforced them.
 *
 * The rule is deliberately asymmetric:
 *
 *   agent.read / mcp.read / run.read / evaluation.read   any AUTHENTICATED user
 *   every other agent.*                                  members of a configured group
 *
 * Reading the management plane is an observability concern. PROPOSING a change
 * to an Agent — its prompt, its tool access, its lifecycle — is a privileged act
 * even though it only opens a pull request, because the pull request is the
 * mechanism by which production changes.
 *
 * This is a DIFFERENT authorization domain from Agent → MCP → Tool. Holding
 * `agent.access.edit` lets a human propose a policy change; it never grants an
 * Agent access to anything. The runtime re-decides that on every tool call.
 *
 * INTEGRATION BOUNDARY — the group→role mapping comes from the identity
 * provider through Backstage's ownership entity refs. Which enterprise groups
 * carry which platform role is environment-specific and is configured under
 * `permission.agentManagement.*`. With no configuration, no group qualifies and
 * every write is denied: unmapped must not mean unrestricted.
 */

const READ_PERMISSIONS = new Set(['agent.read', 'mcp.read', 'run.read', 'evaluation.read']);

const ALLOW: PolicyDecision = { result: AuthorizeResult.ALLOW };
const DENY: PolicyDecision = { result: AuthorizeResult.DENY };

export interface AgentManagementPolicyOptions {
  /** entity refs (usually `group:default/<name>`) whose members may propose Agent changes */
  adminGroups: string[];
}

export function readPolicyOptions(config: Config): AgentManagementPolicyOptions {
  const groups = config.getOptionalStringArray('permission.agentManagement.adminGroups') ?? [];
  return { adminGroups: groups.map(group => group.toLocaleLowerCase('en-US')) };
}

export class AgentManagementPermissionPolicy implements PermissionPolicy {
  readonly #adminGroups: Set<string>;

  constructor(options: AgentManagementPolicyOptions) {
    this.#adminGroups = new Set(options.adminGroups);
  }

  async handle(request: PolicyQuery, user?: PolicyQueryUser): Promise<PolicyDecision> {
    const name = request.permission.name;

    // an unauthenticated caller gets nothing from the management plane
    if (user === undefined) return DENY;

    if (!name.startsWith('agent.') && !READ_PERMISSIONS.has(name)) {
      // core Backstage permissions (catalog, scaffolder, search) keep their
      // existing behaviour; narrowing them is a separate decision from this one
      return ALLOW;
    }

    if (READ_PERMISSIONS.has(name)) return ALLOW;

    return this.#isAdmin(user.info) ? ALLOW : DENY;
  }

  #isAdmin(info: BackstageUserInfo): boolean {
    // ownershipEntityRefs carries the user's own ref plus every group it belongs
    // to, which is where the IdP's group claim lands after sign-in resolution
    return info.ownershipEntityRefs.some(ref => this.#adminGroups.has(ref.toLocaleLowerCase('en-US')));
  }
}

export const agentManagementPermissionPolicy = createBackendModule({
  pluginId: 'permission',
  moduleId: 'agent-management-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint, config: coreServices.rootConfig, logger: coreServices.rootLogger },
      async init({ policy, config, logger }) {
        const options = readPolicyOptions(config);
        if (options.adminGroups.length === 0) {
          // loud, because the consequence is a portal where nobody can propose
          // a change — which is the correct failure, but only if it is visible
          logger.warn(
            'permission.agentManagement.adminGroups is not configured: every Agent write permission will be DENIED. Set it to the groups your IdP issues.',
          );
        }
        policy.setPolicy(new AgentManagementPermissionPolicy(options));
      },
    });
  },
});
