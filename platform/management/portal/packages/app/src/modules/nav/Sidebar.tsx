import { NavContentBlueprint } from '@backstage/plugin-app-react';
import { Link, useLocation } from 'react-router-dom';

/**
 * Product sidebar.
 *
 * Backstage's default chrome is replaced entirely so the portal reads as its
 * own application rather than a Backstage instance with a plugin bolted on.
 * Nav order follows the product spec: Agents, Permissions, MCP Servers and Runs
 * are the priority destinations.
 */

const C = {
  accent: '#4f5be7',
  accentSoft: '#eef0fd',
  surface: '#ffffff',
  border: '#e6e8f0',
  rule: '#eceef4',
  text: '#1d2233',
  body: '#4a5170',
  faint: '#8b93a7',
};

interface NavEntry {
  label: string;
  to: string;
  glyph: { background: string; borderRadius: number; transform?: string };
}

const NAV: NavEntry[] = [
  { label: 'Overview', to: '/', glyph: { background: '#4f5be7', borderRadius: 2 } },
  { label: 'Agents', to: '/agents', glyph: { background: '#0e9384', borderRadius: 99 } },
  { label: 'Manager', to: '/manager', glyph: { background: '#c2410c', borderRadius: 99 } },
  { label: 'MCP Servers', to: '/mcp-servers', glyph: { background: '#e2a306', borderRadius: 2 } },
  { label: 'Permissions', to: '/permissions', glyph: { background: '#7c5cd6', borderRadius: 99 } },
  { label: 'Runs', to: '/runs', glyph: { background: '#19a15e', borderRadius: 2, transform: 'rotate(45deg)' } },
  { label: 'Catalog', to: '/catalog', glyph: { background: '#8b93a7', borderRadius: 2 } },
];

function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname.startsWith(to);
}

function SidebarContentComponent() {
  const { pathname } = useLocation();
  return (
    <div
      style={{
        // Backstage's SidebarPage wrapper is display:block, so an in-flow
        // sidebar would stack the page content underneath it. Taking the
        // sidebar out of flow and offsetting the content (see index.html)
        // gives the fixed-rail layout the design specifies.
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 1000,
        width: 222,
        flex: 'none',
        background: C.surface,
        borderRight: `1px solid ${C.border}`,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        fontFamily: "'Figtree',Helvetica,Arial,sans-serif",
        color: C.text,
        fontSize: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 16px 14px 16px' }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <div style={{ width: 10, height: 10, background: C.surface, borderRadius: 2, transform: 'rotate(45deg)' }} />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.2px' }}>AgentOps</div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: C.faint, letterSpacing: '.4px' }}>SRE PLATFORM</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 10px', flex: 1, overflowY: 'auto' }}>
        {NAV.map(entry => {
          const active = isActive(pathname, entry.to);
          return (
            <Link
              key={entry.label}
              to={entry.to}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '8px 12px',
                borderRadius: 8,
                fontSize: 13.5,
                fontWeight: active ? 700 : 500,
                color: active ? C.accent : C.body,
                background: active ? C.accentSoft : 'transparent',
                textDecoration: 'none',
                userSelect: 'none',
              }}
            >
              <span style={{ width: 9, height: 9, flex: 'none', ...entry.glyph }} />
              <span>{entry.label}</span>
            </Link>
          );
        })}
      </div>

      <div style={{ padding: '12px 14px', borderTop: `1px solid ${C.rule}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: '#e7f0ec', color: '#12794a' }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: '#19a15e' }} />
          Read-only platform
        </span>
        <Link to="/settings" style={{ display: 'flex', alignItems: 'center', gap: 9, textDecoration: 'none', color: C.text }}>
          <span style={{ width: 26, height: 26, borderRadius: 99, background: C.accent, color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>SR</span>
          <span>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700 }}>Settings</span>
            <span style={{ display: 'block', fontSize: 11, color: C.faint }}>Profile &amp; sign-out</span>
          </span>
        </Link>
      </div>
    </div>
  );
}

export const SidebarContent = NavContentBlueprint.make({
  params: { component: () => <SidebarContentComponent /> },
});
