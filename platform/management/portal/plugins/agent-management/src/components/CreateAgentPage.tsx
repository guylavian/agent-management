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
  Dialog,
  Field,
  FieldGrid,
  MONO,
  ModeBadge,
  Mono,
  Muted,
  Panel,
  R,
  S,
  Section,
  SectionTitle,
  Body,
  StatusPill,
  inputStyle,
  selectStyle,
} from './common';
import type { AgentDraft, ChangePreview } from '../api/types';

const DEFAULT_LIMITS = {
  maxModelTurns: 6,
  maxToolCalls: 6,
  timeoutMs: 120000,
  maxEvidenceItems: 32,
  maxContextTokens: 12000,
};

const TOOL_COLUMNS = '28px 2fr .6fr';
const ACCESS_COLUMNS = '1.4fr .8fr 1.6fr .5fr';

/**
 * The bounds the runtime schema actually enforces (agent-schema
 * specialistExecutionSchema). Stated on the control rather than discovered by
 * submitting: a rejected draft is a slower way to learn the same number.
 */
const LIMIT_BOUNDS: Record<string, { min: number; max: number; unit?: string }> = {
  maxModelTurns: { min: 1, max: 10 },
  maxToolCalls: { min: 1, max: 20 },
  timeoutMs: { min: 1_000, max: 180_000, unit: 'ms' },
  maxEvidenceItems: { min: 1, max: 128 },
  maxContextTokens: { min: 1_000, max: 64_000, unit: 'tokens' },
  maxEvidenceBytes: { min: 4_096, max: 4_194_304, unit: 'bytes' },
  maxRawExcerptBytes: { min: 256, max: 65_536, unit: 'bytes' },
};

const EMPTY_ROUTING = { exactTerms: [], entityPatterns: [], ambiguousTerms: [], capabilities: [], exclusions: [] };

/** Comma-separated list fields: routing vocabulary, roles, cross-domain grants. */
const ROUTING_FIELDS: Array<[keyof typeof EMPTY_ROUTING, string, string]> = [
  ['capabilities', 'Capabilities', 'What this agent can do. Used by the Manager to choose it.'],
  ['exactTerms', 'Exact terms', 'Terms that route here unambiguously.'],
  ['entityPatterns', 'Entity patterns', 'Identifier shapes this agent owns.'],
  ['ambiguousTerms', 'Ambiguous terms', 'Terms that need more context before routing.'],
  ['exclusions', 'Exclusions', 'Terms that must NOT route here.'],
];

/**
 * Create Agent (TDD §24–§30), and — given `agentId` — the edit form.
 *
 * ONE page, not a wizard. An agent is a configuration document, and the person
 * filling this in is reading a spec or an existing agent rather than being led
 * somewhere: paging five screens hid the shape of what was being built, made
 * fields impossible to compare, and put a Next button between an operator and
 * the value they came to change.
 *
 * Editing is the same form prefilled, because a second form would be a second
 * definition of what an Agent is and would be free to drift from this one. The
 * backend already treats a draft naming an existing Agent as an update.
 */
export function CreateAgentPage(props: { agentId?: string }) {
  const servers = useMcpServers();
  const actions = useAgentActions();
  const existing = useAgent(props.agentId ?? '');
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
  const [preview, setPreview] = useState<ChangePreview | undefined>();
  const [issues, setIssues] = useState<string[]>([]);
  const [pr, setPr] = useState<{ url: string; status: string; reason?: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [editingMcp, setEditingMcp] = useState<string | undefined>();
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | undefined>();

  /**
   * Prefill once the Agent arrives. Every field the form can edit is filled
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
  const routing = { ...EMPTY_ROUTING, ...(draft.routing ?? {}) };
  const patchRouting = (key: keyof typeof EMPTY_ROUTING, value: string) => patch({ routing: { ...routing, [key]: splitList(value) } });

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
    setPr(undefined);
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

  /**
   * Ask the platform to draft a prompt from the form as it stands.
   *
   * The context sent is the UNSAVED form, which is the point — the draft
   * describes the agent being built, not the one on disk. On failure the
   * existing prompt is left exactly as it was: a drafting aid that can wipe
   * someone's work when a model is unreachable is worse than no aid.
   */
  const runDraft = async () => {
    setDrafting(true);
    setDraftError(undefined);
    try {
      const result = await actions.draftPrompt({
        name: draft.name,
        ...(draft.displayName ? { displayName: draft.displayName } : {}),
        ...(draft.description ? { description: draft.description } : {}),
        ...(draft.owner ? { owner: draft.owner } : {}),
        ...(draft.routing ? { routing: draft.routing } : {}),
        ...(draft.crossDomainAllowed ? { crossDomainAllowed: draft.crossDomainAllowed } : {}),
        ...(draft.environments ? { environments: draft.environments } : {}),
        requiredRoles: draft.requiredRoles,
        access: draft.access,
        limits,
        ...(prompt.trim() ? { prompt } : {}),
      });
      setPrompt(result.prompt);
    } catch (error) {
      const body = error as { message?: string };
      setDraftError(body.message ?? 'The prompt could not be drafted. Your prompt has not been changed.');
    } finally {
      setDrafting(false);
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

  const editingServer = (servers.value ?? []).find(server => server.id === editingMcp);
  const editing = props.agentId !== undefined;
  // an edit must not be previewed against a half-loaded draft: that draft is a
  // DIFFERENT agent, and every field still blank is a field the change clears
  const waiting = editing && !loaded;

  if (editing && (existing.loading || existing.error)) {
    return (
      <div style={{ width: '100%', boxSizing: 'border-box', padding: 'clamp(20px, 2.2vw, 40px)', maxWidth: 1280, fontFamily: "'Figtree',Helvetica,Arial,sans-serif", color: C.text, fontSize: 13.5 }}>
        <AsyncState loading={existing.loading} error={existing.error}>{null}</AsyncState>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', boxSizing: 'border-box', padding: 'clamp(20px, 2.2vw, 40px) clamp(20px, 2.4vw, 40px) 48px', maxWidth: 1280, fontFamily: "'Figtree',Helvetica,Arial,sans-serif", color: C.text, fontSize: 13.5 }}>
      <Breadcrumb
        items={editing
          ? [{ label: 'Agents', onClick: () => { window.location.href = '/agents'; } }, { label: draft.displayName || draft.name, onClick: () => { window.location.href = `/agents/${props.agentId ?? ''}`; } }, { label: 'Edit' }]
          : [{ label: 'Agents', onClick: () => { window.location.href = '/agents'; } }, { label: 'Create agent' }]}
      />
      <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.2px' }}>{editing ? `Edit ${draft.displayName || draft.name}` : 'Create agent'}</div>
      <div style={{ fontSize: 13, color: C.muted, marginTop: S.xs }}>
        {editing ? 'Changes are proposed as a pull request. Nothing reaches production until it is merged.' : 'A new agent is created with lifecycle draft and proposed as a pull request.'}
      </div>

      <Section icon="general" title="General">
        <FieldGrid>
          {/* the name is the Agent's identity and the root of its workload
              client id, so editing it would not rename this Agent — it would
              propose a second one and leave the first behind */}
          <Field label="Name" hint={editing ? 'Fixed. The workload client id derives from it, so renaming would create a second agent.' : 'Lowercase and hyphens. The workload client id derives from it.'}>
            <input readOnly={editing} style={{ ...inputStyle, fontFamily: MONO, ...(editing ? { background: C.canvas, color: C.muted } : {}) }} value={draft.name} onChange={event => patch({ name: event.target.value })} placeholder="check-point" />
          </Field>
          <Field label="Display name">
            <input style={inputStyle} value={draft.displayName} onChange={event => patch({ displayName: event.target.value })} placeholder="Check Point Agent" />
          </Field>
          <Field label="Owner">
            <input style={inputStyle} value={draft.owner} onChange={event => patch({ owner: event.target.value })} placeholder="network-security" />
          </Field>
          <Field label="Description" hint="Optional. Shown in the agents directory.">
            <input style={inputStyle} value={draft.description ?? ''} onChange={event => patch({ description: event.target.value })} />
          </Field>
        </FieldGrid>
      </Section>

      <Section icon="routing" title="Routing" description="Vocabulary the Manager matches against a request to decide whether this agent should handle it. Comma separated.">
        <FieldGrid>
          {ROUTING_FIELDS.map(([key, label, hint]) => (
            <Field key={key} label={label} hint={hint}>
              <input style={inputStyle} value={routing[key].join(', ')} onChange={event => patchRouting(key, event.target.value)} />
            </Field>
          ))}
          <Field label="Cross-domain agents" hint="Escalation always returns through the Manager.">
            <input style={inputStyle} value={(draft.crossDomainAllowed ?? []).join(', ')} onChange={event => patch({ crossDomainAllowed: splitList(event.target.value) })} placeholder="observability" />
          </Field>
        </FieldGrid>
      </Section>

      <Section icon="model" title="Model and prompt" description="Agents reference a model profile, never a hardcoded model.">
        <FieldGrid>
          <Field label="Model profile">
            <select style={selectStyle} value={draft.modelProfile} onChange={event => patch({ modelProfile: event.target.value })}>
              {['tool-caller', 'manager-router', 'synthesis'].map(profile => <option key={profile} value={profile}>{profile}</option>)}
            </select>
          </Field>
          <Field label="Tier">
            <select style={selectStyle} value={draft.modelTier} onChange={event => patch({ modelTier: event.target.value as 'small' | 'large' })}>
              <option value="small">small</option>
              <option value="large">large</option>
            </select>
          </Field>
        </FieldGrid>
        <div style={{ marginTop: S.md, marginBottom: S.lg }}>
          <DefinitionList
            items={[
              ['Resolved model', <Muted key="r">resolved by the runtime for this environment</Muted>],
              ['Provider', <Muted key="p">configured per environment, no cloud coupling</Muted>],
            ]}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: S.md, marginBottom: S.sm }}>
          <div style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: C.body }}>System prompt</div>
          {/* the draft fills the field the operator still owns: nothing is saved
              and no pull request is opened by this button */}
          <Button variant="secondary" onClick={runDraft} disabled={drafting || !draft.name}>
            {drafting ? 'Drafting…' : prompt.trim() ? 'Improve with AI' : 'Generate with AI'}
          </Button>
          {prompt.trim() !== '' && !drafting && (
            <Button variant="link" onClick={runDraft} disabled={!draft.name}>Regenerate</Button>
          )}
        </div>
        <textarea
          aria-label="System prompt"
          style={{ ...inputStyle, width: '100%', minHeight: 240, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6, resize: 'vertical', boxSizing: 'border-box' }}
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
        />
        <div style={{ fontSize: 11.5, color: C.dim, marginTop: S.xs }}>
          {prompt.trim() ? Math.ceil(prompt.length / 4) : 0} tokens (estimate), saved to config/prompts/{draft.name || '<name>'}.md
        </div>
        {draftError !== undefined && (
          <div style={{ marginTop: S.sm }}><StatusPill tone="danger">{draftError}</StatusPill></div>
        )}
        {prompt.trim().length === 0 && (
          <div style={{ marginTop: S.sm }}><StatusPill tone="warn">A prompt file is required before the agent can start</StatusPill></div>
        )}
      </Section>

      <Section icon="identity" title="Identity and access" description="Every agent gets its own Keycloak workload client. Never a shared credential.">
        <div style={{ marginBottom: S.lg }}>
          <DefinitionList
            items={[
              ['Workload client', <Mono key="i">{clientId}</Mono>],
              ['Authentication', 'service account (confidential client)'],
              ['Token policy', 'short-lived, one MCP audience per token'],
            ]}
          />
        </div>
        {/*
          * One row per MCP server, not seven stacked tables of checkboxes. With
          * seven servers and fifty tools the inline form was most of the page,
          * and the fields that decide what the agent IS sat below it. Picking
          * tools is a focused sub-task, so it gets a focused surface.
          */}
        <AsyncState loading={servers.loading} error={servers.error}>
          <Panel padded={false}>
            <DataTable columns={ACCESS_COLUMNS} head={['MCP server', 'Tools selected', 'Access', '']}>
              {(servers.value ?? []).map(server => {
                const selected = draft.access.find(item => item.mcp === server.id)?.tools.length ?? 0;
                const selectable = server.tools.filter(tool => tool.classification === 'read').length;
                return (
                  <DataRow key={server.id} columns={ACCESS_COLUMNS}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, minWidth: 0 }}>
                      <Body mono>{server.id}</Body>
                      {selected > 0 && <StatusPill tone="ok" dot>granted</StatusPill>}
                    </div>
                    <Body>{selected} of {selectable}</Body>
                    <Muted size={12} mono>{server.expectedAudience}</Muted>
                    <div style={{ textAlign: 'right' }}>
                      <Button variant="secondary" onClick={() => setEditingMcp(server.id)}>Edit</Button>
                    </div>
                  </DataRow>
                );
              })}
            </DataTable>
          </Panel>
        </AsyncState>
      </Section>

      <Section icon="runtime" title="Runtime" description="Budgets the runtime enforces on every invocation. A run that exceeds one stops.">
        {/*
          * These used to sit behind a "Show advanced settings" button. They are
          * the deadline and the fan-out bound of a production workload — on a
          * page read by the engineer who owns that workload, they are not
          * advanced, they are the point.
          */}
        <FieldGrid columns={3}>
          {Object.entries(limits).map(([key, val]) => {
            const bound = LIMIT_BOUNDS[key];
            return (
              <Field key={key} label={key} hint={bound ? `${bound.min.toLocaleString()}–${bound.max.toLocaleString()}${bound.unit ? ` ${bound.unit}` : ''}` : undefined}>
                <input
                  type="number"
                  style={inputStyle}
                  {...(bound ? { min: bound.min, max: bound.max } : {})}
                  value={val}
                  onChange={event => setLimits({ ...limits, [key]: Number(event.target.value) })}
                />
              </Field>
            );
          })}
        </FieldGrid>
      </Section>

      <Section icon="security" title="Security">
        <FieldGrid>
          <Field label="Allowed human roles" hint="Comma separated. All are required (AND).">
            <input style={inputStyle} value={draft.requiredRoles.join(', ')} onChange={event => patch({ requiredRoles: splitList(event.target.value) })} />
          </Field>
          <Field label="Read-only enforcement" hint="Write agents are not supported by the runtime.">
            <input style={{ ...inputStyle, background: C.canvas, color: C.muted }} value="enforced" readOnly />
          </Field>
        </FieldGrid>

        <div style={{ marginTop: S.lg }}>
          <SectionTitle>Effective MCP authorization</SectionTitle>
          {draft.access.length === 0 ? (
            <Muted>No MCP access selected.</Muted>
          ) : (
            <DefinitionList
              items={draft.access.map(entry => [
                entry.mcp,
                <span key={entry.mcp} style={{ display: 'flex', gap: S.md, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  {/* the audience the runtime reports, not the naming rule
                      re-implemented here, which could drift from it */}
                  <Mono>{(servers.value ?? []).find(server => server.id === entry.mcp)?.expectedAudience ?? entry.mcp}</Mono>
                  <Muted size={12}>{entry.tools.join(', ')}</Muted>
                </span>,
              ])}
            />
          )}
        </div>
      </Section>

      <div style={{ display: 'flex', gap: S.sm, alignItems: 'center', marginTop: S.xl, paddingTop: S.lg, borderTop: `1px solid ${C.rule}` }}>
        <Button onClick={runPreview} disabled={busy || waiting}>Review changes</Button>
        {/* deliberately no Deploy button: production changes only through a merged PR */}
        <Button variant="secondary" onClick={createPr} disabled={busy || waiting || !preview}>Create pull request</Button>
        {preview && <Muted size={12}>{preview.files.length} file{preview.files.length === 1 ? '' : 's'} on branch <Mono>{preview.branch}</Mono></Muted>}
      </div>

      {issues.length > 0 && (
        <div style={{ marginTop: S.lg, background: C.redSoft, border: `1px solid ${C.redBright}`, borderRadius: R.control, padding: S.md }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: C.red, marginBottom: S.xs }}>This draft cannot be generated</div>
          <ul style={{ margin: 0, paddingLeft: S.lg, color: C.red, fontSize: 12.5 }}>
            {issues.map(issue => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}

      {preview && (
        <Section icon="general" title="Change set" description={`${preview.title}. Review every file before opening the pull request.`}>
          {preview.files.map(file => (
            <div key={file.path} style={{ marginBottom: S.md }}>
              <div style={{ fontFamily: MONO, fontSize: 12, color: C.body, marginBottom: S.xs }}>{file.path}</div>
              <pre style={{ background: C.canvas, border: `1px solid ${C.rule}`, color: C.text, padding: S.md, borderRadius: R.control, overflowX: 'auto', fontSize: 12, margin: 0, fontFamily: MONO, lineHeight: 1.6 }}>{file.contents}</pre>
            </div>
          ))}
          <SectionTitle>Merging this change will</SectionTitle>
          <ul style={{ margin: 0, paddingLeft: S.lg, fontSize: 12.5, color: C.body, lineHeight: 1.8 }}>
            {preview.effects.map(effect => <li key={effect}>{effect}</li>)}
          </ul>
        </Section>
      )}

      {editingServer && (
        <Dialog
          title={editingServer.id}
          subtitle={`Audience ${editingServer.expectedAudience}. Only read-verified tools can be granted.`}
          onClose={() => setEditingMcp(undefined)}
        >
          <DataTable columns={TOOL_COLUMNS} head={['', 'Tool', 'Access']}>
            {editingServer.tools.map(tool => {
              // UNKNOWN and WRITE are not selectable: fail closed
              const selectable = tool.classification === 'read';
              const checked = draft.access.find(item => item.mcp === editingServer.id)?.tools.includes(tool.name) ?? false;
              return (
                <DataRow key={tool.name} columns={TOOL_COLUMNS}>
                  <input type="checkbox" aria-label={`${editingServer.id} ${tool.name}`} disabled={!selectable} checked={checked} onChange={() => toggleTool(editingServer.id, tool.name)} />
                  <div style={{ fontFamily: MONO, fontSize: 12, color: selectable ? C.bodySoft : C.dim }}>{tool.name}</div>
                  <div><ModeBadge classification={tool.classification} /></div>
                </DataRow>
              );
            })}
          </DataTable>
        </Dialog>
      )}

      {pr && (
        <div style={{ marginTop: S.lg }}>
          {pr.status === 'created' ? (
            <a href={pr.url} style={{ color: C.accent, fontSize: 13 }}>{pr.url}</a>
          ) : (
            <StatusPill tone="warn">Not configured: {pr.reason}</StatusPill>
          )}
        </div>
      )}
    </div>
  );
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
