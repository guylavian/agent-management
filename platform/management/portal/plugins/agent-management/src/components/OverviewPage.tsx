import { useAgents, useMcpServers, useRuns } from '../api/client';
import {
  AGENT_GRID,
  AgentGridCard,
  AgentTile,
  AsyncState,
  Button,
  C,
  GroupHeader,
  Muted,
  Page,
  PageHeader,
  Panel,
  S,
  clickable,
  relativeTime,
  runStatusColor,
  tileTone,
} from './common';
import type { RunSummary } from '../api/types';

const ACTIVITY_COLUMNS = '1.4fr 1.2fr 2fr 1.1fr .7fr';

/**
 * Overview (TDD §19).
 *
 * Three sections, each its own surface: the agents, one line about the
 * platform, and what has happened recently. It holds NO agent table — /agents
 * exists for inspecting and filtering, and repeating that here is what made
 * this screen read as a second administration console rather than as a home.
 *
 * Every value is counted from real configuration or from runs the runtime
 * recorded.
 */
export function OverviewPage() {
  const agents = useAgents();
  const servers = useMcpServers();
  const runs = useRuns();

  const list = agents.value ?? [];
  const active = list.filter(agent => agent.lifecycle === 'active');
  const connections = list.reduce((total, agent) => total + agent.mcpCount, 0);
  const tools = list.reduce((total, agent) => total + agent.toolCount, 0);

  const go = (path: string) => { window.location.href = path; };

  return (
    <Page>
      <PageHeader
        title="Overview"
        subtitle="Your agent workspace and recent platform activity."
        action={<Button onClick={() => go('/create-agent')}>+ Create agent</Button>}
      />

      <AsyncState loading={agents.loading} error={agents.error}>
        <Panel>
          <GroupHeader title="Your agents" action={<Button variant="link" onClick={() => go('/agents')}>View all agents</Button>} />
          <div style={AGENT_GRID}>
            {list.map(agent => (
              <AgentGridCard
                key={agent.id}
                id={agent.id}
                displayName={agent.displayName}
                {...(agent.description === undefined ? {} : { description: agent.description })}
                owner={agent.owner}
                lifecycle={agent.lifecycle}
                mcpCount={agent.mcpCount}
                toolCount={agent.toolCount}
                readOnly={agent.readOnly}
                {...(agent.avatar === undefined ? {} : { avatar: agent.avatar })}
                onOpen={() => go(`/agents/${agent.id}`)}
              />
            ))}
          </div>
        </Panel>

        <div style={{ marginTop: 20 }}>
          <Panel>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '16px 24px' }}>
              <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: C.bodySoft, lineHeight: 1.6 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>Platform snapshot</div>
                Your SRE specialists are routed by the Manager.<br />
                Every change reaches production as a merged pull request.
              </div>
              <Stat value={String(active.length)} label={`active agent${active.length === 1 ? '' : 's'}`} index={0} />
              <Stat value={String(connections)} label="MCP connections" index={1} />
              <Stat value={String(servers.error ? '—' : (servers.value?.length ?? 0))} label="servers behind ToolHive" index={2} />
              <Stat value={String(tools)} label="read-only tools granted" index={3} />
            </div>
          </Panel>
        </div>

        <div style={{ marginTop: 20 }}>
          <Panel>
            <GroupHeader title="Recent activity" action={<Button variant="link" onClick={() => go('/runs')}>View all activity</Button>} />
            <AsyncState loading={runs.loading} error={runs.error}>
              {(runs.value ?? []).length === 0 ? (
                <div style={{ padding: '4px 0 2px 0', color: C.muted, fontSize: 13 }}>
                  No runs have been recorded by this runtime process yet.
                </div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: ACTIVITY_COLUMNS, gap: S.md, padding: '8px 12px', fontSize: 11, fontWeight: 600, letterSpacing: '.4px', textTransform: 'uppercase', color: C.faint, borderBottom: `1px solid ${C.border}` }}>
                    <div>Agent</div><div>Event</div><div>Details</div><div>Triggered by</div><div>When</div>
                  </div>
                  {(runs.value ?? []).slice(0, 6).map(run => (
                    <ActivityRow key={run.requestId} run={run} onOpen={() => go(`/runs/${run.requestId}`)} />
                  ))}
                </>
              )}
            </AsyncState>
          </Panel>
        </div>
      </AsyncState>
    </Page>
  );
}

/**
 * One recorded run.
 *
 * The reference shows a person's face and name under "Triggered by". The
 * runtime hashes the subject before it leaves the process, deliberately, so
 * the only honest answer is the hash — shown truncated, and labelled as one.
 * The event vocabulary is likewise limited to what is stored: a run and its
 * outcome. No endpoint records a configuration or prompt edit, so none is
 * listed here as though it did.
 */
function ActivityRow({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  const agent = run.agents[0] ?? 'manager';
  const tone = tileTone(run.userSubjectHash);
  return (
    <div
      {...clickable(onOpen)}
      style={{ display: 'grid', gridTemplateColumns: ACTIVITY_COLUMNS, gap: S.md, alignItems: 'center', padding: '11px 12px', borderBottom: `1px solid ${C.rule}`, fontSize: 13, cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 500, minWidth: 0 }}>
        <AgentTile id={agent} owner={agent} size={22} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.agents.join(', ') || 'manager'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: C.body }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: runStatusColor(run.status), flex: 'none' }} />
        Run {run.status}
      </div>
      <div style={{ color: C.bodySoft, fontSize: 12.5 }}>
        {run.toolCalls} tool call{run.toolCalls === 1 ? '' : 's'}, {run.evidenceCount} evidence, {run.durationMs} ms
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: C.body, minWidth: 0 }}>
        <span
          title="The runtime hashes the subject before it leaves the process, so no name is available."
          style={{ width: 22, height: 22, borderRadius: 99, background: tone.bg, color: tone.fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700, flex: 'none' }}
        >
          {run.userSubjectHash.slice(0, 2).toUpperCase()}
        </span>
        <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{run.userSubjectHash.slice(0, 10)}</span>
      </div>
      <Muted size={12.5}>{relativeTime(run.startedAt)}</Muted>
    </div>
  );
}

/** A counted fact: the number in a tinted tile, the noun beside it. */
function Stat({ value, label, index }: { value: string; label: string; index: number }) {
  const tone = tileTone(String(index));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: S.md, paddingLeft: S.xl, borderLeft: `1px solid ${C.rule}` }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: tone.bg, color: tone.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flex: 'none' }}>
        {value}
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.35, maxWidth: 96 }}>{label}</div>
    </div>
  );
}
