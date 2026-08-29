import { useAgents, useMcpServers, useRuns } from '../api/client';
import {
  AsyncState,
  Body,
  Button,
  C,
  DataRow,
  DataTable,
  LifecycleBadge,
  MONO,
  Muted,
  Page,
  PageHeader,
  Panel,
  StatCard,
  StatGrid,
} from './common';

const COLUMNS = '2.4fr 1fr 1.2fr 1.2fr .55fr 1fr .8fr';

/** Overview dashboard (TDD §19). Every number is counted from real config or recorded runs. */
export function OverviewPage() {
  const agents = useAgents();
  const servers = useMcpServers();
  const runs = useRuns();

  const list = agents.value ?? [];
  const active = list.filter(agent => agent.lifecycle === 'active');
  const disabled = list.filter(agent => agent.lifecycle === 'disabled' || agent.lifecycle === 'removed');
  const pending = list.filter(agent => agent.lifecycle === 'draft' || agent.lifecycle === 'decommissioning');
  const teams = new Set(list.map(agent => agent.owner));

  const lastByAgent = new Map<string, string>();
  for (const run of runs.value ?? []) {
    for (const agent of run.agents) if (!lastByAgent.has(agent)) lastByAgent.set(agent, run.startedAt);
  }

  const go = (path: string) => { window.location.href = path; };

  return (
    <Page>
      <PageHeader
        title="Overview"
        subtitle="Domain-specialist agents, their access and their runs"
        action={<Button onClick={() => go('/create-agent')}>Create agent</Button>}
      />
      <AsyncState loading={agents.loading} error={agents.error}>
        <StatGrid columns={6}>
          {/* a dot ONLY where it encodes a health state: the three lifecycle
              counts. Total, runs and servers are quantities, not conditions, and
              colouring them made the strip read as six unrelated signals. */}
          <StatCard label="Agents" value={list.length} sub={`across ${teams.size} team${teams.size === 1 ? '' : 's'}`} />
          <StatCard label="Active" value={active.length} sub="routable by the Manager" dot={C.greenBright} />
          <StatCard label="Draft / decommissioning" value={pending.length} sub={pending.map(a => a.id).join(', ') || 'none'} dot={C.amberBright} />
          <StatCard label="Disabled" value={disabled.length} sub="no workload token issued" dot={C.redBright} />
          <StatCard label="Recorded runs" value={runs.error ? '—' : (runs.value?.length ?? 0)} sub="current runtime process" />
          <StatCard label="MCP servers" value={servers.error ? '—' : (servers.value?.length ?? 0)} sub="behind ToolHive" />
        </StatGrid>

        <Panel
          title="Agent health"
          padded={false}
          action={<Button variant="link" onClick={() => go('/agents')}>View all agents</Button>}
        >
          <DataTable columns={COLUMNS} head={['Agent', 'Status', 'Owner', 'Model profile', 'MCPs', 'Last activity', 'Workload']}>
            {list.map(agent => (
              <DataRow key={agent.id} columns={COLUMNS} onClick={() => go(`/agents/${agent.id}`)}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{agent.displayName}</div>
                  <div style={{ fontSize: 12, fontFamily: MONO, color: C.faint }}>{agent.id}</div>
                </div>
                <div><LifecycleBadge lifecycle={agent.lifecycle} /></div>
                <Body>{agent.owner}</Body>
                <Body mono>{agent.modelProfile}</Body>
                <Body>{agent.mcpCount}</Body>
                {/* no run history reads as "never", never as a fabricated timestamp */}
                <Muted mono>{lastByAgent.get(agent.id) ? new Date(lastByAgent.get(agent.id) as string).toLocaleTimeString() : 'never'}</Muted>
                <Muted mono>{agent.workloadClientId.replace('sre-agent-', '')}</Muted>
              </DataRow>
            ))}
          </DataTable>
        </Panel>
      </AsyncState>
    </Page>
  );
}
