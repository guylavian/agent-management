import { AuthorizeResult } from '@backstage/plugin-permission-common';
import type { PolicyQueryUser } from '@backstage/plugin-permission-node';
import { AgentManagementPermissionPolicy } from './policy';

/**
 * The management plane decides WHO MAY PROPOSE a change to an Agent. It is a
 * different authorization domain from Agent → MCP → Tool, and it was previously
 * not enforced at all: the backend ran the allow-all policy, so every `agent.*`
 * permission was granted to everyone including a guest.
 */

const permission = (name: string) => ({ permission: { name, attributes: {}, type: 'basic' as const } });

function user(refs: string[]): PolicyQueryUser {
  return {
    credentials: {} as PolicyQueryUser['credentials'],
    info: { userEntityRef: refs[0] ?? 'user:default/nobody', ownershipEntityRefs: refs },
  };
}

const policy = new AgentManagementPermissionPolicy({ adminGroups: ['group:default/sre-platform'] });

describe('AgentManagementPermissionPolicy', () => {
  it('denies everything to an unauthenticated caller', async () => {
    for (const name of ['agent.read', 'agent.create', 'catalog.entity.read']) {
      await expect(policy.handle(permission(name))).resolves.toEqual({ result: AuthorizeResult.DENY });
    }
  });

  it('lets any authenticated user read the management plane', async () => {
    const anyone = user(['user:default/alice']);
    for (const name of ['agent.read', 'mcp.read', 'run.read', 'evaluation.read']) {
      await expect(policy.handle(permission(name), anyone)).resolves.toEqual({ result: AuthorizeResult.ALLOW });
    }
  });

  /**
   * Proposing a change only opens a pull request — but the pull request is the
   * mechanism by which production changes, so it is a privileged act.
   */
  it('denies every Agent write to a user outside the admin groups', async () => {
    const anyone = user(['user:default/alice', 'group:default/random-team']);
    for (const name of ['agent.create', 'agent.edit', 'agent.disable', 'agent.prompt.edit', 'agent.access.edit', 'agent.tools.edit', 'agent.gitops.createPr']) {
      await expect(policy.handle(permission(name), anyone)).resolves.toEqual({ result: AuthorizeResult.DENY });
    }
  });

  it('allows Agent writes to a member of a configured admin group', async () => {
    const admin = user(['user:default/bob', 'group:default/sre-platform']);
    for (const name of ['agent.create', 'agent.access.edit', 'agent.gitops.createPr']) {
      await expect(policy.handle(permission(name), admin)).resolves.toEqual({ result: AuthorizeResult.ALLOW });
    }
  });

  it('denies every Agent write when no admin group is configured', async () => {
    // unmapped must not mean unrestricted: a deployment whose IdP group mapping
    // is not wired yet is locked down, not wide open
    const unmapped = new AgentManagementPermissionPolicy({ adminGroups: [] });
    const admin = user(['user:default/bob', 'group:default/sre-platform']);
    await expect(unmapped.handle(permission('agent.create'), admin)).resolves.toEqual({ result: AuthorizeResult.DENY });
    await expect(unmapped.handle(permission('agent.read'), admin)).resolves.toEqual({ result: AuthorizeResult.ALLOW });
  });

  it('leaves core Backstage permissions to their existing behaviour', async () => {
    const anyone = user(['user:default/alice']);
    await expect(policy.handle(permission('catalog.entity.read'), anyone)).resolves.toEqual({ result: AuthorizeResult.ALLOW });
  });
});
