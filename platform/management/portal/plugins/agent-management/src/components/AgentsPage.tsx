import { useMemo, useState } from 'react';
import { useAgents, useMcpServers, useRuns } from '../api/client';
import {
  AGENT_GRID,
  AgentGridCard,
  AgentTile,
  AsyncState,
  Body,
  ReconciliationBadge,
  Button,
  C,
  DataRow,
  DataTable,
  EmptyState,
  GroupHeader,
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
import type { RunSummary } from '../api/types';

const TABLE_COLUMNS = '2fr .9fr .8fr .9fr .9fr .4fr .5fr 1.2fr';
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
  const { value, loading, error, refreshError } = useAgents();
  const servers = useMcpServers();
  const runs = useRuns();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [team, setTeam] = useState('all');
  const [model, setModel] = useState('all');
  const [mcp, setMcp] = useState('all');
  const [view, setView] = useState<'cards' | 'table'>('cards');

  const agents = useMemo(() => value?.agents ?? [], [value]);
  const configError = value?.configError;
  const proposalsError = value?.proposalsError;
  const teams = useMemo(() => [...new Set(agents.map(agent => agent.owner))].sort(), [agents]);
  const models = useMemo(() => [...new Set(agents.map(agent => agent.modelProfile))].sort(), [agents]);
  const mcpAgents = useMemo(() => new Map((servers.value ?? []).map(server => [server.id, new Set(server.agents)])), [servers.value]);

  const filtered = agents.filter(agent => {
    const haystack = `${agent.id} ${agent.displayName} ${agent.owner} ${agent.modelProfile}`.toLowerCase();
    return (
      haystack.includes(query.toLowerCase()) &&
      (status === 'all' || agent.reconciliation?.status === status) &&
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

      {refreshError !== undefined && (
        <div style={{ marginBottom: 12 }}>
          {/* the table below is the last successful refresh; saying so is the
              difference between stale data and data presented as current */}
          <StatusPill tone="warn">Last refresh failed — showing the previous result</StatusPill>
        </div>
      )}

      {proposalsError !== undefined && (
        <div style={{ marginBottom: 12 }}>
          {/* merged Agents are all present; only the not-yet-merged ones are
              missing, and saying which is missing beats a silent short list */}
          <StatusPill tone="warn">Open pull requests could not be listed, so Agents still awaiting merge are not shown</StatusPill>
        </div>
      )}

      {configError !== undefined && (
        <div style={{ marginBottom: 20 }}><Panel>
          {/* the agents below are the last desired state that loaded; saying so
              is the difference between a stale page and a page that lies */}
          <StatusPill tone="danger">Configuration error</StatusPill>
          <div style={{ marginTop: 6, fontSize: 12.5, color: C.bodySoft }}>
            The most recent configuration change did not load, so this page shows the last valid desired state: {configError}
          </div>
        </Panel></div>
      )}

      <Panel>
      <div style={{ display: 'flex', alignItems: 'center', gap: S.md, flexWrap: 'wrap' }}>
        <input placeholder="Search agents…" value={query} onChange={event => setQuery(event.target.value)} style={{ ...inputStyle, width: 220 }} aria-label="Search agents" />
        <select value={status} onChange={event => setStatus(event.target.value)} style={selectStyle} aria-label="Status filter">
          <option value="all">Status: All</option>
          {/* the MANAGED status, not the document's lifecycle: "why can I not use
              this agent" is answered by reconciliation, not by a YAML field */}
          {['active', 'reconciling', 'degraded', 'failed', 'pending-merge', 'draft', 'disabled'].map(item => <option key={item} value={item}>{item}</option>)}
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
        <div style={{ flex: 1 }} />
        <Button variant="link" onClick={() => { setQuery(''); setStatus('all'); setTeam('all'); setModel('all'); setMcp('all'); }}>Clear</Button>
      </div>
      </Panel>

      <div style={{ marginTop: 20 }}><Panel>
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
          <>
          <div style={AGENT_GRID}>
            {filtered.map(agent => (
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
                {...(agent.reconciliation === undefined ? {} : { reconciliation: agent.reconciliation })}
                {...(agent.avatar === undefined ? {} : { avatar: agent.avatar })}
                onOpen={() => go(`/agents/${agent.id}`)}
              />
            ))}
          </div>
          {filtered.length === 0 && <EmptyState>No agents match these filters.</EmptyState>}
          </>
        ) : (
          <div style={{ margin: '0 -20px -20px -20px' }}>
            <DataTable columns={TABLE_COLUMNS} head={['Agent', 'Status', 'Argo', 'Runtime', 'Routing', 'MCPs', 'Tools', 'Owner']}>
              {filtered.map(agent => (
                <DataRow key={agent.id} columns={TABLE_COLUMNS} onClick={() => go(`/agents/${agent.id}`)}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{agent.displayName}</div>
                    <div style={{ fontSize: 12, fontFamily: MONO, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.id}</div>
                  </div>
                  <div><ReconciliationBadge {...(agent.reconciliation === undefined ? {} : { reconciliation: agent.reconciliation })} /></div>
                  {/* the three signals that answer "why is it not Active" get
                      their own columns; the detail sentence is one click away */}
                  <span title={agent.reconciliation?.argo.detail}><Muted size={12.5}>{agent.reconciliation?.argo.state ?? 'unknown'}</Muted></span>
                  <span title={agent.reconciliation?.runtime.detail}><Muted size={12.5}>{agent.reconciliation?.runtime.state ?? 'unknown'}</Muted></span>
                  <span title={agent.reconciliation?.manager.detail}><Muted size={12.5}>{agent.reconciliation?.manager.state === 'ok' ? 'routable' : 'not routable'}</Muted></span>
                  <Body>{agent.mcpCount}</Body>
                  <Body>{agent.toolCount}</Body>
                  <Body>{agent.owner}</Body>
                </DataRow>
              ))}
              {filtered.length === 0 && <EmptyState>No agents match these filters.</EmptyState>}
            </DataTable>
          </div>
        )}
      </AsyncState>
      </Panel></div>

      <div style={{ marginTop: 20 }}>
        <Activity runs={runs.value} loading={runs.loading} error={runs.error} />
      </div>
    </Page>
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
    <Panel>
      <GroupHeader title="Activity" action={<Button variant="link" onClick={() => { window.location.href = '/runs'; }}>View all activity</Button>} />
        <AsyncState loading={loading} error={error}>
          {recent.length === 0 ? (
            <div style={{ padding: '4px 0 2px 0', color: C.muted, fontSize: 13 }}>No runs have been recorded by this runtime process yet.</div>
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
  );
}
