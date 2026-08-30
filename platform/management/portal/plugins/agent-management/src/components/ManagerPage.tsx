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
  ReconciliationBadge,
  blockingSignal,
  inputStyle,
  lifecycleTone,
} from './common';
import type { AgentLifecycle, AgentSummary, ChangePreview, ManagerDetail, ManagerDraft } from '../api/types';

const TABS = ['Routing', 'Prompt', 'Review & Propose'] as const;

/**
 * The Manager view as this console needs it, from whatever the runtime sent.
 *
 * The runtime is a SEPARATE PROCESS on its own release cadence, so the console
 * will meet one that predates a contract change — during a rollout, that is the
 * normal state for minutes at a time. Reading `manager.routable.length` from a
 * response that has no `routable` took the whole page down with a white screen,
 * which is the worst possible way to report "these two are different versions".
 *
 * Absent is NOT rendered as empty: an empty routing table and an unknown one
 * look identical on screen and mean opposite things, so `known` is false and
 * the page says which runtime it is talking to instead of implying the Manager
 * can route nowhere.
 */
interface ManagerView {
  routable: string[];
  notRouted: string[];
  environment: string;
  /** false when the runtime did not send a derived routing table at all */
  known: boolean;
}

export function managerView(manager: ManagerDetail): ManagerView {
  const routable = manager.routable;
  return {
    routable: routable ?? [],
    notRouted: manager.notRouted ?? [],
    environment: manager.environment ?? 'this environment',
    known: Array.isArray(routable),
  };
}

/**
 * The Manager, which the console used to omit entirely — it is not in
 * `listSpecialists()`, so the Agents page could never show it, and the one Agent
 * deciding which specialist runs was the one Agent an operator could not see.
 *
 * It gets its own page rather than a row in the Agents table because it is a
 * different document type: no workload identity, no MCP access and no routing
 * vocabulary.
 *
 * Its routing table is READ-ONLY here, and that is the fix rather than a
 * limitation. It used to be a checkbox list backed by a hand-written
 * `agents.allowed` field, which meant onboarding an Agent took a second pull
 * request against this page that nothing checked anyone had made — and an Agent
 * could sit deployed and healthy while the Manager was never offered it. The
 * table is now DERIVED from each Agent's own lifecycle and deployment overlay,
 * so this page shows who is reachable and where to go to change it.
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
            <Header manager={manager.value} view={managerView(manager.value)} />
            <Tabs tabs={TABS} active={tab} onChange={setTab} />

            {tab === 'Routing' && (
              <RoutingTab
                manager={manager.value}
                view={managerView(manager.value)}
                draft={draft}
                agents={agents.value?.agents ?? []}
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
                view={managerView(manager.value)}
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

function Header({ manager, view }: { manager: ManagerDetail; view: ManagerView }) {
  // The fan-out bound is stated against what the Manager can ACTUALLY reach.
  // `routable` is the effective catalog, so there is no longer a second number
  // ("allowed") that could be larger and read as reachable.
  const reachable = view.routable.length;
  const notRouted = view.notRouted.length;
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
            {view.known ? (
              <>
                Routes every request to at most {manager.execution.maxAgentsPerRequest ?? '—'} of {reachable} reachable specialist
                {reachable === 1 ? '' : 's'} in {view.environment}. It calls no tool of its own.
                {notRouted > 0 && (
                  <> {notRouted} other specialist{notRouted === 1 ? ' exists' : 's exist'} but {notRouted === 1 ? 'is' : 'are'} not enabled here.</>
                )}
              </>
            ) : (
              <>Routes every request to at most {manager.execution.maxAgentsPerRequest ?? '—'} specialists. It calls no tool of its own.</>
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
          <Fact label="Agents per request" value={view.known ? `${manager.execution.maxAgentsPerRequest ?? '—'} of ${reachable}` : String(manager.execution.maxAgentsPerRequest ?? '—')} note="fan-out bound" />
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
  view: ManagerView;
  draft: ManagerDraft;
  agents: AgentSummary[];
  onPatch: (next: Partial<ManagerDraft>) => void;
}) {
  // every specialist the runtime knows about, routable or not: "not shown" and
  // "not reachable" must not look alike
  const names = [...new Set([...props.agents.map(agent => agent.id), ...props.view.routable, ...props.view.notRouted])].sort();
  const byId = new Map(props.agents.map(agent => [agent.id, agent]));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
      <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
        <Panel>
          <GroupHeader title={props.view.known ? `Routing table — ${props.view.environment}` : 'Routing table'} />
          <div style={{ marginBottom: 12 }}>
            <Muted size={12.5}>
              Derived, not authored. An Agent is reachable when its own document is active and this
              environment&rsquo;s deployment overlay enables it — so enabling one is a change to that Agent,
              not to the Manager, and there is no list here that can disagree with what the router uses.
            </Muted>
          </div>
          {names.map(name => {
            const agent = byId.get(name);
            const routable = props.view.routable.includes(name);
            const reconciliation = agent?.reconciliation;
            return (
              <div key={name} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.6fr auto', gap: 12, alignItems: 'center', padding: '11px 2px', borderBottom: `1px solid ${C.rule}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <AgentTile id={name} owner={agent?.owner ?? name} size={26} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{agent?.displayName ?? name}</div>
                    <div style={{ fontSize: 11.5, fontFamily: MONO, color: C.faint }}>{name}</div>
                  </div>
                </div>
                {/* WHY, not just whether. A row that says "Not routed" and nothing
                    else is the state this whole page existed to stop producing. */}
                <div style={{ fontSize: 12.5, color: C.bodySoft, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={reconciliation === undefined ? agent?.description : blockingSignal(reconciliation).detail}>
                  {reconciliation === undefined ? agent?.description ?? '' : routable ? agent?.description ?? '' : blockingSignal(reconciliation).detail}
                </div>
                <div style={{ textAlign: 'right', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
                  {reconciliation !== undefined && <ReconciliationBadge reconciliation={reconciliation} />}
                  <StatusPill tone={props.view.known ? (routable ? 'ok' : 'neutral') : 'neutral'}>
                    {props.view.known ? (routable ? 'Routable' : 'Not routable') : 'Unknown'}
                  </StatusPill>
                </div>
              </div>
            );
          })}
          {/* absent and empty mean opposite things, so they do not share a message */}
          {!props.view.known && (
            <div style={{ marginTop: 12 }}>
              <StatusPill tone="warn">
                This runtime does not report a derived routing table, so reachability is unknown here.
                It predates the change that removed the Manager&rsquo;s hand-written agent list; restart or redeploy it to see this table.
              </StatusPill>
            </div>
          )}
          {props.view.known && props.view.routable.length === 0 && (
            <div style={{ marginTop: 12 }}>
              <StatusPill tone="warn">
                No specialist is enabled in {props.view.environment}, so the Manager can route nowhere.
              </StatusPill>
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
          <Guarantee title="Routing table" value="derived" detail="Enabling an Agent is a change to that Agent, so no edit here can grant reachability." last />
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
  view: ManagerView;
  preview?: ChangePreview;
  issues: string[];
  pr?: { url?: string; status: string; reason?: string };
  busy: boolean;
  onPreview: () => void;
  onCreate: () => void;
}) {
  return (
    <Panel title="Review & propose">
      <DefinitionList
        items={[
          ['Model profile', props.draft.modelProfile],
          ['Max per request', String(props.draft.execution?.maxAgentsPerRequest ?? 3)],
          ['Timeout', `${props.draft.execution?.timeoutMs ?? 1500} ms`],
          // stated on the review step so nobody proposes this expecting it to
          // change reachability, which is what the old routing table did
          ['Routing table', `unchanged — derived from each Agent in ${props.view.environment}`],
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
