import { useMemo, useState } from 'react';
import { useAgents } from '../api/client';
import { AsyncState, Button, Card, Cell, Grid, inputStyle, LifecycleBadge, PageShell, Pill, Row, Table, palette } from './common';

/** Agents directory with search + filters and both table and card views (TDD §20). */
export function AgentsPage() {
  const { value, loading, error } = useAgents();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [team, setTeam] = useState('all');
  const [view, setView] = useState<'table' | 'card'>('table');

  const agents = value ?? [];
  const teams = useMemo(() => [...new Set(agents.map(agent => agent.owner))].sort(), [agents]);
  const filtered = agents.filter(agent => {
    const haystack = `${agent.id} ${agent.displayName} ${agent.owner} ${agent.modelProfile}`.toLowerCase();
    return (
      haystack.includes(query.toLowerCase()) &&
      (status === 'all' || agent.lifecycle === status) &&
      (team === 'all' || agent.owner === team)
    );
  });

  return (
    <PageShell
      title="Agents"
      subtitle={`${filtered.length} of ${agents.length} agents`}
      action={<Button onClick={() => { window.location.hash = '#/agent-management/create'; }}>+ Create Agent</Button>}
    >
      <AsyncState loading={loading} error={error}>
        <Card>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label="Search agents" placeholder="Search agents…" value={query} onChange={event => setQuery(event.target.value)} style={{ ...inputStyle, maxWidth: 280 }} />
            <select aria-label="Status filter" value={status} onChange={event => setStatus(event.target.value)} style={{ ...inputStyle, maxWidth: 170 }}>
              <option value="all">All statuses</option>
              {['active', 'draft', 'disabled', 'decommissioning', 'removed'].map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <select aria-label="Team filter" value={team} onChange={event => setTeam(event.target.value)} style={{ ...inputStyle, maxWidth: 200 }}>
              <option value="all">All teams</option>
              {teams.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <Button variant={view === 'table' ? 'primary' : 'ghost'} onClick={() => setView('table')}>Table</Button>
              <Button variant={view === 'card' ? 'primary' : 'ghost'} onClick={() => setView('card')}>Cards</Button>
            </div>
          </div>
        </Card>

        {view === 'table' ? (
          <Card>
            <Table head={['Agent', 'Owner', 'Status', 'Model', 'MCPs', 'Tools', 'Workload identity']}>
              {filtered.map(agent => (
                <Row key={agent.id}>
                  <Cell><a href={`#/agent-management/agents/${agent.id}`} style={{ color: palette.accent, fontWeight: 600, textDecoration: 'none' }}>{agent.displayName}</a></Cell>
                  <Cell>{agent.owner}</Cell>
                  <Cell><LifecycleBadge lifecycle={agent.lifecycle} /></Cell>
                  <Cell>{agent.modelProfile}</Cell>
                  <Cell>{agent.mcpCount}</Cell>
                  <Cell>{agent.toolCount}</Cell>
                  <Cell>{agent.workloadClientId}</Cell>
                </Row>
              ))}
            </Table>
          </Card>
        ) : (
          <Grid min={280}>
            {filtered.map(agent => (
              <Card key={agent.id} title={agent.displayName} action={<LifecycleBadge lifecycle={agent.lifecycle} />}>
                <p style={{ color: palette.muted, fontSize: 13, marginTop: 0 }}>{agent.owner}</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Pill tone="neutral">{agent.modelProfile}</Pill>
                  <Pill tone="neutral">{agent.mcpCount} MCPs</Pill>
                  <Pill tone="neutral">{agent.toolCount} tools</Pill>
                  {agent.readOnly && <Pill tone="ok">read-only</Pill>}
                </div>
                <p style={{ marginBottom: 0, marginTop: 14 }}>
                  <a href={`#/agent-management/agents/${agent.id}`} style={{ color: palette.accent, fontWeight: 600, textDecoration: 'none' }}>View details →</a>
                </p>
              </Card>
            ))}
          </Grid>
        )}
      </AsyncState>
    </PageShell>
  );
}
