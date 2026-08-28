import { useState } from 'react';
import { useAgent, useAgentHealth, useAgentMetrics, useRuns } from '../api/client';
import {
  Allowed,
  AsyncState,
  Body,
  Breadcrumb,
  Button,
  C,
  Chip,
  DataRow,
  DataTable,
  DefinitionList,
  EmptyState,
  LifecycleBadge,
  ModeBadge,
  Mono,
  MonoAvatar,
  Muted,
  Page,
  Panel,
  SectionTitle,
  StatCard,
  StatGrid,
  StatusPill,
  Tabs,
  Toggle,
  avatarColor,
  initials,
  lifecycleTone,
} from './common';
import type { AgentDetail, McpAccessView } from '../api/types';

const TABS = ['Overview', 'Prompt', 'Tools', 'Identity & Access', 'Permissions', 'Runs', 'Evaluations', 'Deployment'] as const;

/** Agent detail (TDD §21/§22). */
export function AgentDetailPage({ agentId }: { agentId: string }) {
  const { value, loading, error } = useAgent(agentId);
  const [tab, setTab] = useState<string>('Overview');

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Agents', onClick: () => { window.location.href = '/agents'; } }, { label: value?.displayName ?? agentId }]} />
      <AsyncState loading={loading} error={error}>
        {value && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
              <MonoAvatar label={initials(value.id)} color={avatarColor(value.id)} size={44} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.3px' }}>{value.displayName}</div>
                  <StatusPill tone={lifecycleTone(value.lifecycle)}>{value.lifecycle}</StatusPill>
                  <Chip mono>{value.modelProfile}</Chip>
                </div>
                <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>Owner: {value.owner} · workload {value.identity.clientId}</div>
              </div>
              {/* reflects lifecycle; changing it is a pull request, not a click */}
              <Toggle on={value.enabled} label={value.enabled ? 'Enabled' : 'Disabled'} />
              <Button variant="secondary" onClick={() => { window.location.href = '/create-agent'; }}>Edit</Button>
            </div>

            <Tabs tabs={TABS} active={tab} onChange={setTab} />

            {tab === 'Overview' && <OverviewTab agent={value} />}
            {tab === 'Prompt' && <PromptTab agent={value} />}
            {tab === 'Tools' && <ToolsTab agent={value} />}
            {tab === 'Identity & Access' && <IdentityTab agent={value} />}
            {tab === 'Permissions' && <PermissionsTab agent={value} />}
            {tab === 'Runs' && <RunsTab agentId={agentId} />}
            {tab === 'Evaluations' && (
              <Panel title="Evaluations">
                <Muted>No evaluation backend is wired to this deployment.</Muted>
              </Panel>
            )}
            {tab === 'Deployment' && <DeploymentTab agent={value} />}
          </>
        )}
      </AsyncState>
    </Page>
  );
}

function OverviewTab({ agent }: { agent: AgentDetail }) {
  const health = useAgentHealth(agent.id);
  const metrics = useAgentMetrics(agent.id);
  const notConfigured = (metrics.value as { status?: string } | undefined)?.status === 'not-configured';
  const requestCount = (metrics.value as { requestCount?: number } | undefined)?.requestCount;
  const successRate = (metrics.value as { successRate?: number } | undefined)?.successRate;
  const p95 = (metrics.value as { p95LatencyMs?: number } | undefined)?.p95LatencyMs;

  return (
    <>
      <StatGrid columns={4}>
        <StatCard label="Lifecycle" value={agent.lifecycle} sub={agent.enabled ? 'routable and can obtain tokens' : 'no workload token issued'} />
        <StatCard label="Reachability" value={String((health.value as { reachability?: string } | undefined)?.reachability ?? '—')} sub="no health probe configured" />
        <StatCard label="Requests" value={notConfigured ? 'n/a' : String(requestCount ?? '—')} sub={notConfigured ? 'no runs recorded' : 'this runtime process'} />
        <StatCard
          label="Success rate"
          value={notConfigured || successRate === undefined ? 'n/a' : `${Math.round(successRate * 100)}%`}
          sub={notConfigured ? 'no runs recorded' : `p95 ${p95 ?? '—'} ms`}
        />
      </StatGrid>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel>
            <SectionTitle>Model</SectionTitle>
            {/* profile, resolved model and provider are separate: an agent is never bound to one model */}
            <DefinitionList
              items={[
                ['Model profile', <Mono key="p">{agent.modelProfile}</Mono>],
                ['Tier', agent.modelTier],
                ['Resolved model', <Muted key="r">resolved by the runtime for this environment</Muted>],
                ['Provider', <Muted key="v">configured per environment — no cloud coupling</Muted>],
              ]}
            />
          </Panel>
          <Panel>
            <SectionTitle>Connected MCPs</SectionTitle>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {agent.access.filter(entry => entry.allowed).map(entry => (
                <StatusPill tone="ok" key={entry.mcp}>{entry.mcp}</StatusPill>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <SectionTitle>Cross-domain access</SectionTitle>
              {agent.crossDomainAllowed.length === 0 ? (
                <Muted>None. This agent cannot escalate to another domain.</Muted>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {agent.crossDomainAllowed.map(domain => <Chip key={domain}>{domain}</Chip>)}
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                <Muted size={12}>Escalation always returns through the Manager; specialists never call each other.</Muted>
              </div>
            </div>
          </Panel>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel>
            <SectionTitle>Authorization</SectionTitle>
            <DefinitionList
              items={[
                ['Owner', agent.owner],
                ['Human roles', agent.requiredRoles.join(', ')],
                ['Read-only', <Allowed value={agent.readOnly} key="ro" />],
              ]}
            />
          </Panel>
          <Panel>
            <SectionTitle>Runtime limits</SectionTitle>
            <DefinitionList items={Object.entries(agent.limits).map(([key, val]) => [key, <Mono key={key}>{String(val)}</Mono>] as [string, React.ReactNode])} />
          </Panel>
        </div>
      </div>
    </>
  );
}

function PromptTab({ agent }: { agent: AgentDetail }) {
  return (
    <Panel title="System prompt">
      <DefinitionList items={[['Source file', <Mono key="f">{agent.promptFile}</Mono>]]} />
      <div style={{ marginTop: 12 }}>
        <Muted>The prompt is versioned in Git and changed through a pull request. Its contents are served by the runtime, not stored in the portal.</Muted>
      </div>
    </Panel>
  );
}

const TOOL_COLUMNS = '2fr .6fr 1.6fr';

function ToolsTab({ agent }: { agent: AgentDetail }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {agent.access.filter(entry => entry.allowed).map(entry => (
        <Panel key={entry.mcp} padded={false} title={`${entry.mcp} MCP`} action={<Chip mono>{entry.audience}</Chip>}>
          <DataTable columns={TOOL_COLUMNS} head={['TOOL', 'ACCESS', 'KEYCLOAK ROLE']}>
            {entry.allowedTools.map(tool => (
              <DataRow key={tool.name} columns={TOOL_COLUMNS}>
                <Body mono>{tool.name}</Body>
                <div><ModeBadge classification={tool.classification} /></div>
                <Muted mono>{tool.role ?? '—'}</Muted>
              </DataRow>
            ))}
            {entry.blockedTools.length > 0 && (
              <div style={{ padding: '12px 18px' }}>
                <Muted size={12}>Blocked on this MCP: {entry.blockedTools.map(tool => tool.name).join(', ')}</Muted>
              </div>
            )}
          </DataTable>
        </Panel>
      ))}
    </div>
  );
}

/** Identity & Access — first-class, showing denied MCPs explicitly (TDD §22). */
function IdentityTab({ agent }: { agent: AgentDetail }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Panel title="Workload identity">
        <DefinitionList
          items={[
            ['Provider', agent.identity.provider],
            ['Client ID', <Mono key="c">{agent.identity.clientId}</Mono>],
            ['Status', <LifecycleBadge lifecycle={agent.lifecycle} key="s" />],
            ['Authentication', agent.identity.authentication],
            ['Token policy', agent.identity.tokenPolicy],
          ]}
        />
      </Panel>
      <Panel title="MCP access" padded={false}>
        {agent.access.map(entry => <McpAccessBlock key={entry.mcp} entry={entry} />)}
      </Panel>
    </div>
  );
}

function McpAccessBlock({ entry }: { entry: McpAccessView }) {
  return (
    <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.ruleSoft}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Allowed value={entry.allowed} />
        <strong style={{ fontSize: 13.5 }}>{entry.mcp} MCP</strong>
        {entry.audience && <Chip mono>{entry.audience}</Chip>}
      </div>
      {entry.allowed ? (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {entry.allowedTools.map(tool => <StatusPill tone="ok" dot={false} key={tool.name}>✓ {tool.name}</StatusPill>)}
          {entry.blockedTools.map(tool => <StatusPill tone="neutral" dot={false} key={tool.name}>✕ {tool.name}</StatusPill>)}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <Muted size={12.5}>No access. No audience is issued for this MCP, so this agent cannot obtain a credential for it.</Muted>
        </div>
      )}
    </div>
  );
}

const PERM_COLUMNS = '1.2fr .6fr 1.6fr .7fr .7fr';

function PermissionsTab({ agent }: { agent: AgentDetail }) {
  return (
    <Panel title="Effective permissions" padded={false}>
      <DataTable columns={PERM_COLUMNS} head={['MCP', 'ALLOWED', 'AUDIENCE', 'ALLOWED TOOLS', 'BLOCKED']}>
        {agent.access.map(entry => (
          <DataRow key={entry.mcp} columns={PERM_COLUMNS}>
            <Body>{entry.mcp}</Body>
            <div><Allowed value={entry.allowed} /></div>
            <Muted mono>{entry.audience ?? '—'}</Muted>
            <Body>{entry.allowedTools.length}</Body>
            <Body>{entry.blockedTools.length}</Body>
          </DataRow>
        ))}
      </DataTable>
      <div style={{ padding: '12px 18px' }}>
        <Muted size={12}>Enforced by the runtime before every tool call. This view reflects policy; it does not grant it.</Muted>
      </div>
    </Panel>
  );
}

const RUN_COLUMNS = '1.4fr .8fr 1.4fr .5fr .6fr .6fr';

function RunsTab({ agentId }: { agentId: string }) {
  const { value, loading, error } = useRuns();
  const runs = (value ?? []).filter(run => run.agents.includes(agentId));
  return (
    <AsyncState loading={loading} error={error}>
      <Panel title="Recent runs" padded={false}>
        {runs.length === 0 ? (
          <EmptyState>No runs recorded for this agent in the current runtime process.</EmptyState>
        ) : (
          <DataTable columns={RUN_COLUMNS} head={['TIME', 'STATUS', 'AGENTS', 'TOOLS', 'EVIDENCE', 'DURATION']}>
            {runs.map(run => (
              <DataRow key={run.requestId} columns={RUN_COLUMNS} onClick={() => { window.location.href = `/runs/${run.requestId}`; }}>
                <Body>{new Date(run.startedAt).toLocaleString()}</Body>
                <div><StatusPill tone={run.status === 'complete' ? 'ok' : run.status === 'partial' ? 'warn' : 'danger'}>{run.status}</StatusPill></div>
                <Body>{run.agents.join(', ')}</Body>
                <Body>{run.toolCalls}</Body>
                <Body>{run.evidenceCount}</Body>
                <Muted>{run.durationMs} ms</Muted>
              </DataRow>
            ))}
          </DataTable>
        )}
      </Panel>
    </AsyncState>
  );
}

function DeploymentTab({ agent }: { agent: AgentDetail }) {
  return (
    <Panel title="Deployment">
      <DefinitionList
        items={[
          ['Configuration source', <Mono key="s">agents/{agent.id}.yaml</Mono>],
          ['Prompt source', <Mono key="p">{agent.promptFile}</Mono>],
          ['Workload client', <Mono key="w">{agent.identity.clientId}</Mono>],
          ['Change process', 'pull request → review → merge → Argo CD sync'],
        ]}
      />
      <div style={{ marginTop: 12 }}>
        <Muted>Git is the source of truth. The portal proposes changes; it never deploys to production directly.</Muted>
      </div>
    </Panel>
  );
}
