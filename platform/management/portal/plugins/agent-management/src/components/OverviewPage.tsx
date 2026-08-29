import { useAgents, useMcpServers, useRuns } from '../api/client';
import {
  AgentTile,
  AsyncState,
  Body,
  Button,
  C,
  Card,
  DataRow,
  DataTable,
  EmptyState,
  GroupHeader,
  Icon,
  LifecycleBadge,
  MONO,
  Muted,
  Page,
  PageHeader,
  Panel,
  S,
  StatusPill,
  clickable,
  relativeTime,
  runStatusTone,
} from './common';

const HEALTH_COLUMNS = '2.2fr .9fr 1.1fr 1.1fr .5fr 1fr';
const ACTIVITY_COLUMNS = '1.4fr .8fr 1.5fr .8fr';

/**
 * Overview (TDD §19).
 *
 * Six equal KPI cards gave the same visual weight to "how many teams" and "how
 * many agents are disabled", which are not equally interesting. What an
 * operator opening this page wants is a sentence about the workspace, then the
 * agents that are not healthy, then what has happened recently.
 *
 * Every number here is counted from real configuration or recorded runs.
 */
export function OverviewPage() {
  const agents = useAgents();
  const servers = useMcpServers();
  const runs = useRuns();

  const list = agents.value ?? [];
  const active = list.filter(agent => agent.lifecycle === 'active');
  const disabled = list.filter(agent => agent.lifecycle === 'disabled' || agent.lifecycle === 'removed');
  const pending = list.filter(agent => agent.lifecycle === 'draft' || agent.lifecycle === 'decommissioning');
  const teams = new Set(list.map(agent => agent.owner));
  const attention = [...pending, ...disabled];

  const lastByAgent = new Map<string, string>();
  for (const run of runs.value ?? []) {
    for (const agent of run.agents) if (!lastByAgent.has(agent)) lastByAgent.set(agent, run.startedAt);
  }

  const go = (path: string) => { window.location.href = path; };

  return (
    <Page>
      <PageHeader
        title="Overview"
        subtitle="Your SRE specialists, the servers they reach and what they have been doing."
        action={<Button onClick={() => go('/create-agent')}>+ Create agent</Button>}
      />

      <AsyncState loading={agents.loading} error={agents.error}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: S.md, alignItems: 'stretch' }}>
          {/* the workspace in a sentence, not a scoreboard */}
          <Card>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: S.sm }}>
              {list.length} specialist{list.length === 1 ? '' : 's'} across {teams.size} team{teams.size === 1 ? '' : 's'}
            </div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.7, maxWidth: 620 }}>
              {active.length} routable by the Manager, reaching {servers.error ? '—' : (servers.value?.length ?? 0)} MCP server
              {(servers.value?.length ?? 0) === 1 ? '' : 's'} through ToolHive.
              {' '}Every agent is read-only, and every change reaches production as a merged pull request.
            </div>
            <div style={{ display: 'flex', gap: S.xl, marginTop: S.lg, flexWrap: 'wrap' }}>
              <Metric label="Active" value={active.length} tone={C.greenBright} />
              <Metric label="Draft / decommissioning" value={pending.length} tone={pending.length > 0 ? C.amberBright : undefined} />
              <Metric label="Disabled" value={disabled.length} tone={disabled.length > 0 ? C.redBright : undefined} />
              <Metric label="Recorded runs" value={runs.error ? '—' : (runs.value?.length ?? 0)} />
            </div>
          </Card>

          {/* only the agents that are NOT simply fine; an empty panel here is good news and says so */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, marginBottom: S.md }}>
              <span style={{ color: C.muted, display: 'flex' }}><Icon name="security" /></span>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Needs attention</div>
            </div>
            {attention.length === 0 ? (
              <Muted size={12.5}>Every agent is active. Nothing is draft, decommissioning or disabled.</Muted>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: S.sm }}>
                {attention.map(agent => (
                  <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: S.sm, cursor: 'pointer' }} {...clickable(() => go(`/agents/${agent.id}`))}>
                    <AgentTile id={agent.id} owner={agent.owner} size={24} />
                    <Body>{agent.displayName}</Body>
                    <div style={{ flex: 1 }} />
                    <LifecycleBadge lifecycle={agent.lifecycle} />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <GroupHeader
          title="Agent health"
          icon="agents"
          action={<Button variant="link" onClick={() => go('/agents')}>View all agents</Button>}
        />
        <Panel padded={false}>
          <DataTable columns={HEALTH_COLUMNS} head={['Agent', 'Status', 'Owner', 'Model profile', 'MCPs', 'Last activity']}>
            {list.map(agent => (
              <DataRow key={agent.id} columns={HEALTH_COLUMNS} onClick={() => go(`/agents/${agent.id}`)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, minWidth: 0 }}>
                  <AgentTile id={agent.id} owner={agent.owner} size={28} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{agent.displayName}</div>
                    <div style={{ fontSize: 12, fontFamily: MONO, color: C.faint }}>{agent.id}</div>
                  </div>
                </div>
                <div><LifecycleBadge lifecycle={agent.lifecycle} /></div>
                <Body>{agent.owner}</Body>
                <Body mono>{agent.modelProfile}</Body>
                <Body>{agent.mcpCount}</Body>
                {/* no run history reads as "never", never as a fabricated timestamp */}
                <Muted size={12.5}>{lastByAgent.has(agent.id) ? relativeTime(lastByAgent.get(agent.id) as string) : 'never'}</Muted>
              </DataRow>
            ))}
          </DataTable>
        </Panel>

        <GroupHeader title="Recent activity" icon="activity" action={<Button variant="link" onClick={() => go('/runs')}>View all runs</Button>} />
        <Panel padded={false}>
          <AsyncState loading={runs.loading} error={runs.error}>
            {(runs.value ?? []).length === 0 ? (
              <EmptyState>No runs have been recorded by this runtime process yet.</EmptyState>
            ) : (
              <DataTable columns={ACTIVITY_COLUMNS} head={['Agent', 'Event', 'Details', 'When']}>
                {(runs.value ?? []).slice(0, 6).map(run => (
                  <DataRow key={run.requestId} columns={ACTIVITY_COLUMNS} onClick={() => go(`/runs/${run.requestId}`)}>
                    <Body>{run.agents.join(', ') || '—'}</Body>
                    <StatusPill tone={runStatusTone(run.status)}>{run.status}</StatusPill>
                    <Muted size={12.5}>{run.toolCalls} tool call{run.toolCalls === 1 ? '' : 's'}, {run.evidenceCount} evidence</Muted>
                    <Muted size={12.5}>{relativeTime(run.startedAt)}</Muted>
                  </DataRow>
                ))}
              </DataTable>
            )}
          </AsyncState>
        </Panel>
      </AsyncState>
    </Page>
  );
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted }}>
        {tone && <span style={{ width: 6, height: 6, borderRadius: 99, background: tone, flex: 'none' }} />}
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2, letterSpacing: '-0.3px' }}>{value}</div>
    </div>
  );
}
