import { render, screen, waitFor, within } from '@testing-library/react';
import { TestApiProvider } from '@backstage/frontend-test-utils';
import { fetchApiRef } from '@backstage/frontend-plugin-api';
import { RequestsPage } from './RequestsPage';
import { Timeline } from './RunsPage';
import type { ManagementRequestSummary, RunNode } from '../api/types';

/**
 * REQUESTS AND RUNS ARE ONE EXECUTION MODEL.
 *
 * The Requests page must see a merge land without a reload — the whole reason
 * it exists — and it must render its events through the same components Runs
 * use, so a request's Timeline is a run's Timeline over different event kinds.
 */
const summary = (status: ManagementRequestSummary['status'], agentStatus?: ManagementRequestSummary['agentStatus']): ManagementRequestSummary => ({
  id: 'req-1', agentId: 'kafka', type: 'create', requestedBy: 'user:default/guy', status, ...(agentStatus ? { agentStatus } : {}),
  createdAt: '2026-08-30T10:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z', branch: 'agent/add-kafka', pullRequest: { number: 7 },
});

/** the filter selects carry the same labels, so assert on the table row, not the page */
const row = () => within(screen.getByText('req-1'.slice(0, 8)).parentElement as HTMLElement);

function fetchApi(current: () => ManagementRequestSummary[]) {
  return { fetch: async () => ({ ok: true, status: 200, json: async () => ({ requests: current() }) }) } as never;
}

describe('RequestsPage', () => {

  it('shows the transition pending merge → reconciling → completed without a reload', async () => {
    let rows = [summary('pending-merge')];
    render(<TestApiProvider apis={[[fetchApiRef, fetchApi(() => rows)]]}><RequestsPage pollMs={20} /></TestApiProvider>);
    await waitFor(() => expect(row().getByText('Pending merge')).toBeInTheDocument());

    // the reviewer merges and the deployment lands; nothing on this page is touched
    rows = [summary('reconciling', 'reconciling')];
    await waitFor(() => expect(row().getByText('Reconciling')).toBeInTheDocument());

    rows = [summary('completed', 'active')];
    await waitFor(() => expect(row().getByText('Completed')).toBeInTheDocument());
    expect(row().getByText('active')).toBeInTheDocument();
  });

  it('a request that failed after merge stays listed as Failed', async () => {
    render(<TestApiProvider apis={[[fetchApiRef, fetchApi(() => [summary('failed', 'degraded')])]]}><RequestsPage /></TestApiProvider>);
    await waitFor(() => expect(row().getByText('Failed')).toBeInTheDocument());
    expect(row().getByText('degraded')).toBeInTheDocument();
  });
});

describe('shared Timeline over request events', () => {
  it('renders management event kinds with the same component Runs use', () => {
    const nodes: RunNode[] = [
      { id: '1', kind: 'request.created', label: 'Create kafka', status: 'ok', startedAt: '2026-08-30T10:00:00.000Z', durationMs: 0, actor: 'user' },
      { id: '2', kind: 'pr.merged', parentId: '1', label: 'PR merged', status: 'pending', startedAt: '2026-08-30T10:00:01.000Z', durationMs: 0, actor: 'git', detail: 'waiting for review' },
      { id: '3', kind: 'user.request', parentId: '1', label: 'a run event still works', status: 'ok', startedAt: '2026-08-30T10:00:02.000Z', durationMs: 0, actor: 'user' },
    ];
    render(<Timeline nodes={nodes} />);
    expect(screen.getByText('PR merged')).toBeInTheDocument();
    expect(screen.getByText('waiting for review')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('a run event still works')).toBeInTheDocument();
  });
});
