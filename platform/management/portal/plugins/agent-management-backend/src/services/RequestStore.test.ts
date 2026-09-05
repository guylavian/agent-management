// backstage-cli package test runs jest; describe/it/expect are global.
import { InMemoryRequestStore, projectRequest, summarise, type RequestRecord, type RuntimeSnapshot } from './RequestStore';
import type { AgentReconciliation, AgentSummary } from '../api/generated-types';

/**
 * A REQUEST IS A PROJECTION, AND THE PROJECTION IS PURE.
 *
 * Every state below is derived from three observed inputs — what this plane
 * did, what the provider says about the pull request, what the runtime says
 * about the Agent — and never from a stored status. These tests hand the
 * projection literal inputs and check that the request answers the four
 * questions the page exists for: what was asked, where it is, what blocks it,
 * and what Agent state resulted.
 */
const base: RequestRecord = {
  id: 'req-1',
  agentId: 'kafka',
  type: 'create',
  requestedBy: 'user:default/guy',
  createdAt: '2026-08-30T10:00:00.000Z',
  branch: 'agent/add-kafka',
  effects: ['adds config/agents/kafka.yaml'],
  diff: { changed: 1, additions: 3, deletions: 0, files: [] },
};
const opened: RequestRecord = { ...base, preparedAt: '2026-08-30T10:00:01.000Z', publishedAt: '2026-08-30T10:00:02.000Z', pullRequest: { number: 7, url: 'http://git/pr/7' } };

function signals(over: Partial<AgentReconciliation> = {}): AgentReconciliation {
  return {
    status: 'active',
    git: { state: 'ok', detail: 'merged and enabled in production' },
    argo: { state: 'ok', detail: 'Synced/Healthy' },
    runtime: { state: 'ok', detail: 'answering' },
    manager: { state: 'ok', detail: "in the Manager's effective catalog for production" },
    ...over,
  };
}

function runtimeWith(reconciliation: AgentReconciliation | undefined, loadedAt = '2026-08-30T10:10:00.000Z'): RuntimeSnapshot {
  const agent = { id: 'kafka', lifecycle: 'active', enabled: true, ...(reconciliation ? { reconciliation } : {}) } as AgentSummary;
  return { loadedAt, agents: reconciliation === undefined && loadedAt === '' ? [] : [agent] };
}

const merged = { state: 'merged' as const, mergedAt: '2026-08-30T10:05:00.000Z' };

const kinds = (nodes: Array<{ kind: string }>) => nodes.map(node => node.kind);
const statusOf = (nodes: Array<{ kind: string; status: string }>, kind: string) => nodes.find(node => node.kind === kind)?.status;

describe('projectRequest', () => {
  it('a request exists the moment it is made, before anything has happened', async () => {
    const detail = projectRequest({ record: base });
    expect(detail.status).toBe('draft');
    expect(kinds(detail.nodes)).toEqual(['request.created', 'change.prepared', 'pr.opened']);
    expect(statusOf(detail.nodes, 'change.prepared')).toBe('pending');
    expect(detail.nodes[0]).toMatchObject({ actor: 'user', agentId: 'kafka', metadata: { type: 'create', requestedBy: 'user:default/guy' } });
  });

  it('PR opened → pending merge, with the pull request as the blocking step', async () => {
    const detail = projectRequest({ record: opened, pullRequest: { state: 'open' } });
    expect(detail.status).toBe('pending-merge');
    expect(detail.agentStatus).toBeUndefined();
    expect(statusOf(detail.nodes, 'pr.merged')).toBe('pending');
    expect(detail.blockedBy).toMatch(/reviewed and merged/u);
    expect(detail.pullRequest).toEqual({ number: 7, url: 'http://git/pr/7' });
  });

  it('merge → merged until the runtime has loaded desired state newer than the merge', async () => {
    const stale = projectRequest({ record: opened, pullRequest: merged, runtime: runtimeWith(signals(), '2026-08-30T10:04:00.000Z') });
    expect(stale.status).toBe('merged');
    expect(statusOf(stale.nodes, 'pr.merged')).toBe('ok');
    expect(statusOf(stale.nodes, 'reconciliation.started')).toBe('pending');
    expect(stale.blockedBy).toMatch(/before the merge/u);
    // and the Agent's own status is NOT reported from a snapshot older than the merge
    expect(stale.agentStatus).toBeUndefined();
  });

  it('compares merge and reload as times, not strings (GitHub omits milliseconds)', async () => {
    const detail = projectRequest({ record: opened, pullRequest: { state: 'merged', mergedAt: '2026-08-30T10:05:00Z' }, runtime: runtimeWith(signals(), '2026-08-30T10:05:00.500Z') });
    expect(detail.status).toBe('completed');
  });

  it('merge → reconciling while Argo is still syncing', async () => {
    const reconciliation = signals({ status: 'reconciling', argo: { state: 'pending', detail: 'OutOfSync/Progressing' }, runtime: { state: 'pending', detail: 'pod starting' }, manager: { state: 'pending', detail: 'not routable yet' } });
    const detail = projectRequest({ record: opened, pullRequest: merged, runtime: runtimeWith(reconciliation) });
    expect(detail.status).toBe('reconciling');
    expect(detail.agentStatus).toBe('reconciling');
    expect(kinds(detail.nodes)).toEqual(['request.created', 'change.prepared', 'pr.opened', 'pr.merged', 'reconciliation.started', 'argo.sync', 'runtime.ready', 'agent.routable']);
    expect(statusOf(detail.nodes, 'argo.sync')).toBe('pending');
    expect(detail.blockedBy).toBe('OutOfSync/Progressing');
  });

  it('runtime ready + routable → completed, and the Agent is active', async () => {
    const detail = projectRequest({ record: opened, pullRequest: merged, runtime: runtimeWith(signals()) });
    expect(detail.status).toBe('completed');
    expect(detail.agentStatus).toBe('active');
    expect(detail.blockedBy).toBeUndefined();
    expect(detail.nodes.at(-1)).toMatchObject({ kind: 'request.completed', status: 'ok', label: 'Active' });
    // the chain is linear: every node's parent is the one before it
    detail.nodes.forEach((node, index) => expect(node.parentId).toBe(index === 0 ? undefined : detail.nodes[index - 1].id));
    // and the last update is the runtime's own observation time, not the browser's
    expect(detail.updatedAt).toBe('2026-08-30T10:10:00.000Z');
  });

  it('failed reconciliation → failed AT the failed step, and the request stays visible', async () => {
    const reconciliation = signals({ status: 'degraded', argo: { state: 'degraded', detail: 'Degraded: ImagePullBackOff' }, runtime: { state: 'pending', detail: 'not answering' }, manager: { state: 'pending', detail: 'not routable' } });
    const detail = projectRequest({ record: opened, pullRequest: merged, runtime: runtimeWith(reconciliation) });
    expect(detail.status).toBe('failed');
    expect(detail.agentStatus).toBe('degraded');
    expect(statusOf(detail.nodes, 'argo.sync')).toBe('failed');
    expect(detail.nodes.at(-1)).toMatchObject({ kind: 'request.failed', detail: 'Degraded: ImagePullBackOff' });
    expect(detail.blockedBy).toBe('Degraded: ImagePullBackOff');
  });

  it('desired state that does not load is failed at reconciliation, not hidden', async () => {
    const detail = projectRequest({ record: opened, pullRequest: merged, runtime: { ...runtimeWith(signals()), configError: 'kafka.yaml: spec.access must not be empty' } });
    expect(detail.status).toBe('failed');
    expect(statusOf(detail.nodes, 'reconciliation.started')).toBe('failed');
    expect(detail.blockedBy).toMatch(/spec.access must not be empty/u);
  });

  it('rejected PR → request rejected, Agent untouched', async () => {
    const detail = projectRequest({ record: opened, pullRequest: { state: 'declined', closedAt: '2026-08-30T11:00:00.000Z' }, runtime: runtimeWith(undefined, '') });
    expect(detail.status).toBe('rejected');
    expect(detail.agentStatus).toBeUndefined();
    expect(detail.reconciliation).toBeUndefined();
    expect(detail.nodes.at(-1)).toMatchObject({ kind: 'pr.rejected', status: 'denied', actor: 'git' });
    expect(detail.updatedAt).toBe('2026-08-30T11:00:00.000Z');
  });

  it('a change the runtime refuses fails at "change prepared" with the runtime reason', async () => {
    const detail = projectRequest({ record: { ...base, preparedAt: '2026-08-30T10:00:01.000Z', prepareError: 'spec.access: Too small' } });
    expect(detail.status).toBe('failed');
    expect(statusOf(detail.nodes, 'change.prepared')).toBe('failed');
    expect(kinds(detail.nodes)).toEqual(['request.created', 'change.prepared', 'request.failed']);
  });

  it('a publish failure fails at "PR opened"', async () => {
    const detail = projectRequest({ record: { ...base, preparedAt: '2026-08-30T10:00:01.000Z', publishedAt: '2026-08-30T10:00:02.000Z', publishError: 'bitbucket create branch failed (403)' } });
    expect(detail.status).toBe('failed');
    expect(statusOf(detail.nodes, 'pr.opened')).toBe('failed');
  });

  it('an edit request is tracked and completes when the reloaded runtime shows the Agent settled', async () => {
    const detail = projectRequest({ record: { ...opened, type: 'edit', branch: 'agent/update-kafka' }, pullRequest: merged, runtime: runtimeWith(signals()) });
    expect(detail).toMatchObject({ type: 'edit', status: 'completed', agentStatus: 'active' });
    expect(detail.nodes[0].label).toBe('Edit kafka');
  });

  it('an enable request completes only when the Agent is active', async () => {
    const notYet = projectRequest({ record: { ...opened, type: 'enable' }, pullRequest: merged, runtime: runtimeWith(signals({ status: 'reconciling', manager: { state: 'pending', detail: 'not routable yet' } })) });
    expect(notYet.status).toBe('reconciling');
    const done = projectRequest({ record: { ...opened, type: 'enable' }, pullRequest: merged, runtime: runtimeWith(signals()) });
    expect(done).toMatchObject({ status: 'completed', agentStatus: 'active' });
  });

  it('a disable request completes when the Agent is disabled, and routability is inverted', async () => {
    const pruning = signals({ status: 'reconciling', git: { state: 'pending', detail: 'disabled' }, argo: { state: 'pending', detail: 'pruning' }, manager: { state: 'pending', detail: 'not routable: disabled' } });
    const inFlight = projectRequest({ record: { ...opened, type: 'disable' }, pullRequest: merged, runtime: runtimeWith(pruning) });
    expect(inFlight.status).toBe('reconciling');
    const gone = signals({ status: 'disabled', git: { state: 'pending', detail: 'disabled' }, argo: { state: 'unknown', detail: 'no Application' }, runtime: { state: 'unknown', detail: 'nothing to probe' }, manager: { state: 'pending', detail: 'not routable: disabled' } });
    const done = projectRequest({ record: { ...opened, type: 'disable' }, pullRequest: merged, runtime: runtimeWith(gone) });
    expect(done).toMatchObject({ status: 'completed', agentStatus: 'disabled' });
    expect(done.nodes.find(node => node.kind === 'agent.routable')).toMatchObject({ status: 'ok', label: 'Removed from Manager routing' });
  });

  it('request state never contradicts Agent state', async () => {
    const cases: Array<[AgentReconciliation['status'], string]> = [
      ['active', 'completed'], ['reconciling', 'reconciling'], ['degraded', 'failed'], ['failed', 'failed'], ['draft', 'completed'], ['disabled', 'completed'],
    ];
    for (const [agentStatus, expected] of cases) {
      const detail = projectRequest({ record: opened, pullRequest: merged, runtime: runtimeWith(signals({ status: agentStatus })) });
      expect(detail.agentStatus).toBe(agentStatus);
      expect(detail.status).toBe(expected);
    }
  });

  it('an unobservable signal is reported as such, never as green', async () => {
    const detail = projectRequest({ record: opened, pullRequest: merged, runtime: runtimeWith(signals({ argo: { state: 'unknown', detail: 'no Argo CD endpoint is configured' } })) });
    expect(detail.nodes.find(node => node.kind === 'argo.sync')).toMatchObject({ status: 'pending', detail: 'no Argo CD endpoint is configured' });
    // foldStatus lets an unknown signal through on the Manager's positive evidence, and so does the request
    expect(detail.status).toBe('completed');
  });

  it('a provider or runtime that cannot be read leaves the request where it was, with the reason', async () => {
    const provider = projectRequest({ record: opened, pullRequest: { error: 'rate limited' } });
    expect(provider.status).toBe('pending-merge');
    expect(provider.blockedBy).toMatch(/rate limited/u);
    const runtime = projectRequest({ record: opened, pullRequest: merged, runtime: { error: 'ECONNREFUSED' } });
    expect(runtime.status).toBe('merged');
    expect(runtime.blockedBy).toMatch(/ECONNREFUSED/u);
  });

  it('is provider-neutral: GitHub and Bitbucket answers produce the same representation', async () => {
    const fromGitHub = projectRequest({ record: opened, pullRequest: { state: 'merged', mergedAt: merged.mergedAt }, runtime: runtimeWith(signals()) });
    const fromBitbucket = projectRequest({ record: { ...opened, pullRequest: { number: 7, url: 'https://bitbucket.corp/projects/SRE/repos/agents/pull-requests/7' } }, pullRequest: { state: 'merged', mergedAt: merged.mergedAt }, runtime: runtimeWith(signals()) });
    expect(kinds(fromGitHub.nodes)).toEqual(kinds(fromBitbucket.nodes));
    expect(fromGitHub.status).toBe(fromBitbucket.status);
  });

  it('carries only scalars in event metadata — no payloads, no credentials', async () => {
    const detail = projectRequest({ record: opened, pullRequest: merged, runtime: runtimeWith(signals()) });
    for (const node of detail.nodes) {
      for (const value of Object.values(node.metadata ?? {})) expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/token|secret|authorization/iu);
  });

  it('the summary drops the diff, the events and the reconciliation block', async () => {
    const summary = summarise(projectRequest({ record: opened, pullRequest: merged, runtime: runtimeWith(signals()) }));
    expect(summary).not.toHaveProperty('nodes');
    expect(summary).not.toHaveProperty('diff');
    expect(summary).toMatchObject({ id: 'req-1', agentId: 'kafka', type: 'create', status: 'completed', agentStatus: 'active' });
  });
});

describe('InMemoryRequestStore', () => {
  it('is bounded and newest-first', async () => {
    const store = new InMemoryRequestStore(2);
    await store.record({ ...base, id: 'a' });
    await store.record({ ...base, id: 'b' });
    await store.record({ ...base, id: 'c' });
    expect((await store.list()).map(request => request.id)).toEqual(['c', 'b']);
    expect(await store.get('a')).toBeUndefined();
  });

  it('updates in place', async () => {
    const store = new InMemoryRequestStore();
    await store.record(base);
    await store.update('req-1', { pullRequest: { number: 3 } });
    expect((await store.get('req-1'))?.pullRequest).toEqual({ number: 3 });
  });
});

describe('delete requests', () => {
  const removal: RequestRecord = { ...opened, type: 'delete', branch: 'agent/remove-kafka' };

  it('is reconciling while the reloaded runtime still lists the Agent, and completes once it is gone', async () => {
    const pruning = signals({ status: 'reconciling', git: { state: 'degraded', detail: 'x' }, argo: { state: 'pending', detail: 'pruning' } });
    const inFlight = projectRequest({ record: removal, pullRequest: merged, runtime: runtimeWith(pruning) });
    expect(inFlight.status).toBe('reconciling');
    expect(inFlight.nodes.find(node => node.kind === 'argo.sync')).toMatchObject({ label: 'Argo prune', status: 'pending' });

    const gone = projectRequest({ record: removal, pullRequest: merged, runtime: { loadedAt: '2026-08-30T10:10:00.000Z', agents: [] } });
    expect(gone.status).toBe('completed');
    expect(gone.agentStatus).toBeUndefined();
    expect(gone.nodes.at(-1)).toMatchObject({ kind: 'request.completed', label: 'Agent removed' });
  });

  it('stays merged until the runtime has reloaded after the merge', async () => {
    const detail = projectRequest({ record: removal, pullRequest: merged, runtime: { loadedAt: '2026-08-30T10:04:00.000Z', agents: [] } });
    expect(detail.status).toBe('merged');
  });

  it('fails at Argo when the prune degrades', async () => {
    const broken = signals({ status: 'degraded', argo: { state: 'degraded', detail: 'prune failed: finalizer stuck' } });
    const detail = projectRequest({ record: removal, pullRequest: merged, runtime: runtimeWith(broken) });
    expect(detail.status).toBe('failed');
    expect(detail.blockedBy).toBe('prune failed: finalizer stuck');
  });
});
