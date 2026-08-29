import { NavContentBlueprint } from '@backstage/plugin-app-react';
import { Link, useLocation } from 'react-router-dom';

/**
 * Product sidebar.
 *
 * Backstage's default chrome is replaced entirely so the portal reads as its
 * own application rather than a Backstage instance with a plugin bolted on.
 *
 * The rail is one step warmer than the page canvas so the two read as layers
 * rather than as a seam. Icons are monochrome and inherit the row's colour, so
 * an icon can never disagree with its label about whether the row is selected.
 */

const C = {
  accent: '#1f5fb5',
  accentSoft: '#e9f0fa',
  rail: '#f3f1ec',
  border: '#e4e1db',
  rule: '#ece9e3',
  text: '#1f2430',
  body: '#3b4150',
  muted: '#666c7a',
};

/**
 * Destinations only, in two groups.
 *
 * Each entry used to carry its own colour, which made the rail read as seven
 * unrelated products: colour was doing decoration, not telling an operator
 * anything. Selection is the only state the nav has, so it is the only thing
 * that changes appearance.
 */
const NAV: Array<{ label: string; to: string; icon: keyof typeof ICONS; group: 'work' | 'platform' }> = [
  { label: 'Overview', to: '/', icon: 'overview', group: 'work' },
  { label: 'Agents', to: '/agents', icon: 'agents', group: 'work' },
  { label: 'Manager', to: '/manager', icon: 'manager', group: 'work' },
  { label: 'Runs', to: '/runs', icon: 'runs', group: 'work' },
  { label: 'MCP Servers', to: '/mcp-servers', icon: 'mcp', group: 'platform' },
  { label: 'Permissions', to: '/permissions', icon: 'permissions', group: 'platform' },
  { label: 'Catalog', to: '/catalog', icon: 'catalog', group: 'platform' },
];

const ICONS = {
  overview: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>,
  agents: <><circle cx="8" cy="5" r="2.6" /><path d="M2.6 14c.6-2.6 2.7-4 5.4-4s4.8 1.4 5.4 4" /></>,
  manager: <><path d="M8 2v3.4M8 10.6V14M3 8h10" /><circle cx="8" cy="8" r="2.4" /></>,
  mcp: <><rect x="2" y="3" width="12" height="4" rx="1.2" /><rect x="2" y="9" width="12" height="4" rx="1.2" /></>,
  permissions: <><rect x="3.5" y="7" width="9" height="6.2" rx="1.4" /><path d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7" /></>,
  runs: <><circle cx="8" cy="8" r="6" /><path d="M8 4.6V8l2.3 1.4" /></>,
  catalog: <><path d="M3 3.6h10M3 8h10M3 12.4h10" /></>,
  settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" /></>,
} as const;

function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {ICONS[name]}
    </svg>
  );
}

function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname.startsWith(to);
}

function NavLink({ entry, active }: { entry: (typeof NAV)[number]; active: boolean }) {
  return (
    <Link
      to={entry.to}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 10px',
        borderRadius: 6,
        fontSize: 13.5,
        fontWeight: active ? 600 : 400,
        color: active ? C.accent : C.body,
        background: active ? C.accentSoft : 'transparent',
        textDecoration: 'none',
        userSelect: 'none',
      }}
    >
      <NavIcon name={entry.icon} />
      <span>{entry.label}</span>
    </Link>
  );
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
        width: 236,
        background: C.rail,
        borderRight: `1px solid ${C.border}`,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        fontFamily: "'Figtree',Helvetica,Arial,sans-serif",
        color: C.text,
        fontSize: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '18px 16px 14px 18px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.1px' }}>SRE Assistant</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px', flex: 1, overflowY: 'auto' }}>
        {NAV.filter(entry => entry.group === 'work').map(entry => (
          <NavLink key={entry.label} entry={entry} active={isActive(pathname, entry.to)} />
        ))}

        {/* the split is between what you operate and what bounds it */}
        <div style={{ height: 1, background: C.rule, margin: '10px 10px' }} />

        {NAV.filter(entry => entry.group === 'platform').map(entry => (
          <NavLink key={entry.label} entry={entry} active={isActive(pathname, entry.to)} />
        ))}
      </div>

      {/*
        * Settings only. There is no user card here: the console never receives
        * a name, a photograph or an email — the runtime hashes the subject
        * before it leaves — so an identity block would have to be invented.
        */}
      <div style={{ padding: '8px 10px 12px 10px', borderTop: `1px solid ${C.rule}` }}>
        <Link
          to="/settings"
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6,
            fontSize: 13.5, fontWeight: isActive(pathname, '/settings') ? 600 : 400,
            color: isActive(pathname, '/settings') ? C.accent : C.muted,
            background: isActive(pathname, '/settings') ? C.accentSoft : 'transparent',
            textDecoration: 'none',
          }}
        >
          <NavIcon name="settings" />
          <span>Settings</span>
        </Link>
      </div>
    </div>
  );
}

export const SidebarContent = NavContentBlueprint.make({
  params: { component: () => <SidebarContentComponent /> },
});
