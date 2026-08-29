import { useMemo, useState } from 'react';
import { useAgents, useMcpServers } from '../api/client';
import {
  AsyncState,
  Body,
  Button,
  C,
  DataRow,
  DataTable,
  EmptyState,
  LifecycleBadge,
  Muted,
  Page,
  PageHeader,
  Panel,
  S,
  inputStyle,
  selectStyle,
} from './common';

const COLUMNS = '2.2fr .8fr 1fr 1fr .4fr .5fr .6fr 1.3fr';

/**
 * Agents directory (TDD §20).
 *
 * One table, no card view. The cards showed the same eight fields in a third
 * of the density and could not be compared down a column, which is the reason
 * to open this screen at all. `read-only` was the one field cards had that the
 * table did not; it is now a column, so nothing was lost with them.
 */
export function AgentsPage() {
  const { value, loading, error } = useAgents();
  const servers = useMcpServers();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [team, setTeam] = useState('all');
  const [model, setModel] = useState('all');
  const [mcp, setMcp] = useState('all');

  const agents = useMemo(() => value ?? [], [value]);
  const teams = useMemo(() => [...new Set(agents.map(agent => agent.owner))].sort(), [agents]);
  const models = useMemo(() => [...new Set(agents.map(agent => agent.modelProfile))].sort(), [agents]);
  const mcpAgents = useMemo(() => new Map((servers.value ?? []).map(server => [server.id, new Set(server.agents)])), [servers.value]);

  const filtered = agents.filter(agent => {
    const haystack = `${agent.id} ${agent.displayName} ${agent.owner} ${agent.modelProfile}`.toLowerCase();
    return (
      haystack.includes(query.toLowerCase()) &&
      (status === 'all' || agent.lifecycle === status) &&
      (team === 'all' || agent.owner === team) &&
      (model === 'all' || agent.modelProfile === model) &&
      (mcp === 'all' || mcpAgents.get(mcp)?.has(agent.id) === true)
    );
  });

  const go = (path: string) => { window.location.href = path; };

  return (
    <Page>
      <PageHeader
        tight
        title="Agents"
        subtitle={`${agents.length} domain specialist${agents.length === 1 ? '' : 's'}, routed by the Manager`}
        action={<Button onClick={() => go('/create-agent')}>Create agent</Button>}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, marginBottom: S.md, flexWrap: 'wrap' }}>
        <input placeholder="Search agents…" value={query} onChange={event => setQuery(event.target.value)} style={{ ...inputStyle, width: 220 }} aria-label="Search agents" />
        <select value={status} onChange={event => setStatus(event.target.value)} style={selectStyle} aria-label="Status filter">
          <option value="all">Status: All</option>
          {['active', 'draft', 'disabled', 'decommissioning', 'removed'].map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={team} onChange={event => setTeam(event.target.value)} style={selectStyle} aria-label="Team filter">
          <option value="all">Team: All</option>
          {teams.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={model} onChange={event => setModel(event.target.value)} style={selectStyle} aria-label="Model filter">
          <option value="all">Model: All</option>
          {models.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={mcp} onChange={event => setMcp(event.target.value)} style={selectStyle} aria-label="MCP filter">
          <option value="all">MCP Server: All</option>
          {(servers.value ?? []).map(server => <option key={server.id} value={server.id}>{server.id}</option>)}
        </select>
      </div>

      <AsyncState loading={loading} error={error}>
        <Panel padded={false}>
          <DataTable columns={COLUMNS} head={['Agent', 'Status', 'Owner', 'Model', 'MCPs', 'Tools', 'Access', 'Workload identity']}>
            {filtered.map(agent => (
              <DataRow key={agent.id} columns={COLUMNS} onClick={() => go(`/agents/${agent.id}`)}>
                {/* display name over technical id: the id is what an operator
                    greps for, the display name is what they recognise */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{agent.displayName}</div>
                  <div style={{ fontSize: 12, fontFamily: 'ui-monospace,Menlo,monospace', color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {agent.id}
                  </div>
                </div>
                <div><LifecycleBadge lifecycle={agent.lifecycle} /></div>
                <Body>{agent.owner}</Body>
                <Body mono>{agent.modelProfile}</Body>
                <Body>{agent.mcpCount}</Body>
                <Body>{agent.toolCount}</Body>
                <Body>{agent.readOnly ? 'read-only' : 'read-write'}</Body>
                <Muted mono>{agent.workloadClientId}</Muted>
              </DataRow>
            ))}
            {filtered.length === 0 && <EmptyState>No agents match these filters.</EmptyState>}
          </DataTable>
        </Panel>
      </AsyncState>
    </Page>
  );
}
