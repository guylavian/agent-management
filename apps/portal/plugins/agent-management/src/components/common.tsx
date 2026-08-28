import type { CSSProperties, ReactNode } from 'react';
import { NotConfiguredError } from '../api/client';
import type { AgentLifecycle, ToolClassification } from '../api/types';

/**
 * Design system for the Agent Management portal.
 *
 * Tokens, spacing, type scale and component anatomy follow the product design
 * reference (Agent Management Portal). Styles are plain inline objects so the
 * plugin carries no styling dependency and Backstage's own theme cannot bleed
 * into the product surface.
 */

export const C = {
  accent: '#4f5be7',
  accentHover: '#3f4bd0',
  accentSoft: '#eef0fd',
  canvas: '#f5f6fa',
  surface: '#ffffff',
  hover: '#f8f9fc',
  border: '#e6e8f0',
  borderInput: '#dcdfe9',
  borderStrong: '#b9bfd4',
  rule: '#eceef4',
  ruleSoft: '#f1f2f7',
  chip: '#eceef4',
  text: '#1d2233',
  body: '#374057',
  bodySoft: '#4a5170',
  muted: '#6b7385',
  faint: '#8b93a7',
  dim: '#9aa1b5',
  green: '#12794a',
  greenBright: '#19a15e',
  greenSoft: '#e7f0ec',
  amber: '#946508',
  amberBright: '#e2a306',
  amberSoft: '#fdf1d7',
  red: '#b4283c',
  redBright: '#d24b5e',
  redSoft: '#fbeaec',
  teal: '#0e9384',
};

export const FONT = "'Figtree',Helvetica,Arial,sans-serif";
export const MONO = 'ui-monospace,Menlo,monospace';

/** Page canvas: fixed max width, generous gutters. */
export function Page(props: { children: ReactNode }) {
  return (
    <div style={{ padding: '26px 32px 40px 32px', maxWidth: 1320, margin: '0 auto', fontFamily: FONT, color: C.text, fontSize: 14 }}>
      {props.children}
    </div>
  );
}

export function PageHeader(props: { title: string; subtitle?: string; action?: ReactNode; tight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: props.tight ? 18 : 22 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.3px' }}>{props.title}</div>
        {props.subtitle && <div style={{ fontSize: 13.5, color: C.muted, marginTop: 3 }}>{props.subtitle}</div>}
      </div>
      {props.action}
    </div>
  );
}

export function Breadcrumb(props: { items: Array<{ label: string; onClick?: () => void }> }) {
  return (
    <div style={{ fontSize: 12.5, color: C.faint, marginBottom: 14 }}>
      {props.items.map((item, index) => (
        <span key={item.label}>
          {index > 0 && ' / '}
          {item.onClick ? (
            <span style={{ color: C.accent, fontWeight: 600, cursor: 'pointer' }} onClick={item.onClick}>{item.label}</span>
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
  const base: CSSProperties = { borderRadius: 8, fontWeight: 700, cursor: props.disabled ? 'not-allowed' : 'pointer', opacity: props.disabled ? 0.5 : 1 };
  const styles: Record<string, CSSProperties> = {
    primary: { ...base, background: C.accent, color: C.surface, border: 'none', padding: '9px 16px', fontSize: 13.5 },
    secondary: { ...base, background: C.surface, border: `1px solid ${C.borderInput}`, color: C.body, padding: '8px 15px', fontSize: 13 },
    link: { ...base, background: 'none', border: 'none', color: C.accent, fontSize: 13, padding: '4px 6px' },
  };
  return (
    <button type="button" onClick={props.onClick} disabled={props.disabled} style={styles[variant]}>
      {props.children}
    </button>
  );
}

/** Six-up metric strip on Overview; also used at four-up on Agent detail. */
export function StatCard(props: { label: string; value: ReactNode; sub?: ReactNode; dot?: string; subTone?: 'default' | 'ok' }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: C.muted }}>
        {props.dot && <span style={{ width: 7, height: 7, borderRadius: 99, background: props.dot, flex: 'none' }} />}
        {props.label}
      </div>
      <div style={{ fontSize: 25, fontWeight: 800, marginTop: 6, letterSpacing: '-0.5px' }}>{props.value}</div>
      {props.sub !== undefined && (
        <div style={{ fontSize: 11.5, color: props.subTone === 'ok' ? C.green : C.dim, marginTop: 2, fontWeight: props.subTone === 'ok' ? 600 : 400 }}>{props.sub}</div>
      )}
    </div>
  );
}

export function StatGrid(props: { columns?: number; children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${props.columns ?? 6},1fr)`, gap: 12, marginBottom: 20 }}>{props.children}</div>;
}

/** White surface with an optional titled header rule. */
export function Panel(props: { title?: string; action?: ReactNode; padded?: boolean; children: ReactNode }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      {(props.title || props.action) && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '15px 18px', borderBottom: `1px solid ${C.rule}` }}>
          <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{props.title}</div>
          {props.action}
        </div>
      )}
      <div style={props.padded === false ? undefined : { padding: 18 }}>{props.children}</div>
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
      <div style={{ display: 'grid', gridTemplateColumns: props.columns, gap: 12, padding: '10px 18px', fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: C.faint, borderBottom: `1px solid ${C.rule}` }}>
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
        gap: 12,
        alignItems: 'center',
        padding: '13px 18px',
        borderBottom: `1px solid ${C.ruleSoft}`,
        cursor: props.onClick ? 'pointer' : 'default',
      }}
      onClick={props.onClick}
    >
      {props.children}
    </div>
  );
}

export function Muted(props: { size?: number; mono?: boolean; children: ReactNode }) {
  return <div style={{ color: C.muted, fontSize: props.size ?? 13, ...(props.mono ? { fontFamily: MONO, fontSize: props.size ?? 12.5 } : {}) }}>{props.children}</div>;
}

export function Body(props: { mono?: boolean; children: ReactNode }) {
  return <div style={{ color: C.bodySoft, fontSize: props.mono ? 12.5 : 13, ...(props.mono ? { fontFamily: MONO } : {}) }}>{props.children}</div>;
}

/** Rounded square with initials, used as the agent identifier in lists. */
export function MonoAvatar(props: { label: string; color?: string; size?: number }) {
  const size = props.size ?? 32;
  return (
    <div style={{ width: size, height: size, borderRadius: size > 36 ? 11 : 9, background: props.color ?? C.accent, color: '#fff', fontSize: size > 36 ? 15 : 11.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
      {props.label}
    </div>
  );
}

/** Deterministic avatar colour so an agent keeps the same chip across screens. */
const AVATAR_COLORS = [C.accent, '#0e9384', '#7c5cd6', '#c2683a', '#2f7fd1', '#b4436f'];
export function avatarColor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] as string;
}

export function initials(name: string): string {
  const parts = name.split(/[-\s]/u).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'info';

const TONES: Record<Tone, { bg: string; fg: string; dot: string }> = {
  ok: { bg: C.greenSoft, fg: C.green, dot: C.greenBright },
  warn: { bg: C.amberSoft, fg: C.amber, dot: C.amberBright },
  danger: { bg: C.redSoft, fg: C.red, dot: C.redBright },
  neutral: { bg: C.chip, fg: '#5f6779', dot: C.dim },
  info: { bg: C.accentSoft, fg: C.accent, dot: C.accent },
};

export function StatusPill(props: { tone: Tone; dot?: boolean; children: ReactNode }) {
  const tone = TONES[props.tone];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, lineHeight: '16px', padding: '3px 10px', borderRadius: 999, background: tone.bg, color: tone.fg, whiteSpace: 'nowrap' }}>
      {props.dot !== false && <span style={{ width: 6, height: 6, borderRadius: 99, background: tone.dot, flex: 'none' }} />}
      {props.children}
    </span>
  );
}

export function Chip(props: { mono?: boolean; children: ReactNode }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: C.chip, color: '#5f6779', ...(props.mono ? { fontFamily: MONO } : {}) }}>
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
 */
export function ModeBadge({ classification }: { classification: ToolClassification }) {
  const write = classification === 'write';
  const unknown = classification === 'unknown';
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: 999,
        background: write || unknown ? C.amberSoft : C.greenSoft,
        color: write || unknown ? C.amber : C.green,
        letterSpacing: '.3px',
        whiteSpace: 'nowrap',
      }}
    >
      {classification.toUpperCase()}
    </span>
  );
}

export function Allowed({ value }: { value: boolean }) {
  return <span style={{ color: value ? C.greenBright : '#c9cede', fontWeight: 800, fontSize: 15 }}>{value ? '✓' : '✕'}</span>;
}

export function Toggle(props: { on: boolean; onClick?: () => void; label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      {props.label && <span style={{ fontSize: 12.5, fontWeight: 600, color: C.muted }}>{props.label}</span>}
      <button
        type="button"
        onClick={props.onClick}
        style={{ width: 38, height: 22, borderRadius: 99, background: props.on ? C.accent : '#cdd2e0', position: 'relative', cursor: props.onClick ? 'pointer' : 'default', border: 'none', transition: 'background .15s', flex: 'none', padding: 0 }}
      >
        <span style={{ position: 'absolute', top: 3, left: props.on ? 19 : 3, width: 16, height: 16, borderRadius: 99, background: '#fff', transition: 'left .15s' }} />
      </button>
    </div>
  );
}

export function Tabs(props: { tabs: readonly string[]; active: string; onChange: (tab: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 20, flexWrap: 'wrap' }}>
      {props.tabs.map(tab => {
        const active = tab === props.active;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => props.onChange(tab)}
            style={{ border: 'none', background: 'none', padding: '10px 14px', fontSize: 13.5, fontWeight: active ? 700 : 600, color: active ? C.accent : C.muted, borderBottom: `2px solid ${active ? C.accent : 'transparent'}`, cursor: 'pointer', marginBottom: -1 }}
          >
            {tab}
          </button>
        );
      })}
    </div>
  );
}

export const inputStyle: CSSProperties = {
  padding: '8px 12px',
  border: `1px solid ${C.borderInput}`,
  borderRadius: 8,
  fontSize: 13,
  background: C.surface,
  outline: 'none',
  color: C.text,
  fontFamily: FONT,
};

export const selectStyle: CSSProperties = { ...inputStyle, padding: '8px 10px', color: C.bodySoft };

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: C.body }}>{props.label}</span>
      {props.children}
      {props.hint && <span style={{ fontSize: 11.5, color: C.dim }}>{props.hint}</span>}
    </label>
  );
}

export function SegmentedControl(props: { options: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <div style={{ display: 'flex', background: C.chip, borderRadius: 8, padding: 3, gap: 2 }}>
      {props.options.map(option => {
        const active = option === props.value;
        return (
          <button
            key={option}
            type="button"
            onClick={() => props.onChange(option)}
            style={{ border: 'none', background: active ? C.surface : 'transparent', color: active ? C.text : C.muted, borderRadius: 6, padding: '5px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', boxShadow: active ? '0 1px 2px rgba(29,34,51,.08)' : 'none' }}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function DefinitionList(props: { items: Array<[string, ReactNode]>; columns?: string }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: props.columns ?? 'max-content 1fr', gap: '11px 22px', margin: 0 }}>
      {props.items.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt style={{ color: C.muted, fontSize: 12.5, fontWeight: 600 }}>{key}</dt>
          <dd style={{ margin: 0, color: C.text, fontSize: 13 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono(props: { children: ReactNode }) {
  return <code style={{ fontFamily: MONO, fontSize: 12.5, color: C.bodySoft }}>{props.children}</code>;
}

export function SectionTitle(props: { children: ReactNode }) {
  return <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{props.children}</div>;
}

/**
 * Separates "not wired up" from "empty" and from "broken". An empty console for
 * an unconfigured backend would read as a true statement about the platform.
 */
export function AsyncState(props: { loading: boolean; error?: Error; children: ReactNode }) {
  if (props.loading) {
    return (
      <Panel>
        <span style={{ color: C.muted, fontSize: 13.5 }}>Loading…</span>
      </Panel>
    );
  }
  if (props.error instanceof NotConfiguredError) {
    return (
      <Panel title="Not configured">
        <p style={{ color: C.muted, margin: 0, fontSize: 13.5 }}>{props.error.reason}</p>
      </Panel>
    );
  }
  if (props.error) {
    return (
      <Panel title="Unavailable">
        <p style={{ color: C.red, margin: 0, fontSize: 13.5 }}>{props.error.message}</p>
      </Panel>
    );
  }
  return <>{props.children}</>;
}

export function EmptyState(props: { children: ReactNode }) {
  return <div style={{ padding: '26px 18px', color: C.muted, fontSize: 13.5, textAlign: 'center' }}>{props.children}</div>;
}
