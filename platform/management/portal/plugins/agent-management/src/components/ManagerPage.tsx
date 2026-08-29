import { useEffect, useState } from 'react';
import { useAgents, useAgentActions, useManager } from '../api/client';
import {
  AgentTile,
  AsyncState,
  GroupHeader,
  Card,
  Breadcrumb,
  Button,
  C,
  DefinitionList,
  Field,
  MONO,
  Mono,
  Muted,
  Page,
  Panel,
  R,
  SectionTitle,
  StatusPill,
  Tabs,
  inputStyle,
  lifecycleTone,
} from './common';
import type { AgentLifecycle, AgentSummary, ChangePreview, ManagerDetail, ManagerDraft } from '../api/types';

const TABS = ['Routing', 'Prompt', 'Review & Propose'] as const;

/**
 * The Manager, which the console used to omit entirely — it is not in
 * `listSpecialists()`, so the Agents page could never show it, and the one Agent
 * deciding which specialist runs was the one Agent an operator could not see.
 *
 * It gets its own page rather than a row in the Agents table because it is a
 * different document type: no workload identity, no MCP access, no routing
 * vocabulary, and a routing table no specialist has.
 */
export function ManagerPage() {
  const manager = useManager();
  const agents = useAgents();
  const actions = useAgentActions();
  const [tab, setTab] = useState<string>('Routing');
  const [draft, setDraft] = useState<ManagerDraft | undefined>();
  const [preview, setPreview] = useState<ChangePreview | undefined>();
  const [issues, setIssues] = useState<string[]>([]);
  const [pr, setPr] = useState<{ url?: string; status: string; reason?: string } | undefined>();
  const [busy, setBusy] = useState(false);

  // prefill once, from everything the view exposes: a field the draft does not
  // carry is a field a proposed change would silently clear
  useEffect(() => {
    if (manager.value === undefined || draft !== undefined) return;
    const value = manager.value;
    setDraft({
      allowed: value.allowed,
      modelProfile: value.modelProfile,
      prompt: value.prompt,
      owner: value.owner,
      ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
      ...(value.description === undefined ? {} : { description: value.description }),
      lifecycle: value.lifecycle,
      promptFile: value.promptFile,
      execution: { maxAgentsPerRequest: value.execution.maxAgentsPerRequest, timeoutMs: value.execution.timeoutMs },
    });
  }, [manager.value, draft]);

  const patch = (next: Partial<ManagerDraft>) => setDraft(current => (current === undefined ? current : { ...current, ...next }));

  const toggleAgent = (name: string) => {
    setDraft(current => {
      if (current === undefined) return current;
      const allowed = current.allowed.includes(name) ? current.allowed.filter(item => item !== name) : [...current.allowed, name];
      return { ...current, allowed };
    });
  };

  const runPreview = async () => {
    if (draft === undefined) return;
    setBusy(true);
    setIssues([]);
    try {
      setPreview(await actions.previewManager(draft));
    } catch (error) {
      setPreview(undefined);
      const body = error as { issues?: string[]; message?: string };
      setIssues(body.issues ?? [body.message ?? 'Preview failed']);
    } finally {
      setBusy(false);
    }
  };

  const createPr = async () => {
    if (draft === undefined) return;
    setBusy(true);
    try {
      setPr(await actions.createManagerPullRequest(draft));
    } catch (error) {
      setIssues([(error as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Overview', onClick: () => { window.location.href = '/'; } }, { label: 'Manager' }]} />
      <AsyncState loading={manager.loading} error={manager.error}>
        {manager.value && draft && (
          <>
            <Header manager={manager.value} />
            <Tabs tabs={TABS} active={tab} onChange={setTab} />

            {tab === 'Routing' && (
              <RoutingTab
                manager={manager.value}
                draft={draft}
                agents={agents.value ?? []}
                onToggle={toggleAgent}
                onPatch={patch}
              />
            )}

            {tab === 'Prompt' && (
              <Panel title="System prompt">
                <div style={{ marginBottom: 10 }}>
                  <Muted size={12.5}>
                    Source file <Mono>{manager.value.promptFile}</Mono>. This is the body the running Manager loaded, not a copy the console keeps.
                  </Muted>
                </div>
                <textarea
                  value={draft.prompt}
                  onChange={event => patch({ prompt: event.target.value })}
                  spellCheck={false}
                  aria-label="Manager system prompt"
                  style={{ ...inputStyle, width: '100%', minHeight: 380, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7, padding: 14, resize: 'vertical' }}
                />
              </Panel>
            )}

            {tab === 'Review & Propose' && (
              <ReviewTab
                draft={draft}
                manager={manager.value}
                preview={preview}
                issues={issues}
                pr={pr}
                busy={busy}
                onPreview={runPreview}
                onCreate={createPr}
              />
            )}
          </>
        )}
      </AsyncState>
    </Page>
  );
}

function Header({ manager }: { manager: ManagerDetail }) {
  // The fan-out bound is stated against what the Manager can actually reach.
  // "3 of 5" while this environment runs two of them is a true sentence about
  // the document and a false one about the deployment.
  const reachable = manager.allowed.length - (manager.notDeployed ?? []).length;
  const undeployed = (manager.notDeployed ?? []).length;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <AgentTile id={manager.id} owner={manager.owner} size={44} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.5px' }}>{manager.displayName ?? 'Manager'}</div>
            <StatusPill tone={lifecycleTone(manager.lifecycle as AgentLifecycle)}>{manager.lifecycle}</StatusPill>
          </div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>
            Routes every request to at most {manager.execution.maxAgentsPerRequest ?? '—'} of {reachable} reachable specialist
            {reachable === 1 ? '' : 's'}. It calls no tool of its own.
            {undeployed > 0 && (
              <> {manager.allowed.length} are in the routing table
                {manager.environment ? `, but ${manager.environment} does not run ${undeployed} of them` : `, but ${undeployed} are not deployed`}.</>
            )}
          </div>
        </div>
      </div>

      {/*
        * Model, limits and security stated as facts rather than as a KPI strip:
        * none of these is a measurement, they are the Manager's configuration.
        */}
      {/*
        * A strip of stated facts, divided rather than boxed. These are the
        * Manager's configuration, not measurements, so they are read across
        * rather than stacked as cards with numbers in them.
        */}
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: '16px 0' }}>
          <Fact label="Owner" value={manager.owner} note="owning team" first />
          <Fact label="Model profile" value={manager.modelProfile} note={`tier ${manager.modelTier}`} mono />
          <Fact label="Agents per request" value={`${manager.execution.maxAgentsPerRequest ?? '—'} of ${manager.allowed.length}`} note="fan-out bound" />
          <Fact label="Routing timeout" value={`${manager.execution.timeoutMs ?? '—'} ms`} note="time to decide" />
          <Fact label="Rounds" value={String(manager.execution.maxRounds ?? '—')} note="fixed by the schema" />
          <Fact label="Tool access" value="none" note="by design — never receives a tool schema" />
          {/* the reason the RUNTIME gives, not a sentence restated here: if the
              runtime ever changes why, the page changes with it */}
          <Fact label="Workload identity" value="none" note={manager.identity.reason} />
        </div>
      </Card>
    </>
  );
}

function RoutingTab(props: {
  manager: ManagerDetail;
  draft: ManagerDraft;
  agents: AgentSummary[];
  onToggle: (name: string) => void;
  onPatch: (next: Partial<ManagerDraft>) => void;
}) {
  // the union of what the runtime says exists and what the draft currently
  // routes to, so an agent removed in the draft stays visible and re-addable
  const names = [...new Set([...props.agents.map(agent => agent.id), ...props.manager.allowed, ...props.manager.notRouted, ...props.draft.allowed])].sort();
  const byId = new Map(props.agents.map(agent => [agent.id, agent]));
  // Allowed and reachable are different facts. An older runtime sends neither
  // field; an empty list then reads as "everything is deployed", which is the
  // honest thing to say when the runtime has not told us otherwise.
  const notDeployed = props.manager.notDeployed ?? [];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
      <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
        <Panel>
          <GroupHeader title="Routing table" />
          <div style={{ marginBottom: 12 }}>
            <Muted size={12.5}>
              Which specialists a request can reach. Removing one makes it unreachable through the Manager; its own tool access is unchanged.
            </Muted>
          </div>
          {names.map(name => {
            const agent = byId.get(name);
            const on = props.draft.allowed.includes(name);
            const was = props.manager.allowed.includes(name);
            const draftLifecycle = agent !== undefined && agent.lifecycle !== 'active';
            return (
              <label key={name} style={{ display: 'grid', gridTemplateColumns: '20px 1.6fr 1.6fr auto', gap: 12, alignItems: 'center', padding: '11px 2px', borderBottom: `1px solid ${C.rule}`, cursor: 'pointer' }}>
                <input type="checkbox" checked={on} onChange={() => props.onToggle(name)} aria-label={`Route to ${name}`} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <AgentTile id={name} owner={agent?.owner ?? name} size={26} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{agent?.displayName ?? name}</div>
                    <div style={{ fontSize: 11.5, fontFamily: MONO, color: C.faint }}>{name}</div>
                  </div>
                </div>
                {/* the agent's own description, so the row says what routing here
                    would actually reach rather than only that it is permitted */}
                <div style={{ fontSize: 12.5, color: C.bodySoft, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent?.description ?? ''}
                </div>
                <div style={{ textAlign: 'right' }}>
                  {on !== was
                    ? <StatusPill tone={on ? 'ok' : 'warn'}>{on ? 'will be added' : 'will be removed'}</StatusPill>
                    : draftLifecycle
                      ? <StatusPill tone="warn">{agent?.lifecycle} — not routable</StatusPill>
                      : on && notDeployed.includes(name)
                        // Allowed here, but this environment does not run it, so
                        // the Manager is never offered it and cannot reach it.
                        // Saying "Routable" was the whole bug.
                        ? <StatusPill tone="warn">allowed — not deployed{props.manager.environment ? ` in ${props.manager.environment}` : ''}</StatusPill>
                        : on && notDeployed.includes(name)
                        // allowed here, but this environment does not run it, so
                        // the Manager is never offered it. Saying "Routable" was
                        // the whole bug.
                        ? <StatusPill tone="warn">allowed — not deployed{props.manager.environment ? ` in ${props.manager.environment}` : ''}</StatusPill>
                        : <StatusPill tone={on ? 'ok' : 'neutral'}>{on ? 'Routable' : 'Not routed'}</StatusPill>}
                </div>
              </label>
            );
          })}
          {props.draft.allowed.length === 0 && (
            <div style={{ marginTop: 12 }}>
              <StatusPill tone="warn">A Manager that can route nowhere is rejected by the schema.</StatusPill>
            </div>
          )}
        </Panel>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Panel>
          <GroupHeader title="Decision bounds" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Max agents per request" hint="1–3 · enforced by the runtime">
              <input
                type="number"
                min={1}
                max={3}
                style={inputStyle}
                value={props.draft.execution?.maxAgentsPerRequest ?? 3}
                onChange={event => props.onPatch({ execution: { ...props.draft.execution, maxAgentsPerRequest: Number(event.target.value) } })}
              />
            </Field>
            <Field label="Routing timeout (ms)" hint="100–5000 · how long the Manager may take to decide">
              <input
                type="number"
                min={100}
                max={5000}
                style={inputStyle}
                value={props.draft.execution?.timeoutMs ?? 1500}
                onChange={event => props.onPatch({ execution: { ...props.draft.execution, timeoutMs: Number(event.target.value) } })}
              />
            </Field>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.8px', textTransform: 'uppercase', color: C.faint, marginBottom: 8 }}>Fixed by the schema</div>
              <DefinitionList
                items={[
                  ['Rounds', <Mono key="r">1</Mono>],
                  ['Output schema', <Mono key="o">ManagerDecision</Mono>],
                ]}
              />
              <div style={{ marginTop: 8 }}>
                <Muted size={12}>A second Manager loop is a runtime feature, never configuration, so there is no field for it.</Muted>
              </div>
            </div>
          </div>
        </Panel>

        {/*
          * Security stated in the Manager's own terms. Each line is a property
          * of the architecture rather than a setting, which is why none of them
          * is a control.
          */}
        <Panel>
          <GroupHeader title="Security" />
          <Guarantee title="Tool access" value="none — by design" detail="The Manager never receives a tool schema, so there is nothing to grant." />
          <Guarantee title="MCP access" value="none — by design" detail="Specialists hold the MCP credentials; the Manager holds none." />
          <Guarantee title="Read-only orchestration" value="enforced" detail="Routing decisions cannot mutate state." last />
        </Panel>
      </div>
    </div>
  );
}

function Guarantee({ title, value, detail, last }: { title: string; value: string; detail: string; last?: boolean }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: last === true ? 'none' : `1px solid ${C.rule}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: C.green }}>{value}</div>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{detail}</div>
    </div>
  );
}

function Fact({ label, value, note, mono, first }: { label: string; value: string; note: string; mono?: boolean; first?: boolean }) {
  return (
    <div style={{ padding: '0 20px', borderLeft: first === true ? 'none' : `1px solid ${C.rule}` }}>
      <div style={{ fontSize: 11.5, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3, ...(mono ? { fontFamily: MONO, fontSize: 13 } : {}) }}>{value}</div>
      <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2, lineHeight: 1.35 }}>{note}</div>
    </div>
  );
}

function ReviewTab(props: {
  draft: ManagerDraft;
  manager: ManagerDetail;
  preview?: ChangePreview;
  issues: string[];
  pr?: { url?: string; status: string; reason?: string };
  busy: boolean;
  onPreview: () => void;
  onCreate: () => void;
}) {
  const added = props.draft.allowed.filter(name => !props.manager.allowed.includes(name));
  const removed = props.manager.allowed.filter(name => !props.draft.allowed.includes(name));

  return (
    <Panel title="Review & propose">
      <DefinitionList
        items={[
          ['Routes to', props.draft.allowed.join(', ') || 'none'],
          ['Added', added.length === 0 ? 'none' : added.join(', ')],
          ['Removed', removed.length === 0 ? 'none' : removed.join(', ')],
          ['Max per request', String(props.draft.execution?.maxAgentsPerRequest ?? 3)],
          ['Timeout', `${props.draft.execution?.timeoutMs ?? 1500} ms`],
        ]}
      />

      <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
        <Button onClick={props.onPreview} disabled={props.busy}>Preview YAML</Button>
        {/* no Deploy button here either: the Manager changes by merge, like everything else */}
        <Button variant="secondary" onClick={props.onCreate} disabled={props.busy || !props.preview}>Create Pull Request</Button>
      </div>

      {props.issues.length > 0 && (
        <div style={{ marginTop: 16, background: C.redSoft, border: `1px solid ${C.redBright}`, borderRadius: R.control, padding: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: C.red, marginBottom: 4 }}>This change cannot be generated</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: C.red, fontSize: 12.5 }}>
            {props.issues.map(issue => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}

      {props.preview && (
        <div style={{ marginTop: 18 }}>
          <SectionTitle>Files in this change</SectionTitle>
          {props.preview.files.map(file => (
            <div key={file.path} style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.body, marginBottom: 6 }}>{file.path}</div>
              <pre style={{ background: C.canvas, border: `1px solid ${C.rule}`, color: C.text, padding: 12, borderRadius: R.control, overflowX: 'auto', fontSize: 12, margin: 0, fontFamily: MONO, lineHeight: 1.6 }}>{file.contents}</pre>
            </div>
          ))}
          <div style={{ marginTop: 16 }}>
            <SectionTitle>Merging this change will</SectionTitle>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: C.body, lineHeight: 1.8 }}>
              {props.preview.effects.map(effect => <li key={effect}>{effect}</li>)}
            </ul>
          </div>
        </div>
      )}

      {props.pr && (
        <div style={{ marginTop: 16 }}>
          {props.pr.status === 'created' && props.pr.url ? (
            <a href={props.pr.url} style={{ color: C.accent, fontSize: 13 }}>{props.pr.url}</a>
          ) : (
            <StatusPill tone="warn">Not configured: {props.pr.reason}</StatusPill>
          )}
        </div>
      )}
    </Panel>
  );
}
