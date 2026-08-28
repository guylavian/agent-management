import { useState } from 'react';
import { useAgent, usePermissionMatrix } from '../api/client';
import {
  Allowed,
  AsyncState,
  Body,
  C,
  Chip,
  DataRow,
  DataTable,
  Mono,
  Muted,
  Page,
  PageHeader,
  Panel,
  SectionTitle,
  StatusPill,
} from './common';

/**
 * Agent → MCP permissions matrix (TDD §23). Selecting a cell opens the detailed
 * grant; the same data is readable from both directions.
 */
export function PermissionsPage() {
  const { value, loading, error } = usePermissionMatrix();
  const [selected, setSelected] = useState<{ agent: string; mcp: string } | undefined>();

  const columns = value ? `1.6fr repeat(${value.mcps.length},1fr)` : '1fr';

  return (
    <Page>
      <PageHeader title="Permissions" subtitle="Which agent may reach which MCP, and with which tools" />
      <AsyncState loading={loading} error={error}>
        {value && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Panel title="Agent → MCP" padded={false}>
              <DataTable columns={columns} head={['AGENT', ...value.mcps.map(mcp => mcp.toUpperCase())]}>
                {value.rows.map(row => (
                  <DataRow key={row.agent} columns={columns}>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{row.agent}</div>
                    {row.cells.map(cell => (
                      <div
                        key={cell.mcp}
                        onClick={() => setSelected({ agent: cell.agent, mcp: cell.mcp })}
                        title={`${cell.agent} → ${cell.mcp}`}
                        style={{ cursor: 'pointer', textAlign: 'center' }}
                      >
                        <Allowed value={cell.allowed} />
                        {cell.allowed && <div style={{ fontSize: 10.5, color: C.dim, marginTop: 1 }}>{cell.toolCount}</div>}
                      </div>
                    ))}
                  </DataRow>
                ))}
              </DataTable>
              <div style={{ padding: '12px 18px' }}>
                <Muted size={12}>Select a cell for the exact grant. Counts are allowed tools on that MCP.</Muted>
              </div>
            </Panel>

            {selected && <PermissionDetail agent={selected.agent} mcp={selected.mcp} onClose={() => setSelected(undefined)} />}

            <Panel title="MCP → agents" padded={false}>
              <DataTable columns="1fr 3fr" head={['MCP', 'AGENTS WITH ACCESS']}>
                {value.mcps.map(mcp => {
                  const allowed = value.rows.filter(row => row.cells.find(cell => cell.mcp === mcp)?.allowed);
                  return (
                    <DataRow key={mcp} columns="1fr 3fr">
                      <Body>{mcp}</Body>
                      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                        {allowed.length === 0 ? <Muted size={12.5}>none</Muted> : allowed.map(row => <StatusPill tone="ok" dot={false} key={row.agent}>{row.agent}</StatusPill>)}
                      </div>
                    </DataRow>
                  );
                })}
              </DataTable>
            </Panel>
          </div>
        )}
      </AsyncState>
    </Page>
  );
}

function PermissionDetail({ agent, mcp, onClose }: { agent: string; mcp: string; onClose: () => void }) {
  const { value, loading, error } = useAgent(agent);
  const entry = value?.access.find(item => item.mcp === mcp);
  return (
    <Panel
      title={`${agent} → ${mcp}`}
      action={<button type="button" onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.muted, fontSize: 13, fontWeight: 600 }}>Close</button>}
    >
      <AsyncState loading={loading} error={error}>
        {entry === undefined ? (
          <Muted>No policy entry.</Muted>
        ) : entry.allowed ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <SectionTitle>Binding</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>Workload: <Mono>{value?.identity.clientId}</Mono></div>
                <div>Audience: <Mono>{entry.audience}</Mono></div>
                <div>Client scope: <Mono>{entry.audienceScope}</Mono></div>
                <div style={{ marginTop: 4 }}><StatusPill tone="ok">Read-only enforced</StatusPill></div>
              </div>
            </div>
            <div>
              <SectionTitle>Tools</SectionTitle>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {entry.allowedTools.map(tool => <StatusPill tone="ok" dot={false} key={tool.name}>✓ {tool.name}</StatusPill>)}
                {entry.blockedTools.map(tool => <StatusPill tone="neutral" dot={false} key={tool.name}>✕ {tool.name}</StatusPill>)}
              </div>
              {entry.blockedTools.length === 0 && <div style={{ marginTop: 8 }}><Muted size={12}>No other approved tools exist on this MCP.</Muted></div>}
            </div>
          </div>
        ) : (
          <>
            <Muted>Denied. No audience is issued for this MCP, so this agent cannot obtain a credential for it.</Muted>
            <div style={{ marginTop: 10 }}><Chip>no client scope attached</Chip></div>
          </>
        )}
      </AsyncState>
    </Panel>
  );
}
