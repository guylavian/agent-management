import { useState } from 'react';
import { useRun, useRunDiagnosis, useRuns } from '../api/client';
import {
  AsyncState,
  Body,
  Breadcrumb,
  Button,
  C,
  Chip,
  DataRow,
  DataTable,
  DefinitionList,
  EmptyState,
  MONO,
  Mono,
  Muted,
  Page,
  PageHeader,
  Panel,
  S,
  StatCard,
  StatGrid,
  StatusPill,
  Tabs,
  runStatusColor,
  runStatusTone,
} from './common';
import { RunFlow } from './RunFlow';
import type { RunDetail, RunNode } from '../api/types';

const COLUMNS = '.8fr 2fr 1.2fr .6fr .5fr .5fr .6fr';

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
            <DataTable columns={COLUMNS} head={['TIME', 'QUESTION', 'AGENTS', 'STATUS', 'TOOLS', 'EVIDENCE', 'DURATION']}>
              {runs.map(run => (
                <DataRow key={run.requestId} columns={COLUMNS} onClick={() => { window.location.href = `/runs/${run.requestId}`; }}>
                  <Muted mono>{new Date(run.startedAt).toLocaleTimeString()}</Muted>
                  {/*
                    * The question is what makes this list scannable. It is stored
                    * redacted, and an older run recorded before this existed says
                    * so rather than showing an empty cell.
                    */}
                  {run.question ? <Body>{run.question}</Body> : <Muted>question not recorded</Muted>}
                  <Muted>{run.agents.join(', ') || '—'}</Muted>
                  <div><StatusPill tone={runStatusTone(run.status)}>{run.status}</StatusPill></div>
                  <Body>{run.toolCalls}</Body>
                  <Body>{run.evidenceCount}</Body>
                  <Muted mono>{run.durationMs} ms</Muted>
                </DataRow>
              ))}
            </DataTable>
          )}
        </Panel>
      </AsyncState>
    </Page>
  );
}

const TABS = ['Flow', 'Timeline', 'Evidence', 'Diagnosis', 'Details'] as const;

/**
 * One run, as an execution trace (TDD §45).
 *
 * Four views of ONE event list, not four datasets. Flow reads the parent links
 * and shows the shape of the investigation; Timeline ignores them and shows the
 * order; Evidence and Details are filters. Nothing is computed in the browser
 * that the runtime did not record.
 */
export function RunDetailPage({ runId }: { runId: string }) {
  const { value, loading, error } = useRun(runId);
  const [tab, setTab] = useState<string>(TABS[0]);

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Runs', onClick: () => { window.location.href = '/runs'; } }, { label: runId.slice(0, 8) }]} />
      <AsyncState loading={loading} error={error}>
        {value && (
          <>
            <PageHeader
              title={value.question ?? 'Run'}
              subtitle={value.question ? undefined : runId}
            />

            {/* the run header stays put across every tab */}
            <StatGrid columns={6}>
              <StatCard label="Status" value={value.status} dot={runStatusColor(value.status)} sub={outcome(value)} />
              <StatCard label="Started" value={new Date(value.startedAt).toLocaleTimeString()} sub={new Date(value.startedAt).toLocaleDateString()} />
              <StatCard label="Duration" value={`${value.durationMs} ms`} />
              <StatCard label="Specialists" value={value.agents.length || '—'} sub={value.agents.join(', ') || 'none ran'} />
              <StatCard label="Denied" value={value.deniedToolCalls} sub={value.deniedToolCalls ? 'refused by policy' : 'none'} dot={value.deniedToolCalls ? C.redBright : undefined} />
              <StatCard label="Evidence" value={value.evidenceCount} sub={`${value.toolCalls} tool calls`} />
            </StatGrid>

            <div style={{ marginTop: S.lg, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: S.md }}>
              <Tabs tabs={TABS} active={tab} onChange={setTab} />
              <CopyTrace run={value} />
            </div>

            <div style={{ marginTop: S.lg }}>
              {tab === 'Flow' && <Panel title="Execution flow"><RunFlow nodes={value.nodes} /></Panel>}
              {tab === 'Timeline' && <Panel title="Timeline" padded={false}><Timeline nodes={value.nodes} /></Panel>}
              {tab === 'Evidence' && <Panel title="Evidence" padded={false}><EvidenceList nodes={value.nodes} /></Panel>}
              {tab === 'Diagnosis' && <Diagnosis run={value} />}
              {tab === 'Details' && <Details run={value} />}
            </div>
          </>
        )}
      </AsyncState>
    </Page>
  );
}

/** The one sentence that says why a run ended as it did, when there is one. */
function outcome(run: RunDetail): string | undefined {
  return run.nodes.find(node => node.kind === 'run.completed')?.detail;
}

/** Events that carry the substance of a step get their detail shown inline. */
const SHOW_DETAIL = new Set(['specialist', 'authorization.check', 'agent.result', 'domain.escalation', 'followup.route', 'run.completed', 'error']);

const TIMELINE_COLUMNS = '.9fr .9fr 1.1fr 2.4fr .6fr';

/**
 * The same events in the order they happened.
 *
 * Timestamps are whatever the runtime actually recorded — a tool result
 * carries its observation time, and a step that has no distinct time of its own
 * carries the run's start rather than an invented one.
 */
/**
 * The whole trace on the clipboard, so it can be pasted somewhere else — an
 * issue, a chat, another model. It is the same JSON the page is rendering, and
 * the same JSON the diagnosis below is given: scalars, citations rather than
 * payloads, a redacted question and a hashed initiator.
 */
function CopyTrace({ run }: { run: RunDetail }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const json = JSON.stringify(run, null, 2);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      // clipboard is unavailable outside a secure context; a selectable
      // fallback beats a button that silently does nothing
      window.prompt('Copy the run trace:', json);
      return;
    }
    setCopied(true);
    setTimeout(() => { setCopied(false); }, 1600);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, paddingBottom: 6 }}>
      {copied && <Muted size={12}>copied</Muted>}
      <Button variant="secondary" onClick={() => { void copy(); }}>Copy JSON</Button>
    </div>
  );
}

/**
 * The trace, read back by the console-assistance model.
 *
 * On demand rather than on load: it costs a model call, and most runs are
 * opened to look at one node rather than to ask what happened.
 *
 * This is a READING of the trace, not a source of truth — it is never stored on
 * the run, and it cannot re-run anything or reach a tool. The page says so,
 * because a paragraph of fluent prose beside an audit trail invites being
 * quoted as though it were evidence.
 */
function Diagnosis({ run }: { run: RunDetail }) {
  const diagnose = useRunDiagnosis();
  const [text, setText] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setBusy(true);
    setIssue(undefined);
    try {
      setText((await diagnose(run.requestId)).diagnosis);
    } catch (error) {
      const body = error as { reason?: string; message?: string };
      setIssue(body.reason ?? body.message ?? 'The run could not be diagnosed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Diagnosis">
      <div style={{ marginBottom: S.md }}>
        <Muted size={12.5}>
          A reading of this trace by the console-assistance model. It sees the trace and nothing
          else, stores nothing, and cannot re-run the investigation — treat it as a starting point,
          not as evidence.
        </Muted>
      </div>
      {text === undefined && issue === undefined && (
        <Button onClick={() => { void ask(); }} disabled={busy}>{busy ? 'Reading the trace…' : 'Diagnose this run'}</Button>
      )}
      {issue !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: S.sm, alignItems: 'flex-start' }}>
          <StatusPill tone="warn">{issue}</StatusPill>
          <Button variant="secondary" onClick={() => { void ask(); }} disabled={busy}>Try again</Button>
        </div>
      )}
      {text !== undefined && (
        <>
          <div style={{ color: C.bodySoft, fontSize: 13.5, whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{text}</div>
          <div style={{ marginTop: S.md }}>
            <Button variant="secondary" onClick={() => { void ask(); }} disabled={busy}>Read it again</Button>
          </div>
        </>
      )}
    </Panel>
  );
}

function Timeline({ nodes }: { nodes: RunNode[] }) {
  const ordered = [...nodes].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const origin = ordered[0]?.startedAt;

  return (
    <DataTable columns={TIMELINE_COLUMNS} head={['TIME', 'ACTOR', 'EVENT', 'WHAT', 'STATUS']}>
      {ordered.map(node => (
        <DataRow key={node.id} columns={TIMELINE_COLUMNS}>
          <Muted mono>{origin === undefined ? '' : offset(origin, node.startedAt)}</Muted>
          <Muted>{node.actor}</Muted>
          <Body mono>{node.kind}</Body>
          <div style={{ minWidth: 0 }}>
            <Body>{node.label}</Body>
            {node.detail !== undefined && SHOW_DETAIL.has(node.kind) && (
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{node.detail}</div>
            )}
          </div>
          <div>{node.status === 'ok' ? <Muted size={12}>ok</Muted> : <StatusPill tone={node.status === 'denied' ? 'danger' : 'warn'}>{node.status}</StatusPill>}</div>
        </DataRow>
      ))}
    </DataTable>
  );
}

/** Elapsed since the first event, which is more useful here than a wall clock. */
function offset(origin: string, at: string): string {
  const ms = new Date(at).getTime() - new Date(origin).getTime();
  return Number.isFinite(ms) ? `+${ms} ms` : '';
}

const EVIDENCE_COLUMNS = '1fr 1.4fr 2fr .6fr';

function EvidenceList({ nodes }: { nodes: RunNode[] }) {
  const evidence = nodes.filter(node => node.kind === 'evidence');
  if (evidence.length === 0) return <EmptyState>This run collected no evidence.</EmptyState>;

  return (
    <DataTable columns={EVIDENCE_COLUMNS} head={['AGENT', 'SOURCE', 'CITATION', 'STATUS']}>
      {evidence.map(node => (
        <DataRow key={node.id} columns={EVIDENCE_COLUMNS}>
          <Body>{node.agentId ?? '—'}</Body>
          <Muted mono>{node.tool ? `${node.mcp}/${node.tool}` : node.label}</Muted>
          {/* a reference to the evidence, never its contents */}
          {typeof node.metadata?.citation === 'string'
            ? <Muted mono>{node.metadata.citation}</Muted>
            : <Muted>—</Muted>}
          <div>{node.status === 'ok' ? <Muted size={12}>ok</Muted> : <StatusPill tone={node.status === 'denied' ? 'danger' : 'warn'}>{node.status}</StatusPill>}</div>
        </DataRow>
      ))}
    </DataTable>
  );
}

function Details({ run }: { run: RunDetail }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: S.lg }}>
      <Panel title="Request">
        <DefinitionList
          items={[
            ['Request id', <Mono key="r">{run.requestId}</Mono>],
            ['Question (redacted)', run.question ?? <Muted key="q">not recorded</Muted>],
            ['Started', new Date(run.startedAt).toLocaleString()],
            ['Outcome', outcome(run) ?? run.status],
          ]}
        />
      </Panel>

      <Panel title="Identity chain">
        {/* human initiator and agent workloads are shown separately — TDD §13 */}
        <DefinitionList
          items={[
            ['Initiated by (human)', <Mono key="h">{run.userSubjectHash.slice(0, 32)}…</Mono>],
            ['Executed by (workloads)', <div key="w" style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{run.workloads.map(workload => <Chip key={workload} mono>{workload}</Chip>)}</div>],
            ['Environment', run.environment],
            ['Model profiles', run.modelProfiles.join(', ') || '—'],
          ]}
        />
      </Panel>

      <Panel title="What is not recorded">
        <div style={{ fontSize: 13, color: C.bodySoft, lineHeight: 1.6, maxWidth: 720 }}>
          A run records what was decided and what was done. It does not record the model's reasoning,
          the arguments a tool was called with, the payload it returned, the answer text, or any
          credential. The question is stored only after the same redaction the model sees, and event
          metadata accepts scalars alone, so no payload can be attached to one.
        </div>
        <div style={{ marginTop: S.md, fontFamily: MONO, fontSize: 12, color: C.faint }}>
          {run.nodes.length} events recorded
        </div>
      </Panel>
    </div>
  );
}
