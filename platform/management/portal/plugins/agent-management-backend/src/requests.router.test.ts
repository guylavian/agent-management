// backstage-cli package test runs jest; describe/it/expect are global.
import express from 'express';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { createRouter } from './router';
import type { GitOpsPublisher, PullRequestState } from './services/GitOpsPublisher';
import { InMemoryRequestStore } from './services/RequestStore';
import type { RuntimeManagementClient } from './services/RuntimeManagementClient';

/**
 * THE REQUEST IS RECORDED ON THE WRITE PATH AND PROJECTED ON EVERY READ.
 *
 * `/agents/change` is the one place a management change starts, so it is the
 * one place a Request is recorded — before the runtime is asked to render
 * anything, so a refused draft still leaves a trace. `/requests` then joins
 * that record to the provider's pull request state and the runtime's
 * reconciliation on each call, which is what lets a polling page watch a merge
 * turn into an active Agent without anything being pushed.
 */
const ALLOW = { authorize: async () => [{ result: AuthorizeResult.ALLOW }] } as never;
const HTTP_AUTH = { credentials: async () => ({ principal: { type: 'user', userEntityRef: 'user:default/guy' } }) } as never;

const preview = { path: 'config/agents/kafka.yaml', yaml: '', branch: 'agent/add-kafka', title: 'Add kafka', body: '', effects: ['adds kafka'], files: [], diff: { changed: 1, additions: 1, deletions: 0, files: [] } };

function runtimeDouble(state: { agents: unknown[]; loadedAt: string; existing?: Record<string, unknown>; previewStatus?: number }): RuntimeManagementClient {
  return {
    configured: true,
    get: async (path: string) => {
      if (path === '/management/agents') return { agents: state.agents, revision: 'r', loadedAt: state.loadedAt } as never;
      if (state.existing && path.startsWith('/management/agents/')) return state.existing as never;
      throw new Error('404');
    },
    getBinary: async () => undefined,
    post: async () => ({ status: state.previewStatus ?? 200, body: (state.previewStatus ? { code: 'AGENT_DRAFT_INVALID', message: 'draft failed validation', issues: ['spec.access: Too small'] } : preview) as never }),
  };
}

function gitopsDouble(pull: () => PullRequestState): GitOpsPublisher {
  return {
    configured: true,
    createPullRequest: async () => ({ status: 'created', number: 7, url: 'http://git/pr/7' }),
    pullRequestState: async () => pull(),
    listProposals: async () => [],
  };
}

async function serve(runtime: RuntimeManagementClient, gitops: GitOpsPublisher) {
  const app = express();
  app.use(await createRouter({ httpAuth: HTTP_AUTH, permissions: ALLOW, runtime, gitops, requests: new InMemoryRequestStore(), now: () => '2026-08-30T10:00:00.000Z' }));
  const server: Server = await new Promise(resolve => { const listening = app.listen(0, () => resolve(listening)); });
  const { port } = server.address() as AddressInfo;
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, body: (await response.json()) as any };
  };
  return { call, close: () => new Promise(resolve => server.close(resolve)) };
}

const change = (draft: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
const active = { id: 'kafka', lifecycle: 'active', enabled: true, reconciliation: { status: 'active', git: { state: 'ok', detail: 'merged' }, argo: { state: 'ok', detail: 'Synced' }, runtime: { state: 'ok', detail: 'up' }, manager: { state: 'ok', detail: 'routable' } } };

describe('management requests over the router', () => {
  it('a create request appears immediately as pending merge, then follows the merge to active without a restart', async () => {
    let pull: PullRequestState = { state: 'open' };
    const runtimeState = { agents: [] as unknown[], loadedAt: '2026-08-30T09:00:00.000Z' };
    const { call, close } = await serve(runtimeDouble(runtimeState), gitopsDouble(() => pull));
    try {
      const created = await call('/agents/change', change({ name: 'kafka', lifecycle: 'active' }));
      expect(created.status).toBe(201);
      const id = created.body.requestId as string;
      expect(id).toBeTruthy();

      let list = await call('/requests');
      expect(list.body.requests).toHaveLength(1);
      expect(list.body.requests[0]).toMatchObject({ id, agentId: 'kafka', type: 'create', requestedBy: 'user:default/guy', status: 'pending-merge', pullRequest: { number: 7 } });

      // the reviewer merges; nothing tells this backend, the next poll sees it
      pull = { state: 'merged', mergedAt: '2026-08-30T10:05:00.000Z' };
      list = await call('/requests');
      expect(list.body.requests[0].status).toBe('merged');

      // Argo syncs and the runtime reloads with the Agent active
      runtimeState.agents = [active];
      runtimeState.loadedAt = '2026-08-30T10:06:00.000Z';
      const detail = await call(`/requests/${id}`);
      expect(detail.body).toMatchObject({ status: 'completed', agentStatus: 'active' });
      expect(detail.body.nodes.map((node: { kind: string }) => node.kind)).toContain('request.completed');
      expect(detail.body.diff).toBeDefined();
    } finally { await close(); }
  });

  it('a refused draft still records a failed request', async () => {
    const { call, close } = await serve(runtimeDouble({ agents: [], loadedAt: '', previewStatus: 400 }), gitopsDouble(() => ({ state: 'open' })));
    try {
      const refused = await call('/agents/change', change({ name: 'kafka' }));
      expect(refused.status).toBe(400);
      const detail = await call(`/requests/${refused.body.requestId}`);
      expect(detail.body.status).toBe('failed');
      expect(detail.body.blockedBy).toMatch(/spec.access/u);
      // the runtime's message travels; its issues do, nothing else
      expect(JSON.stringify(detail.body)).not.toMatch(/token/iu);
    } finally { await close(); }
  });

  it('derives enable / disable / edit from the Agent the runtime already has', async () => {
    const cases: Array<[Record<string, unknown>, object, string]> = [
      [{ lifecycle: 'draft' }, { name: 'kafka', lifecycle: 'active' }, 'enable'],
      [{ lifecycle: 'active' }, { name: 'kafka', lifecycle: 'draft' }, 'disable'],
      [{ lifecycle: 'active' }, { name: 'kafka', lifecycle: 'active' }, 'edit'],
    ];
    for (const [existing, draft, expected] of cases) {
      const { call, close } = await serve(runtimeDouble({ agents: [], loadedAt: '', existing }), gitopsDouble(() => ({ state: 'open' })));
      try {
        const created = await call('/agents/change', change(draft));
        const detail = await call(`/requests/${created.body.requestId}`);
        expect(detail.body.type).toBe(expected);
      } finally { await close(); }
    }
  });

  it('a declined pull request closes the request and leaves the Agent alone', async () => {
    const { call, close } = await serve(runtimeDouble({ agents: [], loadedAt: '' }), gitopsDouble(() => ({ state: 'declined' })));
    try {
      const created = await call('/agents/change', change({ name: 'kafka', lifecycle: 'active' }));
      const detail = await call(`/requests/${created.body.requestId}`);
      expect(detail.body.status).toBe('rejected');
      expect(detail.body.agentStatus).toBeUndefined();
    } finally { await close(); }
  });

  it('a provider outage does not blank the list', async () => {
    const { call, close } = await serve(runtimeDouble({ agents: [], loadedAt: '' }), gitopsDouble(() => { throw new Error('rate limited'); }));
    try {
      const created = await call('/agents/change', change({ name: 'kafka', lifecycle: 'active' }));
      const list = await call('/requests');
      expect(list.status).toBe(200);
      expect(list.body.requests[0]).toMatchObject({ id: created.body.requestId, status: 'pending-merge' });
    } finally { await close(); }
  });

  it('DELETE proposes a removal pull request and tracks it as a delete request', async () => {
    const { call, close } = await serve(runtimeDouble({ agents: [], loadedAt: '' }), gitopsDouble(() => ({ state: 'open' })));
    try {
      const created = await call('/agents/kafka/delete', change({}));
      expect(created.status).toBe(201);
      const detail = await call(`/requests/${created.body.requestId}`);
      expect(detail.body).toMatchObject({ type: 'delete', agentId: 'kafka', status: 'pending-merge' });
    } finally { await close(); }
  });

  it('a removal the runtime refuses is recorded as failed with the reason', async () => {
    const { call, close } = await serve(runtimeDouble({ agents: [], loadedAt: '', previewStatus: 404 }), gitopsDouble(() => ({ state: 'open' })));
    try {
      const refused = await call('/agents/kafka/delete', change({}));
      expect(refused.status).toBe(404);
      const detail = await call(`/requests/${refused.body.requestId}`);
      expect(detail.body.status).toBe('failed');
    } finally { await close(); }
  });

  it('404s for an unknown request', async () => {
    const { call, close } = await serve(runtimeDouble({ agents: [], loadedAt: '' }), gitopsDouble(() => ({ state: 'open' })));
    try { expect((await call('/requests/nope')).status).toBe(404); } finally { await close(); }
  });
});
