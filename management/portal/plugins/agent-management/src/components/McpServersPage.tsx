import { useState } from 'react';
import { useMcpServers } from '../api/client';
import {
  Allowed,
  AsyncState,
  Body,
  C,
  Chip,
  DataRow,
  DataTable,
  DefinitionList,
  ModeBadge,
  Mono,
  Muted,
  Page,
  PageHeader,
  Panel,
  StatusPill,
} from './common';

const COLUMNS = '1.2fr 1.8fr 1.5fr .6fr .5fr .8fr';
const TOOL_COLUMNS = '2fr .6fr';

/** MCP servers and their ToolHive posture (TDD §37/§38). */
export function McpServersPage() {
  const { value, loading, error } = useMcpServers();
  const [selected, setSelected] = useState<string | undefined>();
  const servers = value ?? [];
  const detail = servers.find(server => server.id === selected);

  return (
    <Page>
      <PageHeader title="MCP Servers" subtitle="ToolHive is the access boundary in front of every MCP" />
      <AsyncState loading={loading} error={error}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel padded={false}>
            <DataTable columns={COLUMNS} head={['NAME', 'TOOLHIVE PROXY', 'EXPECTED AUDIENCE', 'AGENTS', 'TOOLS', 'READ-ONLY']}>
              {servers.map(server => (
                <DataRow key={server.id} columns={COLUMNS} onClick={() => setSelected(server.id)}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: C.accent }}>{server.id}</div>
                  {/* an unconfigured proxy is stated, not blanked */}
                  <div>{server.toolhiveEndpoint ? <Mono>{server.toolhiveEndpoint}</Mono> : <StatusPill tone="warn">not configured here</StatusPill>}</div>
                  <Muted mono>{server.expectedAudience}</Muted>
                  <Body>{server.agents.length}</Body>
                  <Body>{server.toolCount}</Body>
                  <div><Allowed value={server.readOnlyVerified} /></div>
                </DataRow>
              ))}
            </DataTable>
          </Panel>

          {detail && (
            <Panel
              title={`${detail.id} MCP`}
              action={<button type="button" onClick={() => setSelected(undefined)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.muted, fontSize: 13, fontWeight: 600 }}>Close</button>}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, alignItems: 'start' }}>
                <DefinitionList
                  items={[
                    ['ToolHive endpoint', detail.toolhiveEndpoint ? <Mono key="e">{detail.toolhiveEndpoint}</Mono> : <Muted key="n">not configured in this deployment</Muted>],
                    ['Expected audience', <Mono key="a">{detail.expectedAudience}</Mono>],
                    ['Keycloak client scope', <Mono key="s">{detail.audienceScope}</Mono>],
                    ['OIDC enforcement', <StatusPill tone="ok" key="o">token verified by ToolHive</StatusPill>],
                    ['Read-only verified', <Allowed value={detail.readOnlyVerified} key="r" />],
                  ]}
                />
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: C.body, marginBottom: 8 }}>Allowed workload identities</div>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                    {detail.agents.length === 0 ? <Muted size={12.5}>none</Muted> : detail.agents.map(agent => <Chip key={agent} mono>sre-agent-{agent}</Chip>)}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 18, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
                <DataTable columns={TOOL_COLUMNS} head={['TOOL', 'CLASSIFICATION']}>
                  {detail.tools.map(tool => (
                    <DataRow key={tool.name} columns={TOOL_COLUMNS}>
                      <Body mono>{tool.name}</Body>
                      <div><ModeBadge classification={tool.classification} /></div>
                    </DataRow>
                  ))}
                </DataTable>
              </div>
            </Panel>
          )}
        </div>
      </AsyncState>
    </Page>
  );
}
