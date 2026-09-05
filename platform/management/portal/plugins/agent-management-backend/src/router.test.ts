// backstage-cli package test runs jest; describe/it/expect are global.
import express from 'express';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter } from './router';
import type { AgentProposal, GitOpsPublisher } from './services/GitOpsPublisher';
import type { RuntimeManagementClient } from './services/RuntimeManagementClient';

/**
 * THE AGENT INVENTORY IS A JOIN ACROSS BOTH PLANES.
 *
 * The runtime contributes everything in Git — desired state joined to Argo and
 * pod status. This backend contributes the one state the runtime cannot see: an
 * Agent whose pull request is still OPEN. The runtime reads the repository as
 * Argo synced it, so an unmerged branch does not exist to it.
 *
 * What must not happen is the join becoming a second inventory: the runtime
 * always wins on a name it knows, and a failure to list proposals must cost the
 * pending rows and nothing else.
 */
const ALLOW = { authorize: async () => [{ result: AuthorizeResult.ALLOW }] } as never;
const HTTP_AUTH = { credentials: async () => ({ principal: { type: 'user' } }) } as never;

function runtimeReturning(agents: unknown[], extra: Record<string, unknown> = {}): RuntimeManagementClient {
  return {
    configured: true,
    get: async () => ({ agents, revision: 'r1', loadedAt: 'now', ...extra }) as never,
    getBinary: async () => undefined,
    post: async () => ({ status: 200, body: {} as never }),
  };
}

function gitopsReturning(proposals: AgentProposal[] | Error): GitOpsPublisher {
  return {
    configured: true,
    createPullRequest: async () => ({ status: 'created' as const }),
    pullRequestState: async () => ({ state: 'open' as const }),
    listProposals: async () => {
      if (proposals instanceof Error) throw proposals;
      return proposals;
    },
  };
}

async function listAgents(runtime: RuntimeManagementClient, gitops: GitOpsPublisher) {
  const app = express();
  app.use(await createRouter({ httpAuth: HTTP_AUTH, permissions: ALLOW, runtime, gitops }));
  const server: Server = await new Promise(resolve => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/agents`);
    return (await response.json()) as {
      agents: Array<{ id: string; reconciliation?: { status: string }; toolCount: number }>;
      proposalsError?: string;
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const merged = { id: 'keycloak', displayName: 'Keycloak', owner: 'sre', lifecycle: 'active', enabled: true, modelProfile: 'tool-caller', modelTier: 'small', mcpCount: 1, toolCount: 4, workloadClientId: 'sre-agent-keycloak', readOnly: true, reconciliation: { status: 'active' } };
const proposal: AgentProposal = { agentId: 'kafka', kind: 'add', branch: 'agent/add-kafka', title: 'Add kafka', url: 'http://pr/1', number: 1 };

describe('GET /agents', () => {
  it('adds a PENDING-MERGE row for an Agent that only exists as an open pull request', async () => {
    const body = await listAgents(runtimeReturning([merged]), gitopsReturning([proposal]));
    expect(body.agents.map(agent => agent.id)).toEqual(['keycloak', 'kafka']);
    expect(body.agents[1]?.reconciliation?.status).toBe('pending-merge');
  });

  it('claims nothing about a proposal it has not read', async () => {
    const body = await listAgents(runtimeReturning([]), gitopsReturning([proposal]));
    // the schema that would validate the branch's YAML lives in the runtime, and
    // a tool count taken from an unmerged diff would be displaying access
    // nobody has approved yet
    expect(body.agents[0]?.toolCount).toBe(0);
  });

  it('lets the runtime win for an Agent that has already merged', async () => {
    // an open branch for an Agent that exists is an UPDATE in flight, not a
    // second copy of the Agent; two rows for one name would be a second inventory
    const update: AgentProposal = { ...proposal, agentId: 'keycloak', kind: 'update', branch: 'agent/update-keycloak' };
    const body = await listAgents(runtimeReturning([merged]), gitopsReturning([update, { ...proposal, kind: 'add', agentId: 'keycloak', branch: 'agent/add-keycloak' }]));
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.reconciliation?.status).toBe('active');
  });

  it('still serves every merged Agent when the Git provider cannot be listed', async () => {
    // losing the whole Agents view because the provider rate-limited would be a
    // far worse outcome than not showing a row for something not yet merged
    const body = await listAgents(runtimeReturning([merged]), gitopsReturning(new Error('rate limited')));
    expect(body.agents.map(agent => agent.id)).toEqual(['keycloak']);
    expect(body.proposalsError).toBeDefined();
    // and never echoes the provider's message, which can disclose internals
    expect(body.proposalsError).not.toContain('rate limited');
  });

  it('passes the runtime\'s own configuration error through untouched', async () => {
    const body = await listAgents(runtimeReturning([merged], { configError: 'schema validation failed for kafka.yaml' }), gitopsReturning([]));
    expect(body).toMatchObject({ configError: 'schema validation failed for kafka.yaml' });
  });
});
