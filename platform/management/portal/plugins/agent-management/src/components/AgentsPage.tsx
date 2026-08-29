import { useMemo, useState } from 'react';
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
  inputStyle,
  relativeTime,
  runStatusTone,
  selectStyle,
} from './common';
import type { AgentSummary, RunSummary } from '../api/types';

const TABLE_COLUMNS = '2.2fr .8fr 1fr 1fr .4fr .5fr .6fr 1.3fr';
const ACTIVITY_COLUMNS = '1.4fr .8fr 1.4fr 1.1fr .7fr';

/**
 * Agents directory (TDD §20).
 *
 * Cards are the primary view because the question this page usually answers is
 * "which agent do I want", not "compare column six across ten rows". The table
 * stays one click away for the second question, which is a real one — it is
 * the only view where MCP and tool counts line up for comparison.
 */
export function AgentsPage() {
  const { value, loading, error } = useAgents();
  const servers = useMcpServers();
  const runs = useRuns();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [team, setTeam] = useState('all');
  const [model, setModel] = useState('all');
  const [mcp, setMcp] = useState('all');
  const [view, setView] = useState<'cards' | 'table'>('cards');

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
        title="Agents"
        subtitle="Manage your SRE specialists, their access and their runtime configuration."
        action={<Button onClick={() => go('/create-agent')}>+ Create agent</Button>}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, flexWrap: 'wrap' }}>
        <input placeholder="Search agents…" value={query} onChange={event => setQuery(event.target.value)} style={{ ...inputStyle, width: 220 }} aria-label="Search agents" />
        <select value={status} onChange={event => setStatus(event.target.value)} style={selectStyle} aria-label="Status filter">
          <option value="all">Status: All</option>
          {['active', 'draft', 'disabled', 'decommissioning', 'removed'].map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={team} onChange={event => setTeam(event.target.value)} style={selectStyle} aria-label="Owner filter">
          <option value="all">Owner: All</option>
          {teams.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={model} onChange={event => setModel(event.target.value)} style={selectStyle} aria-label="Model filter">
          <option value="all">Model: All</option>
          {models.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={mcp} onChange={event => setMcp(event.target.value)} style={selectStyle} aria-label="MCP filter">
          <option value="all">MCP: All</option>
          {(servers.value ?? []).map(server => <option key={server.id} value={server.id}>{server.id}</option>)}
        </select>
      </div>

      <GroupHeader
        title="Specialist agents"
        icon="agents"
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: S.md }}>
            <Muted size={12.5}>{filtered.length} of {agents.length}</Muted>
            <Button variant="link" onClick={() => setView(view === 'cards' ? 'table' : 'cards')}>
              {view === 'cards' ? 'Table view' : 'Card view'}
            </Button>
          </div>
        }
      />

      <AsyncState loading={loading} error={error}>
        {view === 'cards' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: S.md }}>
            {filtered.map(agent => <AgentCard key={agent.id} agent={agent} onOpen={() => go(`/agents/${agent.id}`)} />)}
            {filtered.length === 0 && (
              <Card><Muted>No agents match these filters.</Muted></Card>
            )}
          </div>
        ) : (
          <Panel padded={false}>
            <DataTable columns={TABLE_COLUMNS} head={['Agent', 'Status', 'Owner', 'Model', 'MCPs', 'Tools', 'Access', 'Workload identity']}>
              {filtered.map(agent => (
                <DataRow key={agent.id} columns={TABLE_COLUMNS} onClick={() => go(`/agents/${agent.id}`)}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{agent.displayName}</div>
                    <div style={{ fontSize: 12, fontFamily: MONO, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.id}</div>
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
        )}
      </AsyncState>

      <Activity runs={runs.value} loading={runs.loading} error={runs.error} />
    </Page>
  );
}

/**
 * One agent, compact.
 *
 * There is no description here because `AgentSummary` does not carry one — the
 * list endpoint returns eleven fields and a description is not among them.
 * Showing the model profile and the read-only posture instead is real; inventing
 * a sentence, or fetching every agent's detail to find one, is not.
 */
function AgentCard({ agent, onOpen }: { agent: AgentSummary; onOpen: () => void }) {
  return (
    <Card onClick={onOpen}>
      {/* a column so the footer sits on the baseline of every card in the row,
          however many lines the agent's name took */}
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/*
        * The name and the id both WRAP rather than ellipsis. They are how an
        * agent is identified and how it is grepped for; a card that renders
        * "network-observabil…" has failed at the one job the card has.
        */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: S.md }}>
        <AgentTile id={agent.id} owner={agent.owner} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{agent.displayName}</div>
          <div style={{ fontSize: 12, fontFamily: MONO, color: C.faint, wordBreak: 'break-word', marginTop: 2 }}>{agent.id}</div>
        </div>
        <LifecycleBadge lifecycle={agent.lifecycle} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: S.md, flexWrap: 'wrap', color: C.muted, fontSize: 12.5, marginTop: S.md, marginBottom: S.md }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="mcp" size={14} /> {agent.mcpCount} MCP{agent.mcpCount === 1 ? '' : 's'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="tool" size={14} /> {agent.toolCount} tool{agent.toolCount === 1 ? '' : 's'}
        </span>
        {agent.readOnly && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="security" size={14} /> read-only
          </span>
        )}
      </div>

      <div style={{ marginTop: 'auto', paddingTop: S.md, borderTop: `1px solid ${C.ruleSoft}`, display: 'flex', gap: S.sm, alignItems: 'center', justifyContent: 'space-between' }}>
        <Muted size={12}>{agent.owner}</Muted>
        <Muted size={12} mono>{agent.modelProfile}</Muted>
      </div>
      </div>
    </Card>
  );
}

/**
 * Recent activity, from the runs the runtime has actually recorded.
 *
 * "Triggered by" is a HASH. The runtime hashes the subject before it leaves the
 * process, so a name is not available to this console and could only be
 * fabricated. The column is labelled for what it holds rather than dropped,
 * because "which distinct person" is still a question the hash answers.
 *
 * There is no configuration-change feed: no endpoint records one. An empty
 * "Changes" panel would imply nothing had changed, so there is not one.
 */
function Activity({ runs, loading, error }: { runs?: RunSummary[]; loading: boolean; error?: Error }) {
  const recent = (runs ?? []).slice(0, 8);
  return (
    <>
      <GroupHeader title="Activity" icon="activity" />
      <Panel padded={false}>
        <AsyncState loading={loading} error={error}>
          {recent.length === 0 ? (
            <EmptyState>No runs have been recorded by this runtime process yet.</EmptyState>
          ) : (
            <DataTable columns={ACTIVITY_COLUMNS} head={['Agent', 'Event', 'Details', 'Triggered by', 'When']}>
              {recent.map(run => (
                <DataRow key={run.requestId} columns={ACTIVITY_COLUMNS} onClick={() => { window.location.href = `/runs/${run.requestId}`; }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, minWidth: 0 }}>
                    {run.agents[0] && <AgentTile id={run.agents[0]} owner={run.agents[0]} size={24} />}
                    <Body>{run.agents.join(', ') || '—'}</Body>
                  </div>
                  <StatusPill tone={runStatusTone(run.status)}>{run.status}</StatusPill>
                  <Muted size={12.5}>{run.toolCalls} tool call{run.toolCalls === 1 ? '' : 's'}, {run.evidenceCount} evidence, {run.durationMs} ms</Muted>
                  <Muted size={12} mono>{run.userSubjectHash.slice(0, 12)}</Muted>
                  <Muted size={12.5}>{relativeTime(run.startedAt)}</Muted>
                </DataRow>
              ))}
            </DataTable>
          )}
        </AsyncState>
      </Panel>
    </>
  );
}
