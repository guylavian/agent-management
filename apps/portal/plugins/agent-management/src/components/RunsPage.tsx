import { useRun, useRuns } from '../api/client';
import { AsyncState, Card, Cell, Grid, KeyValue, Mono, PageShell, Pill, Row, StatTile, Table, palette } from './common';
import type { RunNode } from '../api/types';

/** Runs list (TDD §46). */
export function RunsPage() {
  const { value, loading, error } = useRuns();
  const runs = value ?? [];
  return (
    <PageShell title="Runs" subtitle="Recent investigations recorded by the runtime">
      <AsyncState loading={loading} error={error}>
        <Card>
          {runs.length === 0 ? (
            <p style={{ color: palette.muted, margin: 0 }}>No runs have been recorded by the runtime process serving this portal.</p>
          ) : (
            <Table head={['Time', 'User', 'Agents', 'Status', 'Tools', 'Evidence', 'Duration']}>
              {runs.map(run => (
                <Row key={run.requestId}>
                  <Cell><a href={`#/agent-management/runs/${run.requestId}`} style={{ color: palette.accent, textDecoration: 'none', fontWeight: 600 }}>{run.startedAt}</a></Cell>
                  {/* the human initiator is carried as a hash; the portal never sees the raw subject */}
                  <Cell><Mono>{run.userSubjectHash.slice(0, 12)}…</Mono></Cell>
                  <Cell>{run.agents.join(', ')}</Cell>
                  <Cell><Pill tone={run.status === 'complete' ? 'ok' : run.status === 'partial' ? 'warn' : 'danger'}>{run.status}</Pill></Cell>
                  <Cell>{run.toolCalls}</Cell>
                  <Cell>{run.evidenceCount}</Cell>
                  <Cell>{run.durationMs} ms</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>
      </AsyncState>
    </PageShell>
  );
}

/** Execution graph for a single run (TDD §45). */
export function RunDetailPage({ runId }: { runId: string }) {
  const { value, loading, error } = useRun(runId);
  return (
    <PageShell title="Run" subtitle={runId}>
      <AsyncState loading={loading} error={error}>
        {value && (
          <>
            <Grid min={190}>
              <StatTile label="Status" value={value.status} tone={value.status === 'complete' ? 'ok' : value.status === 'partial' ? 'warn' : 'danger'} />
              <StatTile label="Duration" value={`${value.durationMs} ms`} />
              <StatTile label="Tool calls" value={value.toolCalls} />
              <StatTile label="Denied calls" value={value.deniedToolCalls} tone={value.deniedToolCalls ? 'danger' : 'default'} />
              <StatTile label="Evidence" value={value.evidenceCount} />
            </Grid>

            <Card title="Identity chain">
              {/* human initiator and agent workloads are shown separately — TDD §13 */}
              <KeyValue
                items={[
                  ['Initiated by (human)', <Mono key="h">{value.userSubjectHash.slice(0, 24)}…</Mono>],
                  ['Executed by (workloads)', value.workloads.map(workload => <Pill tone="neutral" key={workload}>{workload}</Pill>)],
                  ['Environment', value.environment],
                  ['Model profiles', value.modelProfiles.join(', ') || '—'],
                ]}
              />
            </Card>

            <Card title="Execution graph">
              <ExecutionGraph nodes={value.nodes} />
              <p style={{ color: palette.muted, fontSize: 12.5, marginBottom: 0, marginTop: 14 }}>
                Model reasoning and tool payloads are deliberately not recorded.
              </p>
            </Card>
          </>
        )}
      </AsyncState>
    </PageShell>
  );
}

const KIND_COLOR: Record<string, string> = {
  'manager.route': '#5b4ff5',
  specialist: '#0f8bd6',
  'workload.token': '#8557d6',
  'toolhive.call': '#d68a00',
  evidence: '#12a557',
  'domain.escalation': '#d92d42',
  synthesis: '#1c1f37',
  'authorization.check': '#676b8a',
};

/**
 * Renders the run as a tree rather than a flat timeline, so fan-out to several
 * specialists and the fan-in at synthesis stay visible.
 */
function ExecutionGraph({ nodes }: { nodes: RunNode[] }) {
  const children = new Map<string, RunNode[]>();
  const roots: RunNode[] = [];
  for (const node of nodes) {
    if (node.parentId === undefined) roots.push(node);
    else children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  const render = (node: RunNode, depth: number): JSX.Element => (
    <div key={node.id} style={{ marginLeft: depth * 22, borderLeft: depth ? `2px solid ${palette.border}` : 'none', paddingLeft: depth ? 14 : 0, marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: KIND_COLOR[node.kind] ?? palette.muted, display: 'inline-block' }} />
        <span style={{ fontSize: 12, color: palette.muted, fontWeight: 600, minWidth: 128 }}>{node.kind}</span>
        <span style={{ fontSize: 13.5, color: palette.text }}>{node.label}</span>
        {node.status !== 'ok' && <Pill tone={node.status === 'denied' ? 'danger' : 'warn'}>{node.status}</Pill>}
        {node.round === 2 && <Pill tone="warn">round 2</Pill>}
      </div>
      {(children.get(node.id) ?? []).map(child => render(child, depth + 1))}
    </div>
  );
  return <div>{roots.map(node => render(node, 0))}</div>;
}
