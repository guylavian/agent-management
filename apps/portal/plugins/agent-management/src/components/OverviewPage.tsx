import { useAgents, useMcpServers, useRuns } from '../api/client';
import {
  AsyncState,
  Body,
  Button,
  C,
  DataRow,
  DataTable,
  LifecycleBadge,
  MonoAvatar,
  Muted,
  Page,
  PageHeader,
  Panel,
  StatCard,
  StatGrid,
  avatarColor,
  initials,
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
        subtitle="Control plane for the SRE platform's domain-specialist agents"
        action={<Button onClick={() => go('/create-agent')}>+ Create Agent</Button>}
      />
      <AsyncState loading={agents.loading} error={agents.error}>
        <StatGrid columns={6}>
          <StatCard label="Total Agents" value={list.length} sub={`across ${teams.size} team${teams.size === 1 ? '' : 's'}`} dot={C.accent} />
          <StatCard label="Active" value={active.length} sub="routable by the Manager" dot={C.greenBright} />
          <StatCard label="Draft / decommissioning" value={pending.length} sub={pending.map(a => a.id).join(', ') || 'none'} dot={C.amberBright} />
          <StatCard label="Disabled" value={disabled.length} sub="no workload token issued" dot={C.redBright} />
          <StatCard label="Recorded runs" value={runs.error ? '—' : (runs.value?.length ?? 0)} sub="current runtime process" dot={C.teal} />
          <StatCard label="MCP Servers" value={servers.error ? '—' : (servers.value?.length ?? 0)} sub="behind ToolHive" dot={C.dim} />
        </StatGrid>

        <Panel
          title="Agent health"
          padded={false}
          action={<Button variant="link" onClick={() => go('/agents')}>View all agents →</Button>}
        >
          <DataTable columns={COLUMNS} head={['AGENT', 'STATUS', 'OWNER', 'MODEL PROFILE', 'MCPS', 'LAST ACTIVITY', 'WORKLOAD']}>
            {list.map(agent => (
              <DataRow key={agent.id} columns={COLUMNS} onClick={() => go(`/agents/${agent.id}`)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                  <MonoAvatar label={initials(agent.id)} color={avatarColor(agent.id)} />
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{agent.displayName}</div>
                </div>
                <div><LifecycleBadge lifecycle={agent.lifecycle} /></div>
                <Body>{agent.owner}</Body>
                <Body mono>{agent.modelProfile}</Body>
                <Body>{agent.mcpCount}</Body>
                {/* no run history reads as "never", never as a fabricated timestamp */}
                <Muted>{lastByAgent.get(agent.id) ? new Date(lastByAgent.get(agent.id) as string).toLocaleTimeString() : 'never'}</Muted>
                <Muted mono>{agent.workloadClientId.replace('sre-agent-', '')}</Muted>
              </DataRow>
            ))}
          </DataTable>
        </Panel>
      </AsyncState>
    </Page>
  );
}
