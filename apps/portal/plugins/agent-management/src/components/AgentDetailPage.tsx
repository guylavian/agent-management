import { useState } from 'react';
import { useAgent, useAgentHealth, useAgentMetrics, useRuns } from '../api/client';
import {
  Allowed,
  AsyncState,
  Card,
  Cell,
  ClassificationBadge,
  Grid,
  KeyValue,
  LifecycleBadge,
  Mono,
  PageShell,
  Pill,
  Row,
  StatTile,
  Table,
  palette,
} from './common';
import type { AgentDetail, McpAccessView } from '../api/types';

const TABS = ['Overview', 'Prompt', 'Tools', 'Identity & Access', 'Permissions', 'Runs', 'Evaluations', 'Deployment'] as const;
type Tab = (typeof TABS)[number];

/** Agent detail (TDD §21/§22). */
export function AgentDetailPage({ agentId }: { agentId: string }) {
  const { value, loading, error } = useAgent(agentId);
  const [tab, setTab] = useState<Tab>('Overview');

  return (
    <PageShell title={value?.displayName ?? agentId} subtitle={value ? `${value.owner} · ${value.workloadClientId}` : undefined} action={value ? <LifecycleBadge lifecycle={value.lifecycle} /> : undefined}>
      <AsyncState loading={loading} error={error}>
        {value && (
          <>
            <nav style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: `1px solid ${palette.border}`, paddingBottom: 10 }}>
              {TABS.map(name => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setTab(name)}
                  style={{
                    border: 'none',
                    background: tab === name ? palette.accent : 'transparent',
                    color: tab === name ? '#fff' : palette.muted,
                    borderRadius: 9,
                    padding: '7px 13px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {name}
                </button>
              ))}
            </nav>
            {tab === 'Overview' && <OverviewTab agent={value} />}
            {tab === 'Prompt' && <PromptTab agent={value} />}
            {tab === 'Tools' && <ToolsTab agent={value} />}
            {tab === 'Identity & Access' && <IdentityTab agent={value} />}
            {tab === 'Permissions' && <PermissionsTab agent={value} />}
            {tab === 'Runs' && <RunsTab agentId={agentId} />}
            {tab === 'Evaluations' && <Card title="Evaluations"><p style={{ color: palette.muted, margin: 0 }}>No evaluation backend is wired to this deployment.</p></Card>}
            {tab === 'Deployment' && <DeploymentTab agent={value} />}
          </>
        )}
      </AsyncState>
    </PageShell>
  );
}

function OverviewTab({ agent }: { agent: AgentDetail }) {
  const health = useAgentHealth(agent.id);
  const metrics = useAgentMetrics(agent.id);
  const notConfigured = (metrics.value as { status?: string } | undefined)?.status === 'not-configured';
  return (
    <>
      <Grid min={200}>
        <StatTile label="Lifecycle" value={agent.lifecycle} tone={agent.enabled ? 'ok' : 'danger'} />
        <StatTile label="Reachability" value={String((health.value as { reachability?: string } | undefined)?.reachability ?? '—')} />
        <StatTile label="Requests" value={notConfigured ? 'not configured' : String((metrics.value as { requestCount?: number } | undefined)?.requestCount ?? '—')} />
        <StatTile label="p95 latency" value={notConfigured ? 'not configured' : `${(metrics.value as { p95LatencyMs?: number } | undefined)?.p95LatencyMs ?? '—'} ms`} />
      </Grid>
      <Grid min={320}>
        <Card title="Model">
          {/* profile, resolved model and provider are shown separately: an agent is never bound to one model */}
          <KeyValue
            items={[
              ['Model profile', agent.modelProfile],
              ['Tier', agent.modelTier],
              ['Resolved model', <Pill tone="neutral" key="rm">resolved at runtime</Pill>],
              ['Provider', <Pill tone="neutral" key="pv">configured per environment</Pill>],
            ]}
          />
        </Card>
        <Card title="Routing & authorization">
          <KeyValue
            items={[
              ['Owner', agent.owner],
              ['Required human roles', agent.requiredRoles.join(', ')],
              ['Cross-domain', agent.crossDomainAllowed.length ? agent.crossDomainAllowed.join(', ') : 'none'],
              ['Read-only enforced', <Allowed value={agent.readOnly} key="ro" />],
            ]}
          />
        </Card>
        <Card title="Connected MCPs">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {agent.access.filter(entry => entry.allowed).map(entry => <Pill tone="ok" key={entry.mcp}>{entry.mcp}</Pill>)}
          </div>
        </Card>
        <Card title="Runtime limits">
          <KeyValue items={Object.entries(agent.limits).map(([key, val]) => [key, String(val)] as [string, string])} />
        </Card>
      </Grid>
    </>
  );
}

function PromptTab({ agent }: { agent: AgentDetail }) {
  return (
    <Card title="System prompt">
      <KeyValue items={[['Source file', <Mono key="f">{agent.promptFile}</Mono>]]} />
      <p style={{ color: palette.muted, fontSize: 13, marginBottom: 0 }}>
        The prompt is versioned in Git and changed through a pull request. Its contents are served by the runtime, not stored in the portal.
      </p>
    </Card>
  );
}

function ToolsTab({ agent }: { agent: AgentDetail }) {
  return (
    <>
      {agent.access.filter(entry => entry.allowed).map(entry => (
        <Card key={entry.mcp} title={`${entry.mcp} MCP`} action={<Pill tone="neutral">{entry.audience}</Pill>}>
          <Table head={['Tool', 'Access', 'Keycloak role']}>
            {entry.allowedTools.map(tool => (
              <Row key={tool.name}>
                <Cell><Mono>{tool.name}</Mono></Cell>
                <Cell><ClassificationBadge classification={tool.classification} /></Cell>
                <Cell><Mono>{tool.role ?? '—'}</Mono></Cell>
              </Row>
            ))}
          </Table>
          {entry.blockedTools.length > 0 && (
            <p style={{ color: palette.muted, fontSize: 13, marginBottom: 0, marginTop: 12 }}>
              Blocked on this MCP: {entry.blockedTools.map(tool => tool.name).join(', ')}
            </p>
          )}
        </Card>
      ))}
    </>
  );
}

/** Identity & Access — first-class, showing denied MCPs explicitly (TDD §22). */
function IdentityTab({ agent }: { agent: AgentDetail }) {
  return (
    <>
      <Card title="Workload identity">
        <KeyValue
          items={[
            ['Provider', agent.identity.provider],
            ['Client ID', <Mono key="c">{agent.identity.clientId}</Mono>],
            ['Status', <LifecycleBadge lifecycle={agent.lifecycle} key="s" />],
            ['Authentication', agent.identity.authentication],
            ['Token policy', agent.identity.tokenPolicy],
          ]}
        />
      </Card>
      <Card title="MCP access">
        {agent.access.map(entry => <McpAccessBlock key={entry.mcp} entry={entry} />)}
      </Card>
    </>
  );
}

function McpAccessBlock({ entry }: { entry: McpAccessView }) {
  return (
    <div style={{ borderTop: `1px solid ${palette.border}`, padding: '14px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <strong style={{ fontSize: 14 }}>{entry.mcp} MCP</strong>
        <Allowed value={entry.allowed} />
        {entry.audience && <Pill tone="neutral">aud: {entry.audience}</Pill>}
      </div>
      {entry.allowed ? (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, color: palette.text, fontSize: 13.5 }}>
          {entry.allowedTools.map(tool => <li key={tool.name}>✓ {tool.name}</li>)}
          {entry.blockedTools.map(tool => <li key={tool.name} style={{ color: palette.muted }}>✕ {tool.name}</li>)}
        </ul>
      ) : (
        <p style={{ color: palette.muted, fontSize: 13, margin: '8px 0 0' }}>No access. No audience is issued for this MCP.</p>
      )}
    </div>
  );
}

function PermissionsTab({ agent }: { agent: AgentDetail }) {
  return (
    <Card title="Effective permissions">
      <Table head={['MCP', 'Allowed', 'Audience', 'Allowed tools', 'Blocked tools']}>
        {agent.access.map(entry => (
          <Row key={entry.mcp}>
            <Cell>{entry.mcp}</Cell>
            <Cell><Allowed value={entry.allowed} /></Cell>
            <Cell>{entry.audience ? <Mono>{entry.audience}</Mono> : '—'}</Cell>
            <Cell>{entry.allowedTools.length}</Cell>
            <Cell>{entry.blockedTools.length}</Cell>
          </Row>
        ))}
      </Table>
      <p style={{ color: palette.muted, fontSize: 13, marginBottom: 0, marginTop: 12 }}>
        Enforced by the runtime on every tool call. This view reflects policy; it does not grant it.
      </p>
    </Card>
  );
}

function RunsTab({ agentId }: { agentId: string }) {
  const { value, loading, error } = useRuns();
  const runs = (value ?? []).filter(run => run.agents.includes(agentId));
  return (
    <AsyncState loading={loading} error={error}>
      <Card title="Recent runs">
        {runs.length === 0 ? (
          <p style={{ color: palette.muted, margin: 0 }}>No runs recorded for this agent in the current runtime process.</p>
        ) : (
          <Table head={['Time', 'Status', 'Agents', 'Tools', 'Evidence', 'Duration']}>
            {runs.map(run => (
              <Row key={run.requestId}>
                <Cell><a href={`#/agent-management/runs/${run.requestId}`} style={{ color: palette.accent, textDecoration: 'none' }}>{run.startedAt}</a></Cell>
                <Cell>{run.status}</Cell>
                <Cell>{run.agents.join(', ')}</Cell>
                <Cell>{run.toolCalls}</Cell>
                <Cell>{run.evidenceCount}</Cell>
                <Cell>{run.durationMs} ms</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </AsyncState>
  );
}

function DeploymentTab({ agent }: { agent: AgentDetail }) {
  return (
    <Card title="Deployment">
      <KeyValue
        items={[
          ['Configuration source', <Mono key="s">agents/{agent.id}.yaml</Mono>],
          ['Change process', 'pull request → review → merge → Argo CD sync'],
          ['Workload client', <Mono key="w">{agent.identity.clientId}</Mono>],
        ]}
      />
      <p style={{ color: palette.muted, fontSize: 13, marginBottom: 0 }}>
        Git is the source of truth. The portal proposes changes; it never deploys to production directly.
      </p>
    </Card>
  );
}
