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
  accent: '#1f5fb5',
  accentSoft: '#eaf1fa',
  surface: '#ffffff',
  border: '#d5d9e0',
  rule: '#e4e7ec',
  text: '#1c2128',
  body: '#39404a',
  faint: '#7c848f',
};

/**
 * Destinations only. Each entry used to carry its own colour, which made the
 * rail read as seven unrelated products: colour was doing decoration, not
 * telling an operator anything. Selection is the only state the nav has, so it
 * is the only thing that changes appearance.
 */
const NAV: Array<{ label: string; to: string }> = [
  { label: 'Overview', to: '/' },
  { label: 'Agents', to: '/agents' },
  { label: 'Manager', to: '/manager' },
  { label: 'MCP Servers', to: '/mcp-servers' },
  { label: 'Permissions', to: '/permissions' },
  { label: 'Runs', to: '/runs' },
  { label: 'Catalog', to: '/catalog' },
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
      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 16px 12px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.1px' }}>Agent Management</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '4px 8px', flex: 1, overflowY: 'auto' }}>
        {NAV.map(entry => {
          const active = isActive(pathname, entry.to);
          return (
            <Link
              key={entry.label}
              to={entry.to}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 8px',
                borderRadius: 3,
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                color: active ? C.text : C.body,
                background: active ? C.accentSoft : 'transparent',
                // the selected row is marked on its leading edge rather than by
                // weight alone, so selection survives being scanned peripherally
                boxShadow: active ? `inset 2px 0 0 ${C.accent}` : 'none',
                textDecoration: 'none',
                userSelect: 'none',
              }}
            >
              <span>{entry.label}</span>
            </Link>
          );
        })}
      </div>

      {/*
        * The "Read-only platform" badge that used to sit here was a constant:
        * it never changed, could not be acted on, and occupied the position an
        * operator checks for state. The read-only posture is a property of each
        * agent and is shown per agent, where it can actually differ.
        */}
      <div style={{ padding: '8px', borderTop: `1px solid ${C.rule}` }}>
        <Link to="/settings" style={{ display: 'block', padding: '5px 8px', borderRadius: 3, fontSize: 13, textDecoration: 'none', color: C.body }}>
          Settings
        </Link>
      </div>
    </div>
  );
}

export const SidebarContent = NavContentBlueprint.make({
  params: { component: () => <SidebarContentComponent /> },
});
