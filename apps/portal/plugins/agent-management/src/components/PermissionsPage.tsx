import { useState } from 'react';
import { useAgent, usePermissionMatrix } from '../api/client';
import { Allowed, AsyncState, Card, Cell, Mono, PageShell, Pill, Row, Table, palette } from './common';

/**
 * Agent → MCP permissions matrix (TDD §23). Selecting a cell opens the detailed
 * grant, and the same data reads from both directions: an agent's MCPs, or an
 * MCP's agents.
 */
export function PermissionsPage() {
  const { value, loading, error } = usePermissionMatrix();
  const [selected, setSelected] = useState<{ agent: string; mcp: string } | undefined>();

  return (
    <PageShell title="Permissions" subtitle="Which agent may reach which MCP, and with what tools">
      <AsyncState loading={loading} error={error}>
        {value && (
          <>
            <Card title="Agent → MCP">
              <Table head={['Agent', ...value.mcps]}>
                {value.rows.map(row => (
                  <Row key={row.agent}>
                    <Cell><strong>{row.agent}</strong></Cell>
                    {row.cells.map(cell => (
                      <td key={cell.mcp} style={{ padding: '11px 12px', textAlign: 'center' }}>
                        <button
                          type="button"
                          onClick={() => setSelected({ agent: cell.agent, mcp: cell.mcp })}
                          title={`${cell.agent} → ${cell.mcp}`}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15 }}
                        >
                          <Allowed value={cell.allowed} />
                        </button>
                      </td>
                    ))}
                  </Row>
                ))}
              </Table>
            </Card>

            <Card title="MCP → agents">
              <Table head={['MCP', 'Agents with access']}>
                {value.mcps.map(mcp => (
                  <Row key={mcp}>
                    <Cell>{mcp}</Cell>
                    <Cell>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {value.rows.filter(row => row.cells.find(cell => cell.mcp === mcp)?.allowed).map(row => <Pill tone="ok" key={row.agent}>{row.agent}</Pill>)}
                        {value.rows.every(row => !row.cells.find(cell => cell.mcp === mcp)?.allowed) && <span style={{ color: palette.muted, fontSize: 13 }}>none</span>}
                      </div>
                    </Cell>
                  </Row>
                ))}
              </Table>
            </Card>

            {selected && <PermissionDetail agent={selected.agent} mcp={selected.mcp} onClose={() => setSelected(undefined)} />}
          </>
        )}
      </AsyncState>
    </PageShell>
  );
}

function PermissionDetail({ agent, mcp, onClose }: { agent: string; mcp: string; onClose: () => void }) {
  const { value, loading, error } = useAgent(agent);
  const entry = value?.access.find(item => item.mcp === mcp);
  return (
    <Card title={`${agent} → ${mcp}`} action={<button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: palette.muted }}>Close</button>}>
      <AsyncState loading={loading} error={error}>
        {entry === undefined ? (
          <p style={{ color: palette.muted, margin: 0 }}>No policy entry.</p>
        ) : entry.allowed ? (
          <>
            <p style={{ margin: '0 0 10px' }}>Workload: <Mono>{value?.identity.clientId}</Mono></p>
            <p style={{ margin: '0 0 10px' }}>Audience: <Mono>{entry.audience}</Mono></p>
            <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Allowed</p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 18 }}>{entry.allowedTools.map(tool => <li key={tool.name}>✓ {tool.name}</li>)}</ul>
            <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Blocked</p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 18, color: palette.muted }}>
              {entry.blockedTools.length ? entry.blockedTools.map(tool => <li key={tool.name}>✕ {tool.name}</li>) : <li>none in the approved catalog</li>}
            </ul>
            <Pill tone="ok">Read-only enforced</Pill>
          </>
        ) : (
          <p style={{ margin: 0, color: palette.muted }}>
            Denied. No audience is issued for this MCP, so a credential for it cannot be obtained by this agent.
          </p>
        )}
      </AsyncState>
    </Card>
  );
}
