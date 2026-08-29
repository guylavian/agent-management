import { NavContentBlueprint } from '@backstage/plugin-app-react';
import type React from 'react';
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
  accentSoft: '#eaf1fa',
  surface: '#ffffff',
  border: '#e4e7ec',
  rule: '#eceef2',
  text: '#1c2128',
  body: '#4c545f',
  faint: '#7a828c',
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
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {ICONS[name]}
    </svg>
  );
}

function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname.startsWith(to);
}

function NavLink({ entry, active, compact }: { entry: (typeof NAV)[number]; active: boolean; compact?: boolean }) {
  return (
    <Link
      to={entry.to}
      title={compact ? entry.label : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 10px',
        borderRadius: 8,
        fontSize: 13.5,
        fontWeight: active ? 600 : 500,
        color: active ? C.accent : C.body,
        background: active ? C.accentSoft : 'transparent',
        textDecoration: 'none',
        userSelect: 'none',
      }}
    >
      <NavIcon name={entry.icon} />
      {!compact && <span>{entry.label}</span>}
    </Link>
  );
}

function SidebarContentComponent() {
  const { pathname } = useLocation();
  // below 900px the rail collapses to its icons; labels and group headings are
  // hidden by the same query in index.html so the two can never disagree
  const compact = typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
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
        width: compact ? 64 : 244,
        background: C.surface,
        borderRight: `1px solid ${C.border}`,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        padding: compact ? '20px 8px 16px 8px' : '20px 12px 16px 12px',
        boxSizing: 'border-box',
        fontFamily: "'Figtree',Helvetica,Arial,sans-serif",
        color: C.text,
        fontSize: 13.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: compact ? '0 6px' : '0 10px', marginBottom: 26 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <svg width="19" height="19" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="5.4" width="10" height="7.2" rx="2.2" /><path d="M8 5.4V3.2M6.2 8.6v1.4M9.8 8.6v1.4M1.6 8.6v1.6M14.4 8.6v1.6" /><circle cx="8" cy="2.6" r="1" />
          </svg>
        </div>
        {!compact && <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>SRE Assistant</div>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflowY: 'auto' }}>
        {!compact && <GroupLabel>Agent management</GroupLabel>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.filter(entry => entry.group === 'work').map(entry => (
            <NavLink key={entry.label} entry={entry} active={isActive(pathname, entry.to)} compact={compact} />
          ))}
        </div>

        {!compact && <GroupLabel>Platform</GroupLabel>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.filter(entry => entry.group === 'platform').map(entry => (
            <NavLink key={entry.label} entry={entry} active={isActive(pathname, entry.to)} compact={compact} />
          ))}
        </div>

        {!compact && <GroupLabel>Settings</GroupLabel>}
        <NavLink entry={{ label: 'Settings', to: '/settings', icon: 'settings', group: 'platform' }} active={isActive(pathname, '/settings')} compact={compact} />
      </div>

      {/*
        * The reference has a user card here. This console never receives a
        * name, a team or a photograph — the runtime hashes the subject before
        * it leaves the process — so the card would have to be invented, and
        * the rail ends without one.
        */}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', color: C.faint, padding: '0 10px', margin: '20px 0 8px 0' }}>
      {children}
    </div>
  );
}

export const SidebarContent = NavContentBlueprint.make({
  params: { component: () => <SidebarContentComponent /> },
});
