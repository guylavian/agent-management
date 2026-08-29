import { useMemo, useState } from 'react';
import { DependencyGraph, DependencyGraphTypes } from '@backstage/core-components';
import { Button, C, MONO, Muted, S, StatusPill } from './common';
import type { RunNode } from '../api/types';

/**
 * The run as a graph you can walk.
 *
 * This is a PROJECTION of the ExecutionEvent parent/child model and nothing
 * more. No layout is stored, no node identity is invented: positions come from
 * dagre at render time, and collapsing a branch changes what is passed to the
 * layout, never the run. Reloading the page rebuilds all of it from the same
 * events.
 *
 * The layout engine is Backstage's own DependencyGraph, which was already a
 * dependency of this app. It brings dagre and d3-zoom — so pan, zoom and the
 * ranked left-to-right layout are not ours to maintain — and lets the node
 * body be any SVG we like, which is the part that had to match this design
 * system rather than a library's.
 *
 * WHAT A NODE MAY SAY. A node shows a type, a name, a status and a short
 * action summary. The summary is the task the Manager assigned or the reason
 * the runtime refused something — an explicit audit line the runtime recorded,
 * never model reasoning, never tool arguments, never a payload.
 */

/** The visual families. Type is carried by the tag and the glyph, never by hue. */
type Family = 'user' | 'manager' | 'specialist' | 'intent' | 'authorization' | 'tool' | 'evidence' | 'handoff' | 'approval' | 'result';

const FAMILY: Record<string, Family> = {
  'user.request': 'user',
  'manager.route': 'manager',
  'followup.route': 'handoff',
  specialist: 'specialist',
  'agent.action': 'intent',
  'tool.request': 'intent',
  'authorization.check': 'authorization',
  'workload.token': 'authorization',
  'toolhive.call': 'tool',
  'write.action': 'tool',
  evidence: 'evidence',
  'domain.escalation': 'handoff',
  'agent.result': 'result',
  synthesis: 'result',
  'run.completed': 'result',
  'approval.requested': 'approval',
  'approval.granted': 'approval',
  retry: 'intent',
  'verify.result': 'result',
  error: 'result',
};

/** A short tag, so the type is readable in words and not only by shape. */
const TAG: Record<Family, string> = {
  user: 'USER',
  manager: 'MANAGER',
  specialist: 'SPECIALIST',
  intent: 'INTENT',
  authorization: 'POLICY',
  tool: 'TOOL',
  evidence: 'EVIDENCE',
  handoff: 'HANDOFF',
  approval: 'APPROVAL',
  result: 'RESULT',
};

/**
 * Status is the only thing that carries colour.
 *
 * green allowed/complete, amber waiting/degraded, red failed/denied, blue the
 * node you have selected, neutral everything merely informational. A palette
 * per node type would be decoration competing with the one signal an operator
 * scans a failed run for.
 */
function tone(node: RunNode, selected: boolean): { stroke: string; fill: string; accent: string } {
  if (selected) return { stroke: C.accent, fill: C.accentSoft, accent: C.accent };
  if (node.status === 'denied' || node.status === 'failed') return { stroke: C.redBright, fill: C.redSoft, accent: C.redBright };
  if (node.status === 'timeout') return { stroke: C.amberBright, fill: C.amberSoft, accent: C.amberBright };
  // an informational step that simply happened stays neutral; only the steps
  // that PRODUCED something are green, or every run is a wall of green
  if (node.kind === 'evidence' || node.kind === 'agent.result' || node.kind === 'run.completed') {
    return { stroke: C.border, fill: C.greenSoft, accent: C.greenBright };
  }
  return { stroke: C.border, fill: C.surface, accent: C.dim };
}

const WIDTH = 248;
const HEIGHT = 68;

interface FlowNode extends DependencyGraphTypes.DependencyNode {
  run: RunNode;
  hidden: number;
  collapsed: boolean;
}

/** Cut to fit the box; SVG will not wrap for us and an overflowing label is worse. */
function fit(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** The one line of substance a node may show, if it has one. */
function actionSummary(node: RunNode): string | undefined {
  if (node.kind === 'specialist') return node.detail;
  if (node.status === 'denied') return node.detail ?? 'denied';
  if (node.kind === 'agent.result' || node.kind === 'run.completed' || node.kind === 'domain.escalation') return node.detail;
  if (node.kind === 'tool.request') return 'requested';
  if (typeof node.metadata?.rationale === 'string') return node.metadata.rationale;
  return undefined;
}

export function RunFlow({ nodes }: { nodes: RunNode[] }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelected] = useState<string | undefined>();
  // remounting the graph makes it re-run its initial fit; there is no imperative
  // handle for that, and a key bump is a great deal less code than reaching in
  const [fitKey, setFitKey] = useState(0);

  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, RunNode[]>();
    for (const node of nodes) {
      if (node.parentId === undefined) continue;
      map.set(node.parentId, [...(map.get(node.parentId) ?? []), node]);
    }
    return map;
  }, [nodes]);

  const { graphNodes, edges } = useMemo(() => {
    const visible: FlowNode[] = [];
    const links: DependencyGraphTypes.DependencyEdge[] = [];

    const descendants = (id: string): number => {
      const kids = childrenOf.get(id) ?? [];
      return kids.reduce((total, kid) => total + 1 + descendants(kid.id), 0);
    };

    const walk = (node: RunNode) => {
      const isCollapsed = collapsed.has(node.id);
      visible.push({ id: node.id, run: node, hidden: isCollapsed ? descendants(node.id) : 0, collapsed: isCollapsed });
      if (node.parentId !== undefined) links.push({ from: node.parentId, to: node.id });
      if (isCollapsed) return;
      for (const child of childrenOf.get(node.id) ?? []) walk(child);
    };

    for (const node of nodes) if (node.parentId === undefined) walk(node);
    return { graphNodes: visible, edges: links };
  }, [nodes, childrenOf, collapsed]);

  const toggle = (id: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const collapseAll = () => setCollapsed(new Set(nodes.filter(node => (childrenOf.get(node.id) ?? []).length > 0 && node.parentId !== undefined).map(node => node.id)));

  const selected = selectedId === undefined ? undefined : byId.get(selectedId);

  const renderNode = ({ node }: DependencyGraphTypes.RenderNodeProps<FlowNode>) => {
    const run = node.run;
    const family = FAMILY[run.kind] ?? 'result';
    const colors = tone(run, run.id === selectedId);
    const summary = actionSummary(run);
    const hasChildren = (childrenOf.get(run.id) ?? []).length > 0;

    return (
      <g style={{ cursor: 'pointer' }} onClick={() => setSelected(run.id === selectedId ? undefined : run.id)}>
        <rect width={WIDTH} height={HEIGHT} rx={10} fill={colors.fill} stroke={colors.stroke} strokeWidth={run.id === selectedId ? 2 : 1} />
        {/* the status accent is a bar, so the state survives being read without colour */}
        <rect width={4} height={HEIGHT} rx={2} fill={colors.accent} />
        <text x={16} y={19} fontFamily={MONO} fontSize={9} letterSpacing="0.6" fill={C.faint}>{TAG[family]}</text>
        <text x={16} y={38} fontFamily="inherit" fontSize={13} fontWeight={550} fill={C.text}>{fit(run.label, 27)}</text>
        {summary !== undefined && (
          <text x={16} y={54} fontFamily="inherit" fontSize={10.5} fill={run.status === 'denied' ? C.red : C.muted}>{fit(summary, 34)}</text>
        )}
        {run.status !== 'ok' && (
          <text x={WIDTH - 12} y={19} textAnchor="end" fontFamily={MONO} fontSize={9} fontWeight={700} fill={colors.accent}>
            {run.status.toUpperCase()}
          </text>
        )}
        {hasChildren && (
          <g onClick={event => { event.stopPropagation(); toggle(run.id); }}>
            <circle cx={WIDTH - 18} cy={HEIGHT - 18} r={10} fill={C.surface} stroke={C.borderStrong} />
            <text x={WIDTH - 18} y={HEIGHT - 14} textAnchor="middle" fontFamily={MONO} fontSize={11} fill={C.bodySoft}>
              {node.collapsed ? `+${node.hidden}` : '−'}
            </text>
          </g>
        )}
      </g>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, marginBottom: S.md, flexWrap: 'wrap' }}>
        <Button variant="secondary" onClick={() => { setCollapsed(new Set()); setFitKey(key => key + 1); }}>Expand all</Button>
        <Button variant="secondary" onClick={collapseAll}>Collapse all</Button>
        <Button variant="secondary" onClick={() => setFitKey(key => key + 1)}>Fit to view</Button>
        {selected && <Button variant="link" onClick={() => setSelected(undefined)}>Clear selection</Button>}
        <div style={{ marginLeft: 'auto' }}><Muted size={12}>Scroll to zoom, drag to pan. Click a node for detail.</Muted></div>
      </div>

      <div style={{ display: 'flex', gap: S.lg, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 12, background: C.canvas, overflow: 'hidden', height: 620 }}>
          <DependencyGraph<FlowNode, {}>
            key={fitKey}
            nodes={graphNodes}
            edges={edges}
            renderNode={renderNode}
            direction={DependencyGraphTypes.Direction.TOP_BOTTOM}
            nodeMargin={22}
            rankMargin={46}
            paddingX={28}
            paddingY={28}
            zoom="enabled"
            style={{ width: '100%', height: '100%' }}
          />
        </div>

        {selected && <NodePanel node={selected} onClose={() => setSelected(undefined)} />}
      </div>

      <div style={{ marginTop: S.md, paddingTop: S.md, borderTop: `1px solid ${C.rule}` }}>
        <Muted size={12}>Run history records decisions and actions, not private model reasoning or raw tool payloads.</Muted>
      </div>
    </div>
  );
}

/** The richer, still-safe view of one event. */
function NodePanel({ node, onClose }: { node: RunNode; onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['Event', node.kind],
    ['Actor', node.actor],
    ['Status', node.status],
    ...(node.agentId ? ([['Agent', node.agentId]] as Array<[string, string]>) : []),
    ...(node.mcp ? ([['Server', node.mcp]] as Array<[string, string]>) : []),
    ...(node.tool ? ([['Tool', node.tool]] as Array<[string, string]>) : []),
    ...(node.round ? ([['Round', String(node.round)]] as Array<[string, string]>) : []),
    ['Started', new Date(node.startedAt).toLocaleTimeString()],
    ...(node.durationMs ? ([['Duration', `${node.durationMs} ms`]] as Array<[string, string]>) : []),
    // metadata is scalar-only by schema, so this cannot render a payload
    ...Object.entries(node.metadata ?? {}).map(([key, value]) => [key, String(value)] as [string, string]),
  ];

  return (
    <aside style={{ width: 320, flex: 'none', border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, padding: S.lg }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: S.sm }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.6px', color: C.faint }}>{TAG[FAMILY[node.kind] ?? 'result']}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginTop: 3, wordBreak: 'break-word' }}>{node.label}</div>
        </div>
        <Button variant="link" onClick={onClose}>Close</Button>
      </div>

      {node.status !== 'ok' && (
        <div style={{ marginTop: S.md }}>
          <StatusPill tone={node.status === 'denied' || node.status === 'failed' ? 'danger' : 'warn'}>{node.status}</StatusPill>
        </div>
      )}

      {node.detail !== undefined && (
        <div style={{ marginTop: S.md, padding: S.md, background: C.canvas, borderRadius: 8, fontSize: 12.5, lineHeight: 1.55, color: node.status === 'denied' ? C.red : C.bodySoft }}>
          {node.detail}
        </div>
      )}

      <dl style={{ margin: `${S.lg}px 0 0`, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '7px 14px', fontSize: 12.5 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt style={{ color: C.muted }}>{label}</dt>
            <dd style={{ margin: 0, color: C.body, fontFamily: label === 'citation' || label === 'Tool' || label === 'Server' ? MONO : 'inherit', wordBreak: 'break-word' }}>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
