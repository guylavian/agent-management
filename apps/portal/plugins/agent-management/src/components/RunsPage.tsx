import { useRun, useRuns } from '../api/client';
import {
  AsyncState,
  Body,
  Breadcrumb,
  C,
  Chip,
  DataRow,
  DataTable,
  DefinitionList,
  EmptyState,
  Mono,
  Muted,
  Page,
  PageHeader,
  Panel,
  StatCard,
  StatGrid,
  StatusPill,
} from './common';
import type { RunNode } from '../api/types';

const COLUMNS = '1.3fr 1fr 1.4fr .7fr .5fr .6fr .6fr';

/** Runs list (TDD §46). */
export function RunsPage() {
  const { value, loading, error } = useRuns();
  const runs = value ?? [];
  return (
    <Page>
      <PageHeader title="Runs" subtitle="Investigations recorded by the runtime process serving this portal" />
      <AsyncState loading={loading} error={error}>
        <Panel padded={false}>
          {runs.length === 0 ? (
            <EmptyState>No runs have been recorded yet. Ask the assistant a question and it will appear here.</EmptyState>
          ) : (
            <DataTable columns={COLUMNS} head={['TIME', 'USER', 'AGENTS', 'STATUS', 'TOOLS', 'EVIDENCE', 'DURATION']}>
              {runs.map(run => (
                <DataRow key={run.requestId} columns={COLUMNS} onClick={() => { window.location.href = `/runs/${run.requestId}`; }}>
                  <Body>{new Date(run.startedAt).toLocaleString()}</Body>
                  {/* the human initiator is carried as a hash; the portal never sees the raw subject */}
                  <Muted mono>{run.userSubjectHash.slice(0, 10)}…</Muted>
                  <Body>{run.agents.join(', ')}</Body>
                  <div><StatusPill tone={run.status === 'complete' ? 'ok' : run.status === 'partial' ? 'warn' : 'danger'}>{run.status}</StatusPill></div>
                  <Body>{run.toolCalls}</Body>
                  <Body>{run.evidenceCount}</Body>
                  <Muted>{run.durationMs} ms</Muted>
                </DataRow>
              ))}
            </DataTable>
          )}
        </Panel>
      </AsyncState>
    </Page>
  );
}

/** Execution graph for a single run (TDD §45). */
export function RunDetailPage({ runId }: { runId: string }) {
  const { value, loading, error } = useRun(runId);
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Runs', onClick: () => { window.location.href = '/runs'; } }, { label: runId.slice(0, 8) }]} />
      <PageHeader title="Run" subtitle={runId} />
      <AsyncState loading={loading} error={error}>
        {value && (
          <>
            <StatGrid columns={5}>
              <StatCard label="Status" value={value.status} dot={value.status === 'complete' ? C.greenBright : value.status === 'partial' ? C.amberBright : C.redBright} />
              <StatCard label="Duration" value={`${value.durationMs} ms`} />
              <StatCard label="Tool calls" value={value.toolCalls} sub="through ToolHive" />
              <StatCard label="Denied calls" value={value.deniedToolCalls} sub={value.deniedToolCalls ? 'blocked by policy' : 'none'} dot={value.deniedToolCalls ? C.redBright : undefined} />
              <StatCard label="Evidence" value={value.evidenceCount} />
            </StatGrid>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Panel title="Identity chain">
                {/* human initiator and agent workloads are shown separately — TDD §13 */}
                <DefinitionList
                  items={[
                    ['Initiated by (human)', <Mono key="h">{value.userSubjectHash.slice(0, 32)}…</Mono>],
                    ['Executed by (workloads)', <div key="w" style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{value.workloads.map(workload => <Chip key={workload} mono>{workload}</Chip>)}</div>],
                    ['Environment', value.environment],
                    ['Model profiles', value.modelProfiles.join(', ') || '—'],
                  ]}
                />
              </Panel>

              <Panel title="Execution graph">
                <ExecutionGraph nodes={value.nodes} />
                <div style={{ marginTop: 14 }}>
                  <Muted size={12}>Model reasoning and tool payloads are deliberately not recorded.</Muted>
                </div>
              </Panel>
            </div>
          </>
        )}
      </AsyncState>
    </Page>
  );
}

const KIND_COLOR: Record<string, string> = {
  'manager.route': C.accent,
  specialist: '#2f7fd1',
  'workload.token': '#7c5cd6',
  'authorization.check': C.faint,
  'toolhive.call': C.amberBright,
  evidence: C.greenBright,
  'domain.escalation': C.redBright,
  synthesis: C.text,
};

/**
 * Rendered as a tree rather than a flat timeline, so fan-out to several
 * specialists and the fan-in at synthesis stay visible.
 */
function ExecutionGraph({ nodes }: { nodes: RunNode[] }) {
  const children = new Map<string, RunNode[]>();
  const roots: RunNode[] = [];
  for (const node of nodes) {
    if (node.parentId === undefined) roots.push(node);
    else children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }

  const render = (node: RunNode, depth: number) => (
    <div key={node.id} style={{ marginLeft: depth ? 20 : 0, borderLeft: depth ? `2px solid ${C.rule}` : 'none', paddingLeft: depth ? 14 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, background: KIND_COLOR[node.kind] ?? C.dim, flex: 'none' }} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px', color: C.faint, minWidth: 132, textTransform: 'uppercase' }}>{node.kind}</span>
        <span style={{ fontSize: 13, color: C.text }}>{node.label}</span>
        {node.status !== 'ok' && <StatusPill tone={node.status === 'denied' ? 'danger' : 'warn'}>{node.status}</StatusPill>}
        {node.round === 2 && <StatusPill tone="warn" dot={false}>round 2</StatusPill>}
      </div>
      {(children.get(node.id) ?? []).map(child => render(child, depth + 1))}
    </div>
  );

  return <div>{roots.map(node => render(node, 0))}</div>;
}
