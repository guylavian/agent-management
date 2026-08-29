import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, KeyboardEvent } from 'react';
import { NotConfiguredError } from '../api/client';
import type { AgentLifecycle, ToolClassification } from '../api/types';

/**
 * Makes a non-semantic element operable by keyboard as well as mouse.
 *
 * These rows, cells and breadcrumbs are styled containers rather than
 * `<button>`s, which is a visual choice — it must not become an accessibility
 * one. Spreading this gives them a role, focus order and Enter/Space handling,
 * so nothing in the console is reachable only with a pointer.
 */
export function clickable(onClick: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onClick();
    },
  } as const;
}

/**
 * Design system for the Agent Management console.
 *
 * The audience is platform and SRE engineers reading configuration, so the
 * surface is built for density and scanning: flat panels, thin rules, one
 * accent colour, and colour reserved for meaning. Nothing here is decorative.
 *
 * COLOUR IS FUNCTIONAL. green = healthy, amber = degraded or pending, red =
 * failed or denied, blue = link, selection or primary action. Everything else
 * is neutral grey. An operator scanning a table should be able to trust that a
 * coloured pixel means something.
 *
 * Styles are plain inline objects so the plugin carries no styling dependency
 * and Backstage's own theme cannot bleed into the product surface.
 */

/** 4 / 8 / 12 / 16 / 24 / 32. Every gap, pad and margin comes from here. */
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Containers are softened; controls stay tighter so forms still read as forms. */
export const R = { control: 8, container: 12, small: 6 } as const;

export const C = {
  accent: '#1f5fb5',
  accentHover: '#1a5099',
  accentSoft: '#eaf1fa',
  /**
   * Cool near-white. An earlier pass warmed this to a beige and the result read
   * as a dirty grey rather than as warmth: the surfaces sitting on it are pure
   * white, and the two fought. Warmth here comes from roundness, space and
   * illustration, not from tinting the paper.
   */
  canvas: '#f7f8fa',
  surface: '#ffffff',
  /** the rail is WHITE and separated by a rule, as the reference has it */
  rail: '#ffffff',
  hover: '#f6f7f9',
  border: '#e4e7ec',
  borderInput: '#d5d9e0',
  borderStrong: '#c9ced8',
  rule: '#eceef2',
  ruleSoft: '#f2f4f7',
  chip: '#f0f2f5',
  text: '#1c2128',
  body: '#39404a',
  bodySoft: '#4c545f',
  muted: '#656d78',
  // 4.5:1 on white: faint carries real metadata (agent ids, breadcrumbs),
  // so it has to be readable, not just present
  faint: '#6b727c',
  dim: '#7a828c',
  green: '#1a7f45',
  greenBright: '#1f9d55',
  greenSoft: '#e7f3ec',
  amber: '#8a5a00',
  amberBright: '#c58600',
  amberSoft: '#fdf2dd',
  red: '#a8202f',
  redBright: '#c8394a',
  redSoft: '#fbeaec',
};

/**
 * Tile tones for the small visual area on an agent card.
 *
 * Assigned by OWNER, not by a hash of the name, so the colour means something:
 * agents belonging to the same team carry the same tone and group visually
 * down the grid. A per-agent colour would be decoration; this is a grouping.
 * Muted on purpose — the tile is the only place any of this appears.
 */
const TILE_TONES = [
  { bg: '#e8effb', fg: '#2c4f8f' },
  { bg: '#fdf1dc', fg: '#8a5a00' },
  { bg: '#eae9fb', fg: '#4b3f96' },
  { bg: '#e6f3ec', fg: '#1f6b45' },
  { bg: '#fbeaec', fg: '#8f2a38' },
  { bg: '#e4f1f4', fg: '#1d5f6b' },
] as const;

export function tileTone(owner: string): { bg: string; fg: string } {
  let hash = 0;
  for (const char of owner) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return TILE_TONES[hash % TILE_TONES.length] as { bg: string; fg: string };
}

/** First letters of an owner or agent id, for the tile. Never a person. */
export function initials(name: string): string {
  const parts = name.split(/[-\s_]/u).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}

export const FONT = "'Figtree',Helvetica,Arial,sans-serif";
export const MONO = 'ui-monospace,Menlo,monospace';

export function Page(props: { children: ReactNode }) {
  return (
    <div style={{ padding: '28px 32px 40px 32px', maxWidth: 1320, fontFamily: FONT, color: C.text, fontSize: 13.5 }}>
      {props.children}
    </div>
  );
}

export function PageHeader(props: { title: string; subtitle?: string; action?: ReactNode; tight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: S.lg, marginBottom: 24 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.4px', lineHeight: 1.2 }}>{props.title}</div>
        {props.subtitle && <div style={{ fontSize: 13.5, color: C.muted, marginTop: 6 }}>{props.subtitle}</div>}
      </div>
      {props.action}
    </div>
  );
}

export function Breadcrumb(props: { items: Array<{ label: string; onClick?: () => void }> }) {
  return (
    <div style={{ fontSize: 12, color: C.faint, marginBottom: S.md }}>
      {props.items.map((item, index) => (
        <span key={item.label}>
          {index > 0 && ' / '}
          {item.onClick ? (
            <span style={{ color: C.accent, cursor: 'pointer' }} {...clickable(item.onClick)}>{item.label}</span>
          ) : (
            item.label
          )}
        </span>
      ))}
    </div>
  );
}

export function Button(props: { onClick?: () => void; variant?: 'primary' | 'secondary' | 'link'; disabled?: boolean; children: ReactNode }) {
  const variant = props.variant ?? 'primary';
  const base: CSSProperties = { borderRadius: R.control, fontWeight: 500, fontFamily: FONT, cursor: props.disabled ? 'not-allowed' : 'pointer', opacity: props.disabled ? 0.5 : 1 };
  const styles: Record<string, CSSProperties> = {
    primary: { ...base, background: C.accent, color: C.surface, border: `1px solid ${C.accent}`, padding: '9px 18px', fontSize: 14 },
    secondary: { ...base, background: C.surface, border: `1px solid ${C.borderInput}`, color: C.body, padding: '9px 18px', fontSize: 14 },
    link: { ...base, background: 'none', border: 'none', color: C.accent, fontSize: 14, padding: `${S.xs}px 0` },
  };
  return (
    <button type="button" onClick={props.onClick} disabled={props.disabled} style={styles[variant]}>
      {props.children}
    </button>
  );
}

/**
 * A single counted fact. Deliberately small: these are reference numbers an
 * operator glances at, not a dashboard, so the value does not dominate the row.
 */
export function StatCard(props: { label: string; value: ReactNode; sub?: ReactNode; dot?: string; subTone?: 'default' | 'ok' }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.container, padding: `${S.md}px ${S.md}px` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, fontSize: 12, color: C.muted }}>
        {props.dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: props.dot, flex: 'none' }} />}
        {props.label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: S.xs, letterSpacing: '-0.2px' }}>{props.value}</div>
      {props.sub !== undefined && (
        <div style={{ fontSize: 11.5, color: props.subTone === 'ok' ? C.green : C.dim, marginTop: 2 }}>{props.sub}</div>
      )}
    </div>
  );
}


/**
 * Small monochrome line icons, drawn inline.
 *
 * `@material-ui/icons` is a dependency of the app shell but not of this plugin,
 * and a handful of 16px strokes is not worth taking one on. They inherit
 * `currentColor`, so a section heading and its icon can never disagree.
 */
export function Icon(props: { name: keyof typeof ICON_PATHS; size?: number; color?: string }) {
  const size = props.size ?? 16;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={props.color ?? 'currentColor'} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {ICON_PATHS[props.name]}
    </svg>
  );
}

const ICON_PATHS = {
  overview: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>,
  agents: <><circle cx="8" cy="5" r="2.6" /><path d="M2.6 14c.6-2.6 2.7-4 5.4-4s4.8 1.4 5.4 4" /></>,
  manager: <><path d="M8 2v3.4M8 10.6V14M3 8h10" /><circle cx="8" cy="8" r="2.4" /></>,
  mcp: <><rect x="2" y="3" width="12" height="4" rx="1.2" /><rect x="2" y="9" width="12" height="4" rx="1.2" /></>,
  permissions: <><rect x="3.5" y="7" width="9" height="6.2" rx="1.4" /><path d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7" /></>,
  runs: <><circle cx="8" cy="8" r="6" /><path d="M8 4.6V8l2.3 1.4" /></>,
  catalog: <><path d="M3 3.6h10M3 8h10M3 12.4h10" /></>,
  settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" /></>,
  general: <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 6.5h5M5.5 9.5h3" /></>,
  routing: <><circle cx="3.5" cy="8" r="1.6" /><circle cx="12.5" cy="4" r="1.6" /><circle cx="12.5" cy="12" r="1.6" /><path d="M5.1 8h2.4l3.5-3.6M5.1 8h2.4l3.5 3.6" /></>,
  model: <><path d="M8 2.2 13.4 5v6L8 13.8 2.6 11V5z" /><path d="M8 8 13.4 5M8 8v5.8M8 8 2.6 5" /></>,
  identity: <><circle cx="8" cy="5.4" r="2.4" /><path d="M3.2 13.4c.5-2.4 2.4-3.8 4.8-3.8s4.3 1.4 4.8 3.8" /></>,
  runtime: <><rect x="2.4" y="4.4" width="11.2" height="7.2" rx="1.4" /><path d="M5.6 2.4v2M10.4 2.4v2M5.6 11.6v2M10.4 11.6v2" /></>,
  security: <><path d="M8 2 3.4 4v4c0 3 1.9 5 4.6 6 2.7-1 4.6-3 4.6-6V4z" /><path d="M6.2 8.2 7.5 9.5l2.5-2.6" /></>,
  tool: <><path d="M10.6 2.6a3 3 0 0 0-3.9 3.9L2.6 10.6l1.4 1.4 4.1-4.1a3 3 0 0 0 3.9-3.9L10.2 5.4 9 4.2z" /></>,
  activity: <><path d="M1.8 8h3l1.6-4 2.4 8 1.6-4h3.4" /></>,
} as const;

/**
 * A soft container. Used where a group of facts belongs together — a section of
 * a form, an agent in a grid. `interactive` adds the one-pixel lift that says
 * a whole surface is clickable; nothing else in the console moves on hover.
 */
export function Card(props: { onClick?: () => void; padded?: boolean; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  const lifted = props.onClick !== undefined && hover;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: C.surface,
        border: `1px solid ${lifted ? C.borderStrong : C.border}`,
        borderRadius: R.container,
        boxShadow: lifted ? '0 2px 8px rgba(28,33,40,.06)' : '0 1px 3px rgba(28,33,40,.05)',
        padding: props.padded === false ? undefined : 20,
        cursor: props.onClick ? 'pointer' : 'default',
        height: '100%',
        transition: 'border-color .12s, box-shadow .12s',
      }}
      {...(props.onClick ? clickable(props.onClick) : {})}
    >
      {props.children}
    </div>
  );
}

/**
 * The small visual area on an agent card: initials of the agent id on a tone
 * chosen by OWNER. It represents a service, never a person — there are no
 * photographs and no invented identities anywhere in this console.
 */
export function AgentTile(props: { id: string; owner: string; size?: number }) {
  const size = props.size ?? 36;
  const tone = tileTone(props.owner);
  return (
    <div
      title={`owner: ${props.owner}`}
      style={{
        width: size, height: size, borderRadius: size >= 36 ? 10 : 6, background: tone.bg, color: tone.fg,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        fontSize: size >= 40 ? 13 : size >= 28 ? 11 : 9.5, fontWeight: 700, letterSpacing: '.2px',
      }}
    >
      {initials(props.id)}
    </div>
  );
}

/** Section heading with an optional icon, for a page built from Cards. */
export function GroupHeader(props: { title: string; icon?: keyof typeof ICON_PATHS; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, marginBottom: S.md }}>
      {props.icon && <span style={{ color: C.muted, display: 'flex' }}><Icon name={props.icon} /></span>}
      <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{props.title}</div>
      {props.action}
    </div>
  );
}

/**
 * A blue-tinted chip for a single standing fact — read-only, granted. Small,
 * and only ever one per surface: it is the exception, not a row of labels.
 */
export function SoftChip(props: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 600, color: C.accent, background: C.accentSoft, borderRadius: 5, padding: '2px 7px', whiteSpace: 'nowrap' }}>
      {props.children}
    </span>
  );
}

/**
 * The card an agent gets in a grid: a tinted initials tile, the name, its
 * status, the description from its own document, and what it can reach.
 *
 * The reference this follows puts an illustration and a person's face on each
 * card. There is no illustration in the Agent document and no person anywhere
 * in this system — the runtime hashes the subject before it leaves — so the
 * tile is initials on a tone chosen by owning team, and the byline is the team.
 */
export function AgentGridCard(props: {
  id: string; displayName: string; description?: string; owner: string;
  lifecycle: AgentLifecycle; mcpCount: number; toolCount: number; readOnly: boolean;
  onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...clickable(props.onOpen)}
      style={{
        border: `1px solid ${hover ? C.borderStrong : C.rule}`,
        borderRadius: 10,
        padding: 16,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: hover ? '0 2px 8px rgba(28,33,40,.06)' : 'none',
        transition: 'border-color .12s, box-shadow .12s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <AgentTile id={props.id} owner={props.owner} size={40} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 }}>{props.displayName}</div>
          <div style={{ marginTop: 3 }}><StatusPill tone={lifecycleTone(props.lifecycle)}>{props.lifecycle}</StatusPill></div>
        </div>
      </div>

      {props.description !== undefined && (
        <div style={{ fontSize: 12.5, color: C.bodySoft, lineHeight: 1.45, flex: 1 }}>{props.description}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, fontSize: 12, color: C.muted }}>
        <Icon name="identity" size={13} />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.owner}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: C.muted }}>
        <span>{props.mcpCount} MCPs</span>
        <span style={{ color: C.borderInput }}>·</span>
        <span>{props.toolCount} tools</span>
        {props.readOnly && <span style={{ marginLeft: 'auto' }}><SoftChip>Read-only</SoftChip></span>}
      </div>
    </div>
  );
}

/**
 * A modal for one focused sub-task — picking the tools on a single MCP server.
 *
 * Closing is possible from three places (the button, the backdrop, Escape)
 * because a dialog that traps an operator is worse than one that is easy to
 * dismiss by accident: nothing here is destructive, and every selection is
 * still only a draft until a pull request is merged.
 */
export function Dialog(props: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);

  /**
   * `aria-modal` is a promise to keyboard users that the rest of the page is
   * out of reach. Without focus handling it is only a promise: Tab walks out
   * of the dialog into the form behind it, and on close the caret lands at the
   * top of the document rather than back on the Edit button that opened it.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { props.onClose(); return; }
      if (event.key !== 'Tab' || panel.current === null) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>('button, [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [props]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(31,36,48,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: S.xl }}
      onClick={props.onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        ref={panel}
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
        style={{ outline: 'none', background: C.surface, borderRadius: R.container, border: `1px solid ${C.border}`, width: 'min(560px,100%)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(31,36,48,.16)' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: S.md, padding: `${S.lg}px ${S.xl}px`, borderBottom: `1px solid ${C.rule}` }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{props.title}</div>
            {props.subtitle && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>{props.subtitle}</div>}
          </div>
          <Button variant="secondary" onClick={props.onClose}>Done</Button>
        </div>
        <div style={{ overflowY: 'auto', padding: `${S.sm}px 0` }}>{props.children}</div>
      </div>
    </div>
  );
}

/** Relative time from an ISO timestamp. Real value or nothing — never "just now" as filler. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function StatGrid(props: { columns?: number; children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${props.columns ?? 6},1fr)`, gap: S.md, marginBottom: S.lg }}>{props.children}</div>;
}

/** Flat surface with an optional titled header rule. */
export function Panel(props: { title?: string; action?: ReactNode; padded?: boolean; children: ReactNode }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.container, boxShadow: '0 1px 3px rgba(28,33,40,.05)', overflow: 'hidden' }}>
      {(props.title || props.action) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, padding: `${S.md}px ${S.lg}px`, borderBottom: `1px solid ${C.rule}` }}>
          <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{props.title}</div>
          {props.action}
        </div>
      )}
      <div style={props.padded === false ? undefined : { padding: S.lg }}>{props.children}</div>
    </div>
  );
}

/**
 * A titled band on a long configuration page — the unit the Create Agent form
 * is built from. Sections are separated by a rule and a heading rather than by
 * nesting one card inside another, which reads as depth that is not there.
 */
export function Section(props: { title: string; description?: string; icon?: keyof typeof ICON_PATHS; children: ReactNode }) {
  return (
    <section style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.container, boxShadow: '0 1px 3px rgba(28,33,40,.05)', padding: 20, marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, marginBottom: props.description ? S.xs : S.lg }}>
        {props.icon && <span style={{ color: C.muted, display: 'flex' }}><Icon name={props.icon} /></span>}
        <div style={{ fontSize: 15, fontWeight: 600 }}>{props.title}</div>
      </div>
      {props.description && <div style={{ fontSize: 12.5, color: C.muted, marginBottom: S.lg, maxWidth: 720 }}>{props.description}</div>}
      {props.children}
    </section>
  );
}

/** Two-column field grid: the default arrangement inside a Section. */
export function FieldGrid(props: { columns?: number; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${props.columns ?? 2},minmax(0,1fr))`, gap: `${S.lg}px ${S.xl}px`, maxWidth: 860 }}>
      {props.children}
    </div>
  );
}

/**
 * Tables are CSS grids, not <table>, so column tracks stay aligned across the
 * header rule and every row while cells remain free-form.
 */
export function DataTable(props: { columns: string; head: ReactNode[]; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: props.columns, gap: S.md, padding: `${S.md}px 20px`, fontSize: 11.5, fontWeight: 500, letterSpacing: '.4px', textTransform: 'uppercase', color: C.faint, borderBottom: `1px solid ${C.rule}` }}>
        {props.head.map((label, index) => (
          <div key={index}>{label}</div>
        ))}
      </div>
      {props.children}
    </div>
  );
}

export function DataRow(props: { columns: string; onClick?: () => void; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: props.columns,
        gap: S.md,
        alignItems: 'center',
        padding: `${S.md}px 20px`,
        borderBottom: `1px solid ${C.ruleSoft}`,
        cursor: props.onClick ? 'pointer' : 'default',
      }}
      {...(props.onClick ? clickable(props.onClick) : {})}
    >
      {props.children}
    </div>
  );
}

export function Muted(props: { size?: number; mono?: boolean; children: ReactNode }) {
  return <div style={{ color: C.muted, fontSize: props.size ?? 13.5, ...(props.mono ? { fontFamily: MONO, fontSize: props.size ?? 13 } : {}) }}>{props.children}</div>;
}

export function Body(props: { mono?: boolean; children: ReactNode }) {
  return <div style={{ color: C.bodySoft, fontSize: props.mono ? 13 : 13.5, ...(props.mono ? { fontFamily: MONO } : {}) }}>{props.children}</div>;
}

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'info';

const TONES: Record<Tone, { fg: string; dot: string; soft: string }> = {
  ok: { fg: C.green, dot: C.greenBright, soft: C.greenSoft },
  warn: { fg: C.amber, dot: C.amberBright, soft: C.amberSoft },
  danger: { fg: C.red, dot: C.redBright, soft: C.redSoft },
  neutral: { fg: C.muted, dot: C.dim, soft: C.chip },
  info: { fg: C.accent, dot: C.accent, soft: C.accentSoft },
};

/**
 * Status as a coloured dot and a plain label — the console's most repeated
 * element, so it is also its quietest. A filled capsule per row turns a table
 * into a field of colour and makes the one row that is actually degraded
 * harder to find, not easier.
 */
export function StatusPill(props: { tone: Tone; dot?: boolean; children: ReactNode }) {
  const tone = TONES[props.tone];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: props.tone === 'neutral' ? C.bodySoft : tone.fg, whiteSpace: 'nowrap' }}>
      {props.dot !== false && <span style={{ width: 6, height: 6, borderRadius: 99, background: tone.dot, flex: 'none' }} />}
      {props.children}
    </span>
  );
}

/** A bounded label for an identifier — model profile, audience, scope. */
export function Chip(props: { mono?: boolean; children: ReactNode }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 400, padding: '1px 6px', borderRadius: R.small, background: C.chip, border: `1px solid ${C.rule}`, color: C.bodySoft, ...(props.mono ? { fontFamily: MONO } : {}) }}>
      {props.children}
    </span>
  );
}

export function lifecycleTone(lifecycle: AgentLifecycle): Tone {
  if (lifecycle === 'active') return 'ok';
  if (lifecycle === 'disabled' || lifecycle === 'removed') return 'danger';
  if (lifecycle === 'draft') return 'neutral';
  return 'warn';
}

export function LifecycleBadge({ lifecycle }: { lifecycle: AgentLifecycle }) {
  return <StatusPill tone={lifecycleTone(lifecycle)}>{lifecycle}</StatusPill>;
}

/**
 * READ / WRITE / UNKNOWN. UNKNOWN is rendered as a warning and never as READ —
 * a tool missing from the approved catalog must look unsafe, because it is.
 * This one keeps a filled background: it marks the two values an operator must
 * not skim past, and READ is the overwhelmingly common case it contrasts with.
 */
export function ModeBadge({ classification }: { classification: ToolClassification }) {
  const attention = classification === 'write' || classification === 'unknown';
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 500,
        padding: '1px 5px',
        borderRadius: R.small,
        background: attention ? C.amberSoft : 'transparent',
        border: `1px solid ${attention ? C.amberBright : C.border}`,
        color: attention ? C.amber : C.muted,
        letterSpacing: '.3px',
        whiteSpace: 'nowrap',
      }}
    >
      {classification.toUpperCase()}
    </span>
  );
}

export function Allowed({ value }: { value: boolean }) {
  return <span style={{ color: value ? C.greenBright : C.dim, fontWeight: 600, fontSize: 13 }}>{value ? '✓' : '✕'}</span>;
}

export function Toggle(props: { on: boolean; onClick?: () => void; label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: S.sm }}>
      {props.label && <span style={{ fontSize: 12.5, color: C.muted }}>{props.label}</span>}
      {/*
        * Without an onClick this REFLECTS state, it does not change it — agent
        * lifecycle moves through a pull request, not a click. It is disabled
        * rather than silently inert so the control does not look actionable
        * and then do nothing when pressed.
        */}
      <button
        type="button"
        onClick={props.onClick}
        disabled={!props.onClick}
        aria-readonly={!props.onClick}
        title={props.onClick ? undefined : 'Reflects what Git declares, not what is running. Changing it is a pull request, not a click.'}
        style={{ width: 32, height: 18, borderRadius: 99, background: props.on ? C.accent : C.borderStrong, position: 'relative', cursor: props.onClick ? 'pointer' : 'default', border: 'none', flex: 'none', padding: 0, opacity: props.onClick ? 1 : 0.75 }}
      >
        <span style={{ position: 'absolute', top: 3, left: props.on ? 17 : 3, width: 12, height: 12, borderRadius: 99, background: '#fff' }} />
      </button>
    </div>
  );
}

export function Tabs(props: { tabs: readonly string[]; active: string; onChange: (tab: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: S.lg, borderBottom: `1px solid ${C.border}`, marginBottom: S.lg, flexWrap: 'wrap' }}>
      {props.tabs.map(tab => {
        const active = tab === props.active;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => props.onChange(tab)}
            style={{ border: 'none', background: 'none', padding: `${S.sm}px 0`, fontSize: 13, fontFamily: FONT, fontWeight: active ? 600 : 400, color: active ? C.text : C.muted, borderBottom: `2px solid ${active ? C.accent : 'transparent'}`, cursor: 'pointer', marginBottom: -1 }}
          >
            {tab}
          </button>
        );
      })}
    </div>
  );
}

export const inputStyle: CSSProperties = {
  padding: '9px 12px',
  border: `1px solid ${C.borderInput}`,
  borderRadius: R.control,
  fontSize: 13,
  background: C.surface,
  outline: 'none',
  color: C.text,
  fontFamily: FONT,
};

export const selectStyle: CSSProperties = { ...inputStyle, padding: '9px 10px', color: C.bodySoft };

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: S.xs }}>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: C.body }}>{props.label}</span>
      {props.children}
      {props.hint && <span style={{ fontSize: 11.5, color: C.dim }}>{props.hint}</span>}
    </label>
  );
}

export function DefinitionList(props: { items: Array<[string, ReactNode]>; columns?: string }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: props.columns ?? 'max-content 1fr', gap: `${S.sm}px ${S.xl}px`, margin: 0 }}>
      {props.items.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt style={{ color: C.muted, fontSize: 12.5 }}>{key}</dt>
          <dd style={{ margin: 0, color: C.text, fontSize: 12.5 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono(props: { children: ReactNode }) {
  return <code style={{ fontFamily: MONO, fontSize: 12, color: C.bodySoft }}>{props.children}</code>;
}

export function SectionTitle(props: { children: ReactNode }) {
  return <div style={{ fontSize: 12.5, fontWeight: 600, color: C.body, marginBottom: S.sm }}>{props.children}</div>;
}

/**
 * Separates "not wired up" from "empty" and from "broken". An empty console for
 * an unconfigured backend would read as a true statement about the platform.
 */
export function AsyncState(props: { loading: boolean; error?: Error; children: ReactNode }) {
  if (props.loading) {
    return (
      <Panel>
        <span style={{ color: C.muted, fontSize: 13 }}>Loading…</span>
      </Panel>
    );
  }
  if (props.error instanceof NotConfiguredError) {
    return (
      <Panel title="Not configured">
        <p style={{ color: C.muted, margin: 0, fontSize: 13 }}>{props.error.reason}</p>
      </Panel>
    );
  }
  if (props.error) {
    return (
      <Panel title="Unavailable">
        <p style={{ color: C.red, margin: 0, fontSize: 13 }}>{props.error.message}</p>
      </Panel>
    );
  }
  return <>{props.children}</>;
}

export function EmptyState(props: { children: ReactNode }) {
  return <div style={{ padding: `${S.xl}px ${S.lg}px`, color: C.muted, fontSize: 13, textAlign: 'center' }}>{props.children}</div>;
}

/** Run status → tone. Named because it is used on four screens and read at a glance. */
export function runStatusTone(status: string): 'ok' | 'warn' | 'danger' {
  if (status === 'complete') return 'ok';
  if (status === 'partial') return 'warn';
  return 'danger';
}

/** Run status → dot colour, the same mapping in the palette's terms. */
export function runStatusColor(status: string): string {
  if (status === 'complete') return C.greenBright;
  if (status === 'partial') return C.amberBright;
  return C.redBright;
}
