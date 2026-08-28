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
  MonoAvatar,
  Muted,
  Page,
  PageHeader,
  Panel,
  SegmentedControl,
  StatusPill,
  avatarColor,
  initials,
  inputStyle,
  selectStyle,
} from './common';

const COLUMNS = '2.6fr .9fr 1.1fr 1.1fr .5fr .7fr .9fr';

/** Agents directory with search + filters and both table and card views (TDD §20). */
export function AgentsPage() {
  const { value, loading, error } = useAgents();
  const servers = useMcpServers();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [team, setTeam] = useState('all');
  const [model, setModel] = useState('all');
  const [mcp, setMcp] = useState('all');
  const [view, setView] = useState('Table');

  const agents = value ?? [];
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
        subtitle={`${agents.length} domain specialist${agents.length === 1 ? '' : 's'} · routed by the Manager`}
        action={<Button onClick={() => go('/create-agent')}>+ Create Agent</Button>}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <input placeholder="Search agents…" value={query} onChange={event => setQuery(event.target.value)} style={{ ...inputStyle, width: 230 }} aria-label="Search agents" />
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
        <div style={{ flex: 1 }} />
        <SegmentedControl options={['Table', 'Cards']} value={view} onChange={setView} />
      </div>

      <AsyncState loading={loading} error={error}>
        {view === 'Table' ? (
          <Panel padded={false}>
            <DataTable columns={COLUMNS} head={['AGENT', 'STATUS', 'OWNER', 'MODEL', 'MCPS', 'TOOLS', 'WORKLOAD IDENTITY']}>
              {filtered.map(agent => (
                <DataRow key={agent.id} columns={COLUMNS} onClick={() => go(`/agents/${agent.id}`)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                    <MonoAvatar label={initials(agent.id)} color={avatarColor(agent.id)} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>{agent.displayName}</div>
                      <div style={{ fontSize: 12, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {agent.mcpCount} MCP{agent.mcpCount === 1 ? '' : 's'} · {agent.toolCount} read-only tools
                      </div>
                    </div>
                  </div>
                  <div><LifecycleBadge lifecycle={agent.lifecycle} /></div>
                  <Body>{agent.owner}</Body>
                  <Body mono>{agent.modelProfile}</Body>
                  <Body>{agent.mcpCount}</Body>
                  <Body>{agent.toolCount}</Body>
                  <Muted mono>{agent.workloadClientId}</Muted>
                </DataRow>
              ))}
              {filtered.length === 0 && <EmptyState>No agents match these filters.</EmptyState>}
            </DataTable>
          </Panel>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(290px,1fr))', gap: 14 }}>
            {filtered.map(agent => (
              <div
                key={agent.id}
                onClick={() => go(`/agents/${agent.id}`)}
                style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12 }}>
                  <MonoAvatar label={initials(agent.id)} color={avatarColor(agent.id)} size={38} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{agent.displayName}</div>
                    <div style={{ fontSize: 12, color: C.faint }}>{agent.owner}</div>
                  </div>
                  <LifecycleBadge lifecycle={agent.lifecycle} />
                </div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 12 }}>
                  <StatusPill tone="info" dot={false}>{agent.modelProfile}</StatusPill>
                  <StatusPill tone="neutral" dot={false}>{agent.mcpCount} MCPs</StatusPill>
                  <StatusPill tone="neutral" dot={false}>{agent.toolCount} tools</StatusPill>
                  {agent.readOnly && <StatusPill tone="ok" dot={false}>read-only</StatusPill>}
                </div>
                <div style={{ fontSize: 12, color: C.muted, fontFamily: 'ui-monospace,Menlo,monospace' }}>{agent.workloadClientId}</div>
              </div>
            ))}
          </div>
        )}
      </AsyncState>
    </Page>
  );
}
