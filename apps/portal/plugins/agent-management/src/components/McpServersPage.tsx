import { useState } from 'react';
import { useMcpServers } from '../api/client';
import { Allowed, AsyncState, Card, Cell, ClassificationBadge, KeyValue, Mono, PageShell, Pill, Row, Table, palette } from './common';

/** MCP servers and their ToolHive posture (TDD §37/§38). */
export function McpServersPage() {
  const { value, loading, error } = useMcpServers();
  const [selected, setSelected] = useState<string | undefined>();
  const servers = value ?? [];
  const detail = servers.find(server => server.id === selected);

  return (
    <PageShell title="MCP Servers" subtitle="ToolHive is the access boundary for every MCP">
      <AsyncState loading={loading} error={error}>
        <Card title="Servers">
          <Table head={['Name', 'ToolHive proxy', 'Expected audience', 'Agents', 'Tools', 'Read-only verified']}>
            {servers.map(server => (
              <Row key={server.id}>
                <Cell>
                  <button type="button" onClick={() => setSelected(server.id)} style={{ border: 'none', background: 'transparent', color: palette.accent, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                    {server.id}
                  </button>
                </Cell>
                {/* an unconfigured proxy is stated, not blanked */}
                <Cell>{server.toolhiveEndpoint ? <Mono>{server.toolhiveEndpoint}</Mono> : <Pill tone="warn">not configured in this deployment</Pill>}</Cell>
                <Cell><Mono>{server.expectedAudience}</Mono></Cell>
                <Cell>{server.agents.length}</Cell>
                <Cell>{server.toolCount}</Cell>
                <Cell><Allowed value={server.readOnlyVerified} /></Cell>
              </Row>
            ))}
          </Table>
        </Card>

        {detail && (
          <Card title={`${detail.id} MCP`} action={<button type="button" onClick={() => setSelected(undefined)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: palette.muted }}>Close</button>}>
            <KeyValue
              items={[
                ['ToolHive endpoint', detail.toolhiveEndpoint ? <Mono key="e">{detail.toolhiveEndpoint}</Mono> : 'not configured'],
                ['Expected audience', <Mono key="a">{detail.expectedAudience}</Mono>],
                ['Keycloak client scope', <Mono key="s">{detail.audienceScope}</Mono>],
                ['Allowed workloads', detail.agents.map(agent => `sre-agent-${agent}`).join(', ') || 'none'],
                ['Read-only verified', <Allowed value={detail.readOnlyVerified} key="r" />],
              ]}
            />
            <div style={{ marginTop: 16 }}>
              <Table head={['Tool', 'Classification']}>
                {detail.tools.map(tool => (
                  <Row key={tool.name}>
                    <Cell><Mono>{tool.name}</Mono></Cell>
                    <Cell><ClassificationBadge classification={tool.classification} /></Cell>
                  </Row>
                ))}
              </Table>
            </div>
          </Card>
        )}
      </AsyncState>
    </PageShell>
  );
}
