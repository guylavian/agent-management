import type { ReactNode } from 'react';
import { NotConfiguredError } from '../api/client';
import type { AgentLifecycle, ToolClassification } from '../api/types';

/**
 * Shared presentation primitives.
 *
 * The product look is light, spacious and card-based; Backstage's default
 * chrome stays out of the way. Styles are inline objects rather than a theme
 * package so the plugin has no styling dependency beyond React.
 */

// tokens taken from the Agent Management Portal design reference
export const palette = {
  surface: '#ffffff',
  canvas: '#f8f9fc',
  subtle: '#fbfbfd',
  border: '#e6e8f0',
  borderStrong: '#dcdfe9',
  text: '#1d2233',
  body: '#374057',
  muted: '#6b7385',
  faint: '#8b93a7',
  accent: '#4f5be7',
  accentHover: '#4049b8',
  accentSoft: '#eef0fd',
  ok: '#12794a',
  okBright: '#19a15e',
  okSoft: '#e7f0ec',
  warn: '#946508',
  warnAccent: '#e2a306',
  warnSoft: '#fdf1d7',
  teal: '#0e9384',
  dangerSolid: '#c0384a',
  dangerSoft: '#fdecee',
};

export const FONT = "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
export const MONO = 'ui-monospace, Menlo, monospace';
export const CARD_SHADOW = '0 2px 10px rgba(29,34,51,.06)';

export function Card(props: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section
      style={{
        background: palette.surface,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        padding: 20,
        boxShadow: CARD_SHADOW,
      }}
    >
      {(props.title || props.action) && (
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          {props.title && <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: palette.text }}>{props.title}</h3>}
          {props.action}
        </header>
      )}
      {props.children}
    </section>
  );
}

export function StatTile(props: { label: string; value: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'danger' }) {
  const tone = props.tone ?? 'default';
  const color = tone === 'ok' ? palette.ok : tone === 'warn' ? palette.warn : tone === 'danger' ? palette.dangerSolid : palette.text;
  return (
    <div style={{ background: palette.surface, border: `1px solid ${palette.border}`, borderRadius: 10, padding: '16px 18px', boxShadow: CARD_SHADOW }}>
      <div style={{ fontSize: 12, color: palette.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{props.label}</div>
      <div style={{ fontSize: 26, fontWeight: 650, color, marginTop: 6 }}>{props.value}</div>
    </div>
  );
}

export function Grid(props: { min?: number; gap?: number; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${props.min ?? 220}px, 1fr))`, gap: props.gap ?? 16 }}>
      {props.children}
    </div>
  );
}

export function PageShell(props: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ background: palette.canvas, minHeight: '100%', padding: 28, fontFamily: FONT, color: palette.body }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 22 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 680, color: palette.text }}>{props.title}</h1>
          {props.subtitle && <p style={{ margin: '6px 0 0', color: palette.muted, fontSize: 14 }}>{props.subtitle}</p>}
        </div>
        {props.action}
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>{props.children}</div>
    </div>
  );
}

export function Pill(props: { tone: 'ok' | 'warn' | 'danger' | 'neutral'; children: ReactNode }) {
  const tones = {
    ok: { bg: palette.okSoft, fg: palette.ok },
    warn: { bg: palette.warnSoft, fg: palette.warn },
    danger: { bg: palette.dangerSoft, fg: palette.dangerSolid },
    neutral: { bg: '#f1f2f7', fg: palette.muted },
  } as const;
  const tone = tones[props.tone];
  return (
    <span style={{ background: tone.bg, color: tone.fg, borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {props.children}
    </span>
  );
}

export function LifecycleBadge({ lifecycle }: { lifecycle: AgentLifecycle }) {
  const tone = lifecycle === 'active' ? 'ok' : lifecycle === 'draft' ? 'neutral' : lifecycle === 'disabled' ? 'danger' : 'warn';
  return <Pill tone={tone}>{lifecycle}</Pill>;
}

/**
 * UNKNOWN is rendered as a warning, never as READ. A tool absent from the
 * approved catalog is not selectable, and the operator must be able to see why.
 */
export function ClassificationBadge({ classification }: { classification: ToolClassification }) {
  if (classification === 'read') return <Pill tone="ok">READ</Pill>;
  if (classification === 'write') return <Pill tone="danger">WRITE</Pill>;
  return <Pill tone="warn">UNKNOWN</Pill>;
}

export function Allowed({ value }: { value: boolean }) {
  return <span style={{ color: value ? palette.ok : palette.muted, fontWeight: 700 }}>{value ? '✓' : '✕'}</span>;
}

export function Table(props: { head: string[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <thead>
          <tr>
            {props.head.map(label => (
              <th
                key={label}
                style={{ textAlign: 'left', padding: '10px 12px', color: palette.muted, fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${palette.border}` }}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}

export function Row(props: { children: ReactNode }) {
  return <tr style={{ borderBottom: `1px solid ${palette.border}` }}>{props.children}</tr>;
}

export function Cell(props: { children: ReactNode; align?: 'left' | 'center' }) {
  return <td style={{ padding: '11px 12px', color: palette.text, textAlign: props.align ?? 'left' }}>{props.children}</td>;
}

export function Button(props: { onClick?: () => void; variant?: 'primary' | 'ghost'; disabled?: boolean; children: ReactNode }) {
  const primary = (props.variant ?? 'primary') === 'primary';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        background: primary ? palette.accent : palette.surface,
        color: primary ? '#fff' : palette.text,
        border: `1px solid ${primary ? palette.accent : palette.border}`,
        borderRadius: 8,
        padding: '9px 16px',
        fontSize: 13.5,
        fontWeight: 600,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.55 : 1,
      }}
    >
      {props.children}
    </button>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: palette.text }}>{props.label}</span>
      {props.children}
      {props.hint && <span style={{ fontSize: 12, color: palette.muted }}>{props.hint}</span>}
    </label>
  );
}

export const inputStyle = {
  border: `1px solid ${palette.border}`,
  borderRadius: 8,
  padding: '9px 12px',
  fontSize: 13.5,
  color: palette.text,
  background: palette.surface,
  width: '100%',
} as const;

export function KeyValue(props: { items: Array<[string, ReactNode]> }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '10px 20px', margin: 0 }}>
      {props.items.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt style={{ color: palette.muted, fontSize: 13 }}>{key}</dt>
          <dd style={{ margin: 0, color: palette.text, fontSize: 13.5 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Distinguishes "not wired up" from "empty" and from "broken". Showing an empty
 * console for an unconfigured backend would read as a true statement about the
 * platform, which it is not.
 */
export function AsyncState(props: { loading: boolean; error?: Error; children: ReactNode }) {
  if (props.loading) return <Card><span style={{ color: palette.muted }}>Loading…</span></Card>;
  if (props.error instanceof NotConfiguredError) {
    return (
      <Card title="Not configured">
        <p style={{ color: palette.muted, margin: 0 }}>{props.error.reason}</p>
      </Card>
    );
  }
  if (props.error) {
    return (
      <Card title="Unavailable">
        <p style={{ color: palette.dangerSolid, margin: 0 }}>{props.error.message}</p>
      </Card>
    );
  }
  return <>{props.children}</>;
}

export function Mono(props: { children: ReactNode }) {
  return <code style={{ fontFamily: MONO, fontSize: 12.5, background: palette.canvas, padding: '2px 6px', borderRadius: 6 }}>{props.children}</code>;
}
