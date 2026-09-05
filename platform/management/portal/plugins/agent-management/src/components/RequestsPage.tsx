import { useMemo, useState } from 'react';
import { useRequest, useRequests } from '../api/client';
import {
  AsyncState,
  Body,
  Breadcrumb,
  C,
  DataRow,
  DataTable,
  DefinitionList,
  EmptyState,
  Mono,
  Muted,
  Page,
  PageHeader,
  Panel,
  ReconciliationPanel,
  S,
  StatCard,
  StatGrid,
  StatusPill,
  Tabs,
  Tone,
  reconciliationTone,
  relativeTime,
  selectStyle,
} from './common';
import { ChangeSetDiff } from './ChangeSetDiff';
import { RunFlow } from './RunFlow';
import { Timeline } from './RunsPage';
import type { ManagementRequestDetail, ManagementRequestSummary } from '../api/types';

/**
 * MANAGEMENT REQUESTS.
 *
 * The same execution-trace views as Runs — Flow, Timeline, a side panel per
 * event — over a different domain: a Run explains how an answer was produced,
 * a Request explains how a platform change was applied. The components are
 * shared, not copied; only the event kinds differ.
 *
 * Everything on this page is a projection of the pull request the provider
 * reports and the reconciliation the runtime reports. The browser computes
 * nothing about the deployment, and there is no stored status to go stale.
 */

type RequestStatus = ManagementRequestSummary['status'];

const STATUS_LABEL: Record<RequestStatus, string> = {
  draft: 'Draft',
  'pending-merge': 'Pending merge',
  merged: 'Merged',
  reconciling: 'Reconciling',
  completed: 'Completed',
  failed: 'Failed',
  rejected: 'Rejected',
};

export function requestStatusTone(status: RequestStatus): Tone {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'rejected' || status === 'draft') return 'neutral';
  return 'warn';
}

const TONE_COLOR: Record<Tone, string> = { ok: C.greenBright, danger: C.redBright, warn: C.amberBright, neutral: C.dim, info: C.accent };

function requestStatusColor(status: RequestStatus): string {
  return TONE_COLOR[requestStatusTone(status)];
}

const TYPE_LABEL: Record<ManagementRequestSummary['type'], string> = { create: 'Create', edit: 'Edit', enable: 'Enable', disable: 'Disable', delete: 'Delete' };

const COLUMNS = '.8fr 1.2fr .7fr 1.2fr 1fr 1fr .8fr';
const ANY = '';

/** One `<select>` per filter; the native control is the whole UI. */
function Filter({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted }}>
      {label}
      <select aria-label={label} value={value} onChange={event => onChange(event.target.value)} style={{ ...selectStyle, padding: '5px 8px', fontSize: 12 }}>
        <option value={ANY}>any</option>
        {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
      </select>
    </label>
  );
}

export function RequestsPage({ pollMs }: { pollMs?: number } = {}) {
  const { value, loading, error, refreshError } = useRequests(pollMs);
  const requests = useMemo(() => value ?? [], [value]);
  const [status, setStatus] = useState(ANY);
  const [type, setType] = useState(ANY);
  const [agent, setAgent] = useState(ANY);
  const [requester, setRequester] = useState(ANY);

  const agents = useMemo(() => [...new Set(requests.map(request => request.agentId))].sort(), [requests]);
  const requesters = useMemo(() => [...new Set(requests.map(request => request.requestedBy))].sort(), [requests]);
  const shown = requests.filter(request =>
    (status === ANY || request.status === status)
    && (type === ANY || request.type === type)
    && (agent === ANY || request.agentId === agent)
    && (requester === ANY || request.requestedBy === requester));

  return (
    <Page>
      <PageHeader title="Requests" subtitle="Management changes proposed from this portal, traced from pull request to routable Agent" />
      <AsyncState loading={loading} error={error}>
        <div style={{ display: 'flex', gap: S.md, flexWrap: 'wrap', marginBottom: S.md, alignItems: 'center' }}>
          <Filter label="Status" value={status} options={(Object.keys(STATUS_LABEL) as RequestStatus[]).map(key => [key, STATUS_LABEL[key]])} onChange={setStatus} />
          <Filter label="Type" value={type} options={(Object.keys(TYPE_LABEL) as Array<keyof typeof TYPE_LABEL>).map(key => [key, TYPE_LABEL[key]])} onChange={setType} />
          <Filter label="Agent" value={agent} options={agents.map(id => [id, id])} onChange={setAgent} />
          <Filter label="Requester" value={requester} options={requesters.map(id => [id, id])} onChange={setRequester} />
          {refreshError && <div style={{ marginLeft: 'auto' }}><StatusPill tone="warn">last refresh failed; showing the previous state</StatusPill></div>}
        </div>
        <Panel padded={false}>
          {shown.length === 0 ? (
            <EmptyState>{requests.length === 0 ? 'No requests have been made from this portal yet. Create or edit an Agent and it will appear here.' : 'No requests match these filters.'}</EmptyState>
          ) : (
            <DataTable columns={COLUMNS} head={['REQUEST', 'AGENT', 'TYPE', 'REQUESTED BY', 'STATUS', 'AGENT STATUS', 'UPDATED']}>
              {shown.map(request => (
                <DataRow key={request.id} columns={COLUMNS} onClick={() => { window.location.href = `/requests/${request.id}`; }}>
                  <Muted mono>{request.id.slice(0, 8)}</Muted>
                  <Body>{request.agentId}</Body>
                  <Muted>{TYPE_LABEL[request.type]}</Muted>
                  <Muted>{request.requestedBy}</Muted>
                  <div><StatusPill tone={requestStatusTone(request.status)}>{STATUS_LABEL[request.status]}</StatusPill></div>
                  <div>{request.agentStatus ? <StatusPill tone={reconciliationTone(request.agentStatus)}>{request.agentStatus}</StatusPill> : <Muted size={12}>—</Muted>}</div>
                  <Muted mono>{relativeTime(request.updatedAt)}</Muted>
                </DataRow>
              ))}
            </DataTable>
          )}
        </Panel>
      </AsyncState>
    </Page>
  );
}

const TABS = ['Flow', 'Timeline', 'Changes', 'Details'] as const;

export function RequestDetailPage({ requestId }: { requestId: string }) {
  const { value, loading, error } = useRequest(requestId);
  const [tab, setTab] = useState<string>(TABS[0]);

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Requests', onClick: () => { window.location.href = '/requests'; } }, { label: requestId.slice(0, 8) }]} />
      <AsyncState loading={loading} error={error}>
        {value && (
          <>
            <PageHeader title={`${TYPE_LABEL[value.type]} ${value.agentId}`} subtitle={value.blockedBy} />

            <StatGrid columns={5}>
              <StatCard label="Status" value={STATUS_LABEL[value.status]} dot={requestStatusColor(value.status)} sub={value.blockedBy ? 'waiting' : undefined} />
              <StatCard label="Agent status" value={value.agentStatus ?? '—'} sub={value.agentStatus ? 'from the runtime' : 'not yet visible to the runtime'} />
              <StatCard label="Requested" value={relativeTime(value.createdAt)} sub={value.requestedBy} />
              <StatCard label="Updated" value={relativeTime(value.updatedAt)} sub={new Date(value.updatedAt).toLocaleString()} />
              <StatCard label="Pull request" value={value.pullRequest ? `#${value.pullRequest.number}` : '—'} sub={value.pullRequest?.url ? <a href={value.pullRequest.url} style={{ color: C.accent }}>open in provider</a> : value.branch || 'not opened'} />
            </StatGrid>

            <div style={{ marginTop: S.lg }}>
              <Tabs tabs={TABS} active={tab} onChange={setTab} />
            </div>

            <div style={{ marginTop: S.lg }}>
              {tab === 'Flow' && (
                <Panel title="Request flow">
                  <RunFlow nodes={value.nodes} footer="A request records what was proposed and what each system reported, never a credential or a raw provider payload." />
                </Panel>
              )}
              {tab === 'Timeline' && <Panel title="Timeline" padded={false}><Timeline nodes={value.nodes} /></Panel>}
              {tab === 'Changes' && <Changes request={value} />}
              {tab === 'Details' && <Details request={value} />}
            </div>
          </>
        )}
      </AsyncState>
    </Page>
  );
}

function Changes({ request }: { request: ManagementRequestDetail }) {
  return (
    <Panel title={request.status === 'completed' ? 'Applied configuration change' : 'Proposed configuration change'}>
      {request.diff ? <ChangeSetDiff diff={request.diff} /> : <EmptyState>The change-set was not rendered, so there is no diff to show.</EmptyState>}
    </Panel>
  );
}

function Details({ request }: { request: ManagementRequestDetail }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: S.lg }}>
      <Panel title="Request">
        <DefinitionList
          items={[
            ['Request id', <Mono key="id">{request.id}</Mono>],
            ['Type', TYPE_LABEL[request.type]],
            ['Agent', request.agentId],
            ['Requested by', request.requestedBy],
            ['Branch', request.branch ? <Mono key="b">{request.branch}</Mono> : <Muted key="b">not prepared</Muted>],
            ['Effects', request.effects.length ? request.effects.join('; ') : <Muted key="e">none recorded</Muted>],
          ]}
        />
      </Panel>
      <Panel title="Resulting Agent state">
        <ReconciliationPanel reconciliation={request.reconciliation} />
      </Panel>
    </div>
  );
}
