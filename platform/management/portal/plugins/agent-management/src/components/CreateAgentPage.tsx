import { useEffect, useState } from 'react';
import { useAgent, useAgentActions, useMcpServers } from '../api/client';
import {
  AsyncState,
  Breadcrumb,
  Button,
  C,
  DataRow,
  DataTable,
  DefinitionList,
  Field,
  MONO,
  ModeBadge,
  Mono,
  Muted,
  Panel,
  SectionTitle,
  StatusPill,
  clickable,
  inputStyle,
  selectStyle,
} from './common';
import type { AgentDraft, ChangePreview } from '../api/types';

const STEPS = ['Basics & Routing', 'Intelligence', 'Identity, Knowledge & Tools', 'Security & Runtime', 'Review & Create Change'] as const;

const DEFAULT_LIMITS = {
  maxModelTurns: 6,
  maxToolCalls: 6,
  timeoutMs: 120000,
  maxEvidenceItems: 32,
  maxContextTokens: 12000,
};

const TOOL_COLUMNS = '40px 2fr .7fr';

/**
 * Create Agent wizard (TDD §24–§30), and — given `agentId` — the edit wizard.
 *
 * Editing is the same wizard prefilled from the Agent's detail view, because a
 * second "edit" form would be a second definition of what an Agent is, free to
 * drift from this one. The backend already treats a draft naming an existing
 * Agent as an update, so nothing here decides that.
 */
export function CreateAgentPage(props: { agentId?: string }) {
  const servers = useMcpServers();
  const actions = useAgentActions();
  const existing = useAgent(props.agentId ?? '');
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<AgentDraft>({
    name: '',
    owner: '',
    displayName: '',
    modelTier: 'small',
    modelProfile: 'tool-caller',
    requiredRoles: ['infra-read'],
    crossDomainAllowed: [],
    access: [],
  });
  const [prompt, setPrompt] = useState('');
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [loaded, setLoaded] = useState(false);

  const [advanced, setAdvanced] = useState(false);
  const [preview, setPreview] = useState<ChangePreview | undefined>();
  const [issues, setIssues] = useState<string[]>([]);
  const [pr, setPr] = useState<{ url: string; status: string; reason?: string } | undefined>();
  const [busy, setBusy] = useState(false);

  /**
   * Prefill once the Agent arrives. Every field the wizard can edit is filled
   * from the detail view — a field left at its blank default here is a field
   * the generated document would silently clear.
   */
  useEffect(() => {
    if (props.agentId === undefined || existing.value === undefined || loaded) return;
    const agent = existing.value;
    setDraft({
      name: agent.id,
      owner: agent.owner,
      displayName: agent.displayName,
      ...(agent.description === undefined ? {} : { description: agent.description }),
      lifecycle: agent.lifecycle,
      modelTier: agent.modelTier as AgentDraft['modelTier'],
      modelProfile: agent.modelProfile,
      promptFile: agent.promptFile,
      environments: agent.environments,
      routing: agent.routing,
      requiredRoles: agent.requiredRoles,
      crossDomainAllowed: agent.crossDomainAllowed,
      access: agent.access.filter(entry => entry.allowed).map(entry => ({ mcp: entry.mcp, tools: entry.allowedTools.map(tool => tool.name) })),
    });
    setPrompt(agent.prompt);
    setLimits({ ...DEFAULT_LIMITS, ...agent.limits });
    setLoaded(true);
  }, [props.agentId, existing.value, loaded]);

  const patch = (next: Partial<AgentDraft>) => setDraft(current => ({ ...current, ...next }));
  // the workload client id is derived, never typed: it must match what the runtime expects
  const clientId = draft.name ? `sre-agent-${draft.name}` : 'sre-agent-<agent-name>';

  const toggleTool = (mcp: string, tool: string) => {
    setDraft(current => {
      const entry = current.access.find(item => item.mcp === mcp);
      if (entry === undefined) return { ...current, access: [...current.access, { mcp, tools: [tool] }] };
      const tools = entry.tools.includes(tool) ? entry.tools.filter(item => item !== tool) : [...entry.tools, tool];
      const access = tools.length === 0 ? current.access.filter(item => item.mcp !== mcp) : current.access.map(item => (item.mcp === mcp ? { ...item, tools } : item));
      return { ...current, access };
    });
  };

  /**
   * The prompt and the limits are edited in their own state, so they have to be
   * folded back in here. They were not, which meant the Agent document was
   * generated referencing a prompt file the change never created — the screen
   * said "saved to config/prompts/<name>.md" and nothing was saved.
   */
  const submission = (): AgentDraft => ({ ...draft, prompt, limits });

  const runPreview = async () => {
    setBusy(true);
    setIssues([]);
    try {
      setPreview(await actions.preview(submission()));
    } catch (error) {
      setPreview(undefined);
      const body = error as { issues?: string[]; message?: string };
      setIssues(body.issues ?? [body.message ?? 'Preview failed']);
    } finally {
      setBusy(false);
    }
  };

  const createPr = async () => {
    setBusy(true);
    try {
      setPr(await actions.createPullRequest(submission()));
    } catch (error) {
      setIssues([(error as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  const editing = props.agentId !== undefined;
  // an edit must not be previewed against a half-loaded draft: that draft is a
  // DIFFERENT agent, and every field still blank is a field the change clears
  const waiting = editing && !loaded;

  if (editing && (existing.loading || existing.error)) {
    return (
      <div style={{ padding: '26px 32px 40px 32px', maxWidth: 1060, margin: '0 auto', fontFamily: "'Figtree',Helvetica,Arial,sans-serif", color: C.text, fontSize: 14 }}>
        <AsyncState loading={existing.loading} error={existing.error}>{null}</AsyncState>
      </div>
    );
  }

  return (
    <div style={{ padding: '26px 32px 40px 32px', maxWidth: 1060, margin: '0 auto', fontFamily: "'Figtree',Helvetica,Arial,sans-serif", color: C.text, fontSize: 14 }}>
      <Breadcrumb
        items={editing
          ? [{ label: 'Agents', onClick: () => { window.location.href = '/agents'; } }, { label: draft.displayName || draft.name, onClick: () => { window.location.href = `/agents/${props.agentId ?? ''}`; } }, { label: 'Edit' }]
          : [{ label: 'Agents', onClick: () => { window.location.href = '/agents'; } }, { label: 'Create agent' }]}
      />
      <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.3px', marginBottom: 20 }}>{editing ? `Edit ${draft.displayName || draft.name}` : 'Create Agent'}</div>

      <Stepper step={step} onSelect={setStep} />

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 26 }}>
        {step === 0 && (
          <>
            <StepHeading title="Basics & Routing" subtitle="Identity and ownership of the new specialist." />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 18px', maxWidth: 760 }}>
              {/* the name is the Agent's identity and the root of its workload
                  client id, so editing it would not rename this Agent — it would
                  propose a second one and leave the first behind */}
              <Field label="Agent name" hint={editing ? 'Fixed. The workload client id derives from it, so renaming would create a second Agent.' : 'Machine name · lowercase, hyphens. The workload client id is derived from it.'}>
                <input readOnly={editing} style={{ ...inputStyle, fontFamily: MONO, padding: '9px 12px', fontSize: 13.5, ...(editing ? { background: '#f4f5fa', color: C.body } : {}) }} value={draft.name} onChange={event => patch({ name: event.target.value })} placeholder="check-point" />
              </Field>
              <Field label="Display name">
                <input style={{ ...inputStyle, padding: '9px 12px', fontSize: 13.5 }} value={draft.displayName} onChange={event => patch({ displayName: event.target.value })} placeholder="Check Point Agent" />
              </Field>
              <Field label="Owner / team">
                <input style={{ ...inputStyle, padding: '9px 12px', fontSize: 13.5 }} value={draft.owner} onChange={event => patch({ owner: event.target.value })} placeholder="network-security" />
              </Field>
              <Field label="Allowed cross-domain agents" hint="Comma separated. Escalation always returns through the Manager.">
                <input style={{ ...inputStyle, padding: '9px 12px', fontSize: 13.5 }} value={(draft.crossDomainAllowed ?? []).join(', ')} onChange={event => patch({ crossDomainAllowed: splitList(event.target.value) })} placeholder="observability" />
              </Field>
            </div>
            <div style={{ marginTop: 18 }}>
              <Muted size={12.5}>
                A new agent is created with lifecycle <Mono>draft</Mono>. Routing vocabulary lives in the service registry and is set when the agent is registered with the Manager.
              </Muted>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <StepHeading title="Intelligence" subtitle="Agents reference a model profile, never a hardcoded model." />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 18px', maxWidth: 760, marginBottom: 20 }}>
              <Field label="Model profile">
                <select style={{ ...selectStyle, padding: '9px 12px', fontSize: 13.5 }} value={draft.modelProfile} onChange={event => patch({ modelProfile: event.target.value })}>
                  {['tool-caller', 'manager-router', 'synthesis'].map(profile => <option key={profile} value={profile}>{profile}</option>)}
                </select>
              </Field>
              <Field label="Tier">
                <select style={{ ...selectStyle, padding: '9px 12px', fontSize: 13.5 }} value={draft.modelTier} onChange={event => patch({ modelTier: event.target.value as 'small' | 'large' })}>
                  <option value="small">small</option>
                  <option value="large">large</option>
                </select>
              </Field>
              <Field label="Resolved model">
                <input style={{ ...inputStyle, padding: '9px 12px', fontSize: 13.5, background: C.canvas, color: C.muted }} value="resolved by the runtime for this environment" readOnly />
              </Field>
              <Field label="Provider">
                <input style={{ ...inputStyle, padding: '9px 12px', fontSize: 13.5, background: C.canvas, color: C.muted }} value="configured per environment — no cloud coupling" readOnly />
              </Field>
            </div>
            <Field label="System prompt" hint={`${prompt.trim() ? Math.ceil(prompt.length / 4) : 0} tokens (estimate) · saved to config/prompts/${draft.name || '<name>'}.md`}>
              <textarea style={{ ...inputStyle, minHeight: 200, fontFamily: MONO, lineHeight: 1.55, resize: 'vertical' }} value={prompt} onChange={event => setPrompt(event.target.value)} />
            </Field>
            {prompt.trim().length === 0 && (
              <div style={{ marginTop: 10 }}><StatusPill tone="warn">A prompt file is required before the agent can start</StatusPill></div>
            )}
          </>
        )}

        {step === 2 && (
          <AsyncState loading={servers.loading} error={servers.error}>
            <StepHeading title="Identity, Knowledge & Tools" subtitle="Every agent gets its own Keycloak workload client. Never a shared credential." />
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, marginBottom: 18, background: C.canvas }}>
              <DefinitionList
                items={[
                  ['Create dedicated Keycloak client', <StatusPill tone="ok" key="c">yes — one identity per agent</StatusPill>],
                  ['Client ID', <Mono key="i">{clientId}</Mono>],
                  ['Authentication', 'service account (confidential client)'],
                  ['Token policy', 'short-lived, one MCP audience per token'],
                ]}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {(servers.value ?? []).map(server => {
                const selectedCount = draft.access.find(item => item.mcp === server.id)?.tools.length ?? 0;
                return (
                  <Panel
                    key={server.id}
                    padded={false}
                    title={`${server.id} MCP`}
                    action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Muted size={12}>aud {server.expectedAudience}</Muted>{selectedCount > 0 && <StatusPill tone="ok" dot={false}>{selectedCount} selected</StatusPill>}</div>}
                  >
                    <DataTable columns={TOOL_COLUMNS} head={['', 'TOOL', 'ACCESS']}>
                      {server.tools.map(tool => {
                        // UNKNOWN and WRITE are not selectable: fail closed
                        const selectable = tool.classification === 'read';
                        const checked = draft.access.find(item => item.mcp === server.id)?.tools.includes(tool.name) ?? false;
                        return (
                          <DataRow key={tool.name} columns={TOOL_COLUMNS}>
                            <input type="checkbox" aria-label={`${server.id} ${tool.name}`} disabled={!selectable} checked={checked} onChange={() => toggleTool(server.id, tool.name)} />
                            <div style={{ fontFamily: MONO, fontSize: 12.5, color: selectable ? C.bodySoft : C.dim }}>{tool.name}</div>
                            <div><ModeBadge classification={tool.classification} /></div>
                          </DataRow>
                        );
                      })}
                    </DataTable>
                  </Panel>
                );
              })}
            </div>
          </AsyncState>
        )}

        {step === 3 && (
          <>
            <StepHeading title="Security & Runtime" subtitle="Who may invoke this agent, and the budgets the runtime enforces." />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 18px', maxWidth: 760, marginBottom: 18 }}>
              <Field label="Allowed human roles" hint="Comma separated; all are required (AND).">
                <input style={{ ...inputStyle, padding: '9px 12px', fontSize: 13.5 }} value={draft.requiredRoles.join(', ')} onChange={event => patch({ requiredRoles: splitList(event.target.value) })} />
              </Field>
              <Field label="Read-only enforcement">
                <input style={{ ...inputStyle, padding: '9px 12px', fontSize: 13.5, background: C.canvas, color: C.muted }} value="enforced — write agents are not supported" readOnly />
              </Field>
            </div>

            <SectionTitle>Effective MCP authorization</SectionTitle>
            {draft.access.length === 0 ? (
              <Muted>No MCP access selected.</Muted>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
                {draft.access.map(entry => (
                  <div key={entry.mcp} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{entry.mcp}</strong>
                    <Mono>sre-toolhive:{entry.mcp}</Mono>
                    <Muted size={12.5}>{entry.tools.join(', ')}</Muted>
                  </div>
                ))}
              </div>
            )}

            <Button variant="secondary" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide' : 'Show'} advanced settings</Button>
            {advanced && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 16, marginTop: 16 }}>
                {Object.entries(limits).map(([key, val]) => (
                  <Field key={key} label={key}>
                    <input type="number" style={{ ...inputStyle, padding: '9px 12px', fontSize: 13.5 }} value={val} onChange={event => setLimits({ ...limits, [key]: Number(event.target.value) })} />
                  </Field>
                ))}
              </div>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <StepHeading title="Review & Create Change" subtitle={`${editing ? 'Editing' : 'Creating'} an agent opens a pull request. Nothing reaches production until it is merged.`} />
            <DefinitionList
              items={[
                ['Agent', draft.displayName || draft.name || '—'],
                ['Owner', draft.owner || '—'],
                ['Lifecycle', <Mono key="l">{draft.lifecycle ?? 'draft'}</Mono>],
                ['Model profile', <Mono key="m">{draft.modelProfile}</Mono>],
                ['Workload identity', <Mono key="w">{clientId}</Mono>],
                ['Human roles', draft.requiredRoles.join(', ')],
                ['Cross-domain', (draft.crossDomainAllowed ?? []).join(', ') || 'none'],
                ['MCP resources', draft.access.map(entry => `${entry.mcp} (${entry.tools.length})`).join(', ') || 'none'],
              ]}
            />

            <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
              <Button onClick={runPreview} disabled={busy || waiting}>Preview YAML</Button>
              {/* deliberately no Deploy button: production changes only through a merged PR */}
              <Button variant="secondary" onClick={createPr} disabled={busy || waiting || !preview}>Create Pull Request</Button>
            </div>

            {issues.length > 0 && (
              <div style={{ marginTop: 16, background: C.redSoft, border: `1px solid ${C.redSoft}`, borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.red, marginBottom: 6 }}>This draft cannot be generated</div>
                <ul style={{ margin: 0, paddingLeft: 18, color: C.red, fontSize: 12.5 }}>
                  {issues.map(issue => <li key={issue}>{issue}</li>)}
                </ul>
              </div>
            )}

            {preview && (
              <div style={{ marginTop: 18 }}>
                {/* every file the pull request will contain — an Agent without its
                    prompt and overlay is not a deployable change */}
                <SectionTitle>Files in this change</SectionTitle>
                {preview.files.map(file => (
                  <div key={file.path} style={{ marginBottom: 14 }}>
                    <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.body, marginBottom: 6 }}>{file.path}</div>
                    <pre style={{ background: '#1d2233', color: '#e8eaf5', padding: 18, borderRadius: 10, overflowX: 'auto', fontSize: 12.5, margin: 0, fontFamily: MONO, lineHeight: 1.6 }}>{file.contents}</pre>
                  </div>
                ))}
                <div style={{ marginTop: 16 }}>
                  <SectionTitle>Merging this change will</SectionTitle>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: C.body, lineHeight: 1.8 }}>
                    {preview.effects.map(effect => <li key={effect}>{effect}</li>)}
                  </ul>
                </div>
              </div>
            )}

            {pr && (
              <div style={{ marginTop: 16 }}>
                {pr.status === 'created' ? (
                  <a href={pr.url} style={{ color: C.accent, fontWeight: 700 }}>{pr.url}</a>
                ) : (
                  <StatusPill tone="warn">Not configured: {pr.reason}</StatusPill>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <Button variant="secondary" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>Back</Button>
        <Button onClick={() => setStep(Math.min(STEPS.length - 1, step + 1))} disabled={step === STEPS.length - 1}>Next</Button>
      </div>
    </div>
  );
}

function StepHeading(props: { title: string; subtitle: string }) {
  return (
    <>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>{props.title}</div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>{props.subtitle}</div>
    </>
  );
}

function Stepper(props: { step: number; onSelect: (step: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
      {STEPS.map((label, index) => {
        const done = index < props.step;
        const active = index === props.step;
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, cursor: 'pointer', flex: 'none' }} aria-label={`Go to step ${label}`} {...clickable(() => props.onSelect(index))}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 99,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 800,
                  background: done || active ? C.accent : C.surface,
                  color: done || active ? '#fff' : C.faint,
                  border: `1.5px solid ${done || active ? C.accent : '#cdd2e0'}`,
                }}
              >
                {done ? '✓' : index + 1}
              </div>
              <div style={{ fontSize: 11.5, fontWeight: active ? 700 : 600, color: active ? C.accent : C.faint, whiteSpace: 'nowrap' }}>{label}</div>
            </div>
            {index < STEPS.length - 1 && <div style={{ height: 2, flex: 1, background: done ? C.accent : C.border, margin: '0 8px', marginBottom: 18 }} />}
          </div>
        );
      })}
    </div>
  );
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
