import { useState } from 'react';
import { useAgentActions, useMcpServers } from '../api/client';
import {
  AsyncState,
  Button,
  Card,
  Cell,
  ClassificationBadge,
  Field,
  Grid,
  KeyValue,
  Mono,
  PageShell,
  Pill,
  Row,
  Table,
  inputStyle,
  palette,
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

/** Create Agent wizard (TDD §24–§30). */
export function CreateAgentPage() {
  const servers = useMcpServers();
  const actions = useAgentActions();
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
  const [advanced, setAdvanced] = useState(false);
  const [preview, setPreview] = useState<ChangePreview | undefined>();
  const [issues, setIssues] = useState<string[]>([]);
  const [pr, setPr] = useState<{ url: string; status: string; reason?: string } | undefined>();
  const [busy, setBusy] = useState(false);

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

  const runPreview = async () => {
    setBusy(true);
    setIssues([]);
    try {
      setPreview(await actions.preview({ ...draft, ...(limits ? {} : {}) }));
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
      setPr(await actions.createPullRequest(draft));
    } catch (error) {
      setIssues([(error as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell title="Create Agent" subtitle={STEPS[step]}>
      <Card>
        <ol style={{ display: 'flex', gap: 10, listStyle: 'none', margin: 0, padding: 0, flexWrap: 'wrap' }}>
          {STEPS.map((label, index) => (
            <li key={label}>
              <Pill tone={index === step ? 'ok' : index < step ? 'neutral' : 'neutral'}>{index + 1}. {label}</Pill>
            </li>
          ))}
        </ol>
      </Card>

      {step === 0 && (
        <Card title="Basics & routing">
          <Grid min={280}>
            <Field label="Agent name" hint="lowercase kebab-case; becomes the file name and the workload client id">
              <input style={inputStyle} value={draft.name} onChange={event => patch({ name: event.target.value })} placeholder="check-point" />
            </Field>
            <Field label="Display name">
              <input style={inputStyle} value={draft.displayName} onChange={event => patch({ displayName: event.target.value })} placeholder="Check Point Agent" />
            </Field>
            <Field label="Owner / team">
              <input style={inputStyle} value={draft.owner} onChange={event => patch({ owner: event.target.value })} placeholder="network-security" />
            </Field>
            <Field label="Allowed cross-domain agents" hint="comma separated; the Manager mediates every hand-off">
              <input style={inputStyle} value={(draft.crossDomainAllowed ?? []).join(', ')} onChange={event => patch({ crossDomainAllowed: splitList(event.target.value) })} placeholder="observability" />
            </Field>
          </Grid>
          <p style={{ color: palette.muted, fontSize: 13 }}>
            A new agent is created with lifecycle <Mono>draft</Mono>. Routing vocabulary (terms, capabilities, exclusions) lives in the
            service registry and is set when the agent is registered with the Manager.
          </p>
        </Card>
      )}

      {step === 1 && (
        <Card title="Intelligence">
          <Grid min={280}>
            <Field label="Model profile" hint="agents reference a profile, never a hardcoded model">
              <select style={inputStyle} value={draft.modelProfile} onChange={event => patch({ modelProfile: event.target.value })}>
                {['tool-caller', 'manager-router', 'synthesis'].map(profile => <option key={profile} value={profile}>{profile}</option>)}
              </select>
            </Field>
            <Field label="Tier">
              <select style={inputStyle} value={draft.modelTier} onChange={event => patch({ modelTier: event.target.value as 'small' | 'large' })}>
                <option value="small">small</option>
                <option value="large">large</option>
              </select>
            </Field>
            <Field label="Resolved model">
              <input style={{ ...inputStyle, background: palette.canvas }} value="resolved by the runtime for this environment" readOnly />
            </Field>
            <Field label="Provider">
              <input style={{ ...inputStyle, background: palette.canvas }} value="configured per environment (no cloud coupling)" readOnly />
            </Field>
          </Grid>
          <Field label="System prompt" hint={`${prompt.trim() ? Math.ceil(prompt.length / 4) : 0} tokens (estimate) · saved to prompts/${draft.name || '<name>'}.md`}>
            <textarea style={{ ...inputStyle, minHeight: 180, fontFamily: 'ui-monospace, monospace' }} value={prompt} onChange={event => setPrompt(event.target.value)} />
          </Field>
          {prompt.trim().length === 0 && <p style={{ color: palette.warn, fontSize: 13 }}>A prompt file is required before the agent can start.</p>}
        </Card>
      )}

      {step === 2 && (
        <AsyncState loading={servers.loading} error={servers.error}>
          <Card title="Workload identity">
            <KeyValue
              items={[
                ['Create dedicated Keycloak client', <Pill tone="ok" key="c">yes — one identity per agent</Pill>],
                ['Client ID', <Mono key="i">{clientId}</Mono>],
                ['Authentication', 'service account (confidential client)'],
                ['Token policy', 'short-lived, one MCP audience per token'],
              ]}
            />
          </Card>
          {(servers.value ?? []).map(server => (
            <Card key={server.id} title={`${server.id} MCP`} action={<Pill tone="neutral">aud: {server.expectedAudience}</Pill>}>
              <Table head={['', 'Tool', 'Access']}>
                {server.tools.map(tool => {
                  const selectable = tool.classification === 'read';
                  const checked = draft.access.find(item => item.mcp === server.id)?.tools.includes(tool.name) ?? false;
                  return (
                    <Row key={tool.name}>
                      <Cell>
                        {/* UNKNOWN and WRITE are not selectable: fail closed */}
                        <input type="checkbox" aria-label={`${server.id} ${tool.name}`} disabled={!selectable} checked={checked} onChange={() => toggleTool(server.id, tool.name)} />
                      </Cell>
                      <Cell><Mono>{tool.name}</Mono></Cell>
                      <Cell><ClassificationBadge classification={tool.classification} /></Cell>
                    </Row>
                  );
                })}
              </Table>
            </Card>
          ))}
        </AsyncState>
      )}

      {step === 3 && (
        <Card title="Security & runtime">
          <Grid min={280}>
            <Field label="Allowed human roles" hint="comma separated; all are required (AND)">
              <input style={inputStyle} value={draft.requiredRoles.join(', ')} onChange={event => patch({ requiredRoles: splitList(event.target.value) })} />
            </Field>
            <Field label="Read-only enforcement">
              <input style={{ ...inputStyle, background: palette.canvas }} value="enforced — write agents are not supported" readOnly />
            </Field>
            <Field label="Delegation">
              <input style={{ ...inputStyle, background: palette.canvas }} value="human identity is carried as a signed delegated credential" readOnly />
            </Field>
          </Grid>
          <div style={{ marginTop: 14 }}>
            <Button variant="ghost" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide' : 'Show'} advanced settings</Button>
          </div>
          {advanced && (
            <Grid min={220}>
              {Object.entries(limits).map(([key, val]) => (
                <Field key={key} label={key}>
                  <input type="number" style={inputStyle} value={val} onChange={event => setLimits({ ...limits, [key]: Number(event.target.value) })} />
                </Field>
              ))}
            </Grid>
          )}
          <Card title="Effective MCP authorization">
            {draft.access.length === 0 ? (
              <p style={{ color: palette.muted, margin: 0 }}>No MCP access selected.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {draft.access.map(entry => <li key={entry.mcp}><strong>{entry.mcp}</strong> (aud sre-toolhive:{entry.mcp}): {entry.tools.join(', ')}</li>)}
              </ul>
            )}
          </Card>
        </Card>
      )}

      {step === 4 && (
        <>
          <Card title="Review">
            <KeyValue
              items={[
                ['Agent', draft.displayName || draft.name || '—'],
                ['Owner', draft.owner || '—'],
                ['Lifecycle', 'draft'],
                ['Model profile', draft.modelProfile],
                ['Workload identity', <Mono key="w">{clientId}</Mono>],
                ['Human roles', draft.requiredRoles.join(', ')],
                ['Cross-domain', (draft.crossDomainAllowed ?? []).join(', ') || 'none'],
                ['MCP resources', draft.access.map(entry => `${entry.mcp} (${entry.tools.length} tools)`).join(', ') || 'none'],
              ]}
            />
          </Card>
          <Card title="Generated configuration" action={<Button onClick={runPreview} disabled={busy}>Preview YAML</Button>}>
            {issues.length > 0 && (
              <ul style={{ color: palette.dangerSolid, margin: '0 0 12px', paddingLeft: 18 }}>
                {issues.map(issue => <li key={issue}>{issue}</li>)}
              </ul>
            )}
            {preview ? (
              <>
                <pre style={{ background: palette.canvas, padding: 16, borderRadius: 10, overflowX: 'auto', fontSize: 12.5, margin: 0 }}>{preview.yaml}</pre>
                <p style={{ fontWeight: 600, marginBottom: 6, marginTop: 16 }}>Merging this change will:</p>
                <ul style={{ margin: 0, paddingLeft: 18, color: palette.text, fontSize: 13.5 }}>
                  {preview.effects.map(effect => <li key={effect}>{effect}</li>)}
                </ul>
              </>
            ) : (
              <p style={{ color: palette.muted, margin: 0 }}>Preview the change to see the exact file that will be committed.</p>
            )}
          </Card>
          <Card title="Create change">
            {/* there is deliberately no Deploy button: production changes only through a merged PR */}
            <p style={{ color: palette.muted, fontSize: 13, marginTop: 0 }}>
              Creating an agent opens a pull request. Nothing reaches production until it is reviewed, merged and reconciled by Argo CD.
            </p>
            <Button onClick={createPr} disabled={busy || !preview}>Create Pull Request</Button>
            {pr && (
              <p style={{ marginBottom: 0, marginTop: 12 }}>
                {pr.status === 'created' ? <a href={pr.url} style={{ color: palette.accent }}>{pr.url}</a> : <Pill tone="warn">Not configured: {pr.reason}</Pill>}
              </p>
            )}
          </Card>
        </>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <Button variant="ghost" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>Back</Button>
        <Button onClick={() => setStep(Math.min(STEPS.length - 1, step + 1))} disabled={step === STEPS.length - 1}>Next</Button>
      </div>
    </PageShell>
  );
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
