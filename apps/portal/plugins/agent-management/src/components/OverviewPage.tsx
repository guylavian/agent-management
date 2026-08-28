import { useAgents, useMcpServers, useRuns } from '../api/client';
import { AsyncState, Card, Cell, Grid, LifecycleBadge, PageShell, Row, StatTile, Table } from './common';

/** Overview dashboard (TDD §19). Every number is counted from real config or recorded runs. */
export function OverviewPage() {
  const agents = useAgents();
  const servers = useMcpServers();
  const runs = useRuns();

  const list = agents.value ?? [];
  const active = list.filter(agent => agent.lifecycle === 'active');
  const disabled = list.filter(agent => agent.lifecycle === 'disabled' || agent.lifecycle === 'removed');
  const other = list.filter(agent => !active.includes(agent) && !disabled.includes(agent));
  const lastByAgent = new Map<string, string>();
  for (const run of runs.value ?? []) {
    for (const agent of run.agents) if (!lastByAgent.has(agent)) lastByAgent.set(agent, run.startedAt);
  }

  return (
    <PageShell title="Overview" subtitle="SRE agent platform — management plane">
      <AsyncState loading={agents.loading} error={agents.error}>
        <Grid min={180}>
          <StatTile label="Total agents" value={list.length} />
          <StatTile label="Active" value={active.length} tone="ok" />
          <StatTile label="Draft / decommissioning" value={other.length} tone={other.length ? 'warn' : 'default'} />
          <StatTile label="Disabled" value={disabled.length} tone={disabled.length ? 'danger' : 'default'} />
          <StatTile label="Recorded runs" value={runs.error ? '—' : (runs.value?.length ?? 0)} />
          <StatTile label="MCP servers" value={servers.error ? '—' : (servers.value?.length ?? 0)} />
        </Grid>

        <Card title="Agent health">
          <Table head={['Agent', 'Status', 'Owner', 'Model profile', 'MCPs', 'Workload identity', 'Last activity']}>
            {list.map(agent => (
              <Row key={agent.id}>
                <Cell><strong>{agent.displayName}</strong></Cell>
                <Cell><LifecycleBadge lifecycle={agent.lifecycle} /></Cell>
                <Cell>{agent.owner}</Cell>
                <Cell>{agent.modelProfile}</Cell>
                <Cell>{agent.mcpCount}</Cell>
                <Cell>{agent.workloadClientId}</Cell>
                {/* no run history is shown as "never", never as a fabricated timestamp */}
                <Cell>{lastByAgent.get(agent.id) ?? 'never'}</Cell>
              </Row>
            ))}
          </Table>
        </Card>
      </AsyncState>
    </PageShell>
  );
}
