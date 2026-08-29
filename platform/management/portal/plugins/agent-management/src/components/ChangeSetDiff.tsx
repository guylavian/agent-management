import { useState } from 'react';
import { C, MONO, Muted, S } from './common';
import type { ChangeSetDiff as Diff, FileDiff } from '../api/types';

/**
 * The change-set, shown the way a pull request shows it.
 *
 * This used to render the whole resulting file, which left the reviewer to
 * find a two-line change inside ninety lines of unchanged YAML — and reviewing
 * these files carefully is the entire safety model, since merging one is how
 * an agent's tool access actually changes.
 *
 * Nothing here computes a diff. The runtime does that against the working tree
 * it can see, and this renders the result. A viewer library was considered and
 * skipped: the maintained React ones bring their own styling system, and the
 * hunks arrive already structured, so what is left is a table.
 */

const STATUS: Record<FileDiff['status'], { letter: string; label: string; color: string }> = {
  added: { letter: 'A', label: 'Added', color: C.green },
  modified: { letter: 'M', label: 'Modified', color: C.amber },
  deleted: { letter: 'D', label: 'Deleted', color: C.red },
  unchanged: { letter: ' ', label: 'Unchanged', color: C.muted },
};

export function ChangeSetDiff({ diff }: { diff: Diff }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: S.md, marginBottom: S.md, fontSize: 13 }}>
        <strong style={{ fontWeight: 600 }}>
          {diff.changed} file{diff.changed === 1 ? '' : 's'} changed
        </strong>
        <span style={{ color: C.green, fontFamily: MONO, fontSize: 12.5 }}>+{diff.additions}</span>
        <span style={{ color: C.red, fontFamily: MONO, fontSize: 12.5 }}>−{diff.deletions}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: S.sm }}>
        {diff.files.map(file => <FilePanel key={file.path} file={file} />)}
      </div>
    </div>
  );
}

/** One file, collapsed to its header until opened. */
function FilePanel({ file }: { file: FileDiff }) {
  // an unchanged file starts closed: it is listed so the reviewer knows it was
  // considered, not because there is anything in it to read
  const [open, setOpen] = useState(file.status !== 'unchanged');
  const status = STATUS[file.status];

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', background: C.surface }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: S.md, width: '100%', textAlign: 'left',
          padding: '10px 14px', border: 'none', background: open ? C.canvas : C.surface,
          borderBottom: open ? `1px solid ${C.border}` : 'none', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <span title={status.label} aria-label={status.label} style={{ fontFamily: MONO, fontWeight: 700, fontSize: 12, color: status.color, width: 12, flex: 'none' }}>
          {status.letter}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {file.path}
        </span>
        {file.binary ? (
          <Muted size={12}>binary</Muted>
        ) : (
          <span style={{ display: 'flex', gap: S.sm, fontFamily: MONO, fontSize: 12 }}>
            <span style={{ color: C.green }}>+{file.additions}</span>
            <span style={{ color: C.red }}>−{file.deletions}</span>
          </span>
        )}
      </button>

      {open && (
        file.binary ? (
          <div style={{ padding: '12px 14px' }}>
            <Muted size={12.5}>Binary file. It is part of this change, but there is no line-by-line view of it.</Muted>
          </div>
        ) : file.hunks.length === 0 ? (
          <div style={{ padding: '12px 14px' }}><Muted size={12.5}>No changes.</Muted></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {file.hunks.map((hunk, index) => (
              <div key={hunk.header}>
                {/*
                  * The gap between hunks is a real part of the reading: it says
                  * lines were skipped, rather than implying the file is short.
                  */}
                <div style={{ padding: '4px 14px', background: C.accentSoft, color: C.accent, fontFamily: MONO, fontSize: 11.5, borderTop: index === 0 ? 'none' : `1px solid ${C.border}` }}>
                  {hunk.header}
                </div>
                {hunk.lines.map((line, lineIndex) => (
                  <Line key={`${hunk.header}:${lineIndex}`} line={line} />
                ))}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

const TONE = {
  add: { background: '#e6ffec', gutter: '#ccffd8', marker: '+', color: C.text },
  remove: { background: '#ffebe9', gutter: '#ffd7d5', marker: '−', color: C.text },
  context: { background: C.surface, gutter: C.surface, marker: ' ', color: C.bodySoft },
} as const;

/**
 * One line, with both line numbers.
 *
 * Colour is not the only signal: every row carries its `+` or `−` in the
 * gutter, so the diff is still readable without colour and to anyone who
 * cannot distinguish these greens and reds.
 */
function Line({ line }: { line: FileDiff['hunks'][number]['lines'][number] }) {
  const tone = TONE[line.kind];
  const number = (value: number | undefined) => (
    <span style={{ display: 'inline-block', width: 40, textAlign: 'right', paddingRight: 10, color: C.dim, userSelect: 'none', flex: 'none' }}>
      {value ?? ''}
    </span>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', background: tone.background, fontFamily: MONO, fontSize: 12, lineHeight: '20px', whiteSpace: 'pre' }}>
      <span style={{ display: 'flex', background: tone.gutter, flex: 'none' }}>
        {number(line.before)}
        {number(line.after)}
      </span>
      <span style={{ width: 18, textAlign: 'center', color: line.kind === 'add' ? C.green : line.kind === 'remove' ? C.red : C.dim, userSelect: 'none', flex: 'none' }}>
        {tone.marker}
      </span>
      <span style={{ color: tone.color, paddingRight: 14 }}>{line.text === '' ? ' ' : line.text}</span>
    </div>
  );
}
