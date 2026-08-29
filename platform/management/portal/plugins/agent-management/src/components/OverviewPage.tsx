import { useAgents, useMcpServers, useRuns } from '../api/client';
import {
  AgentTile,
  AsyncState,
  Button,
  C,
  Card,
  GroupHeader,
  Icon,
  Muted,
  Page,
  PageHeader,
  S,
  StatusPill,
  clickable,
  lifecycleTone,
  relativeTime,
  runStatusTone,
} from './common';
import type { AgentSummary, RunSummary } from '../api/types';

/**
 * Overview (TDD §19).
 *
 * This screen answers "who are my agents, how are they, and what happened
 * recently" — visually. It deliberately holds NO agent table: `/agents` already
 * exists for inspecting, filtering and managing, and repeating that table here
 * made the workspace read as a second administration console rather than as a
 * home.
 *
 * Every number and every row is counted from real configuration or from runs
 * the runtime actually recorded.
 */
export function OverviewPage() {
  const agents = useAgents();
  const servers = useMcpServers();
  const runs = useRuns();

  const list = agents.value ?? [];
  const active = list.filter(agent => agent.lifecycle === 'active');
  const attention = list.filter(agent => agent.lifecycle !== 'active');
  const connections = list.reduce((total, agent) => total + agent.mcpCount, 0);
  const allReadOnly = list.length > 0 && list.every(agent => agent.readOnly);

  const go = (path: string) => { window.location.href = path; };

  return (
    <Page>
      <PageHeader
        title="Overview"
        subtitle="Your agent workspace and recent platform activity"
        action={<Button onClick={() => go('/create-agent')}>+ Create agent</Button>}
      />

      <AsyncState loading={agents.loading} error={agents.error}>
        {/*
          * Shown ONLY when something is actually not active. An empty panel
          * reserving space for a problem that does not exist is a permanent
          * cost paid for an occasional message.
          */}
        {attention.length > 0 && (
          <div style={{ background: C.amberSoft, border: `1px solid ${C.amberBright}`, borderRadius: 12, padding: 20, marginBottom: 8, display: 'flex', alignItems: 'center', gap: S.md, flexWrap: 'wrap' }}>
            <span style={{ color: C.amber, display: 'flex' }}><Icon name="security" size={18} /></span>
            <div style={{ fontSize: 14.5, color: C.amber, fontWeight: 500 }}>
              {attention.length} agent{attention.length === 1 ? '' : 's'} not active
            </div>
            <div style={{ display: 'flex', gap: S.sm, flexWrap: 'wrap' }}>
              {attention.map(agent => (
                <span key={agent.id} {...clickable(() => go(`/agents/${agent.id}`))} style={{ cursor: 'pointer' }}>
                  <StatusPill tone={lifecycleTone(agent.lifecycle)}>{agent.displayName} — {agent.lifecycle}</StatusPill>
                </span>
              ))}
            </div>
          </div>
        )}

        <GroupHeader
          title="Your agents"
          action={<Button variant="link" onClick={() => go('/agents')}>View all agents</Button>}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: S.lg }}>
          {list.map(agent => <WorkspaceCard key={agent.id} agent={agent} onOpen={() => go(`/agents/${agent.id}`)} />)}
        </div>

        <GroupHeader title="Platform snapshot" />
        <Card>
          <div style={{ display: 'flex', gap: 56, flexWrap: 'wrap' }}>
            <Fact value={String(active.length)} label={`active agent${active.length === 1 ? '' : 's'}`} />
            <Fact value={String(connections)} label="MCP connections" />
            <Fact value={String(servers.error ? '—' : (servers.value?.length ?? 0))} label="MCP servers behind ToolHive" />
            <Fact value={allReadOnly ? 'Enforced' : 'Mixed'} label="read-only posture" tone={allReadOnly ? C.green : C.amber} />
          </div>
        </Card>

        <GroupHeader title="Recent activity" action={<Button variant="link" onClick={() => go('/runs')}>View all runs</Button>} />
        <Card padded={false}>
          <AsyncState loading={runs.loading} error={runs.error}>
            {(runs.value ?? []).length === 0 ? (
              <div style={{ padding: '28px 20px', color: C.muted, fontSize: 14, textAlign: 'center' }}>
                No runs have been recorded by this runtime process yet.
              </div>
            ) : (
              <div>
                {(runs.value ?? []).slice(0, 6).map((run, index) => (
                  <ActivityRow key={run.requestId} run={run} first={index === 0} onOpen={() => go(`/runs/${run.requestId}`)} />
                ))}
              </div>
            )}
          </AsyncState>
        </Card>
      </AsyncState>
    </Page>
  );
}

/**
 * An agent as a first-class thing rather than a table row.
 *
 * `AgentSummary` carries no description — the list endpoint returns eleven
 * fields and that is not one of them — so the second line is the owning team,
 * which is real, rather than a sentence someone would have to invent.
 */
function WorkspaceCard({ agent, onOpen }: { agent: AgentSummary; onOpen: () => void }) {
  return (
    <Card onClick={onOpen}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 132 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: S.md, marginBottom: S.md }}>
          <AgentTile id={agent.id} owner={agent.owner} size={44} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3, letterSpacing: '-0.2px' }}>{agent.displayName}</div>
            <div style={{ marginTop: 6 }}><StatusPill tone={lifecycleTone(agent.lifecycle)}>{agent.lifecycle}</StatusPill></div>
          </div>
        </div>

        {/*
          * The owner verbatim. Title-casing it produced "Sre observability"
          * and "Paas" — a team identifier is a name, and prettifying a name
          * into something nobody calls it is worse than showing it plainly.
          */}
        <Muted size={13.5}>{agent.owner}</Muted>

        <div style={{ marginTop: 'auto', paddingTop: S.lg, display: 'flex', alignItems: 'center', gap: S.sm, color: C.muted, fontSize: 13.5 }}>
          <Icon name="mcp" size={15} />
          <span>{agent.mcpCount} MCP{agent.mcpCount === 1 ? '' : 's'}</span>
          <span style={{ color: C.border }}>·</span>
          <Icon name="tool" size={15} />
          <span>{agent.toolCount} tool{agent.toolCount === 1 ? '' : 's'}</span>
        </div>
      </div>
    </Card>
  );
}

/**
 * One recorded run. The event vocabulary is limited to what the runtime stores:
 * a run and its outcome. Configuration and prompt edits leave no record any
 * endpoint exposes, so they are not listed here as if they did.
 */
function ActivityRow({ run, first, onOpen }: { run: RunSummary; first: boolean; onOpen: () => void }) {
  const agent = run.agents[0] ?? 'manager';
  return (
    <div
      {...clickable(onOpen)}
      style={{
        display: 'flex', alignItems: 'center', gap: S.md, padding: '14px 20px', cursor: 'pointer',
        borderTop: first ? 'none' : `1px solid ${C.ruleSoft}`,
      }}
    >
      <AgentTile id={agent} owner={agent} size={28} />
      <div style={{ fontSize: 14, fontWeight: 500, minWidth: 168 }}>{run.agents.join(', ') || 'manager'}</div>
      <StatusPill tone={runStatusTone(run.status)}>Run {run.status}</StatusPill>
      <Muted size={13.5}>{run.toolCalls} tool call{run.toolCalls === 1 ? '' : 's'}, {run.evidenceCount} evidence</Muted>
      <div style={{ flex: 1 }} />
      <Muted size={13.5}>{relativeTime(run.startedAt)}</Muted>
    </div>
  );
}

function Fact({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.5px', color: tone ?? C.text }}>{value}</div>
      <div style={{ fontSize: 13.5, color: C.muted, marginTop: 2 }}>{label}</div>
    </div>
  );
}
