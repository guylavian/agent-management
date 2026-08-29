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

/** Containers 3, controls 3, inner elements 2. Nothing is a rounded capsule. */
export const R = { control: 3, container: 3, small: 2 } as const;

export const C = {
  accent: '#1f5fb5',
  accentHover: '#1a5099',
  accentSoft: '#eaf1fa',
  canvas: '#f7f8fa',
  surface: '#ffffff',
  hover: '#f6f7f9',
  border: '#d5d9e0',
  borderInput: '#c9ced8',
  borderStrong: '#aab2c0',
  rule: '#e4e7ec',
  ruleSoft: '#eceef2',
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
  greenSoft: '#e8f3ec',
  amber: '#8a5a00',
  amberBright: '#c58600',
  amberSoft: '#fbf1de',
  red: '#a8202f',
  redBright: '#c8394a',
  redSoft: '#faeaec',
};

export const FONT = "'Figtree',Helvetica,Arial,sans-serif";
export const MONO = 'ui-monospace,Menlo,monospace';

export function Page(props: { children: ReactNode }) {
  return (
    <div style={{ padding: `${S.xl}px ${S.xl}px ${S.xxl}px ${S.xl}px`, maxWidth: 1320, margin: '0 auto', fontFamily: FONT, color: C.text, fontSize: 13 }}>
      {props.children}
    </div>
  );
}

export function PageHeader(props: { title: string; subtitle?: string; action?: ReactNode; tight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: S.lg, marginBottom: props.tight ? S.lg : S.xl }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.2px' }}>{props.title}</div>
        {props.subtitle && <div style={{ fontSize: 13, color: C.muted, marginTop: S.xs }}>{props.subtitle}</div>}
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
    primary: { ...base, background: C.accent, color: C.surface, border: `1px solid ${C.accent}`, padding: '6px 14px', fontSize: 13 },
    secondary: { ...base, background: C.surface, border: `1px solid ${C.borderInput}`, color: C.body, padding: '6px 14px', fontSize: 13 },
    link: { ...base, background: 'none', border: 'none', color: C.accent, fontSize: 13, padding: `${S.xs}px 0` },
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

export function StatGrid(props: { columns?: number; children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${props.columns ?? 6},1fr)`, gap: S.md, marginBottom: S.lg }}>{props.children}</div>;
}

/** Flat surface with an optional titled header rule. */
export function Panel(props: { title?: string; action?: ReactNode; padded?: boolean; children: ReactNode }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.container, overflow: 'hidden' }}>
      {(props.title || props.action) && (
        <div style={{ display: 'flex', alignItems: 'center', padding: `${S.md}px ${S.lg}px`, borderBottom: `1px solid ${C.rule}` }}>
          <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{props.title}</div>
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
export function Section(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <section style={{ borderTop: `1px solid ${C.rule}`, paddingTop: S.lg, marginTop: S.xl }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: props.description ? S.xs : S.md }}>{props.title}</div>
      {props.description && <div style={{ fontSize: 12.5, color: C.muted, marginBottom: S.md, maxWidth: 720 }}>{props.description}</div>}
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
      <div style={{ display: 'grid', gridTemplateColumns: props.columns, gap: S.md, padding: `${S.sm}px ${S.lg}px`, fontSize: 11, fontWeight: 500, letterSpacing: '.4px', textTransform: 'uppercase', color: C.faint, borderBottom: `1px solid ${C.rule}` }}>
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
        padding: `${S.sm}px ${S.lg}px`,
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
  return <div style={{ color: C.muted, fontSize: props.size ?? 12.5, ...(props.mono ? { fontFamily: MONO, fontSize: props.size ?? 12 } : {}) }}>{props.children}</div>;
}

export function Body(props: { mono?: boolean; children: ReactNode }) {
  return <div style={{ color: C.bodySoft, fontSize: props.mono ? 12 : 12.5, ...(props.mono ? { fontFamily: MONO } : {}) }}>{props.children}</div>;
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: S.sm, fontSize: 12.5, color: props.tone === 'neutral' ? C.bodySoft : tone.fg, whiteSpace: 'nowrap' }}>
      {props.dot !== false && <span style={{ width: 7, height: 7, borderRadius: 99, background: tone.dot, flex: 'none' }} />}
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
  padding: '5px 8px',
  border: `1px solid ${C.borderInput}`,
  borderRadius: R.control,
  fontSize: 13,
  background: C.surface,
  outline: 'none',
  color: C.text,
  fontFamily: FONT,
};

export const selectStyle: CSSProperties = { ...inputStyle, padding: '5px 6px', color: C.bodySoft };

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
