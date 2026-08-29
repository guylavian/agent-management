import { useEffect, useRef, useState } from 'react';
import { useAgentActions } from '../api/client';
import { AgentTile, Button, C, Muted, S, StatusPill, selectStyle, tileTone } from './common';
import type { AgentDraft } from '../api/types';

type Avatar = NonNullable<AgentDraft['avatar']>;
type BuiltIn = { id: string; label: string; asset: string; fit: 'cover' | 'contain' };

/** 1 MB, matching what the runtime accepts; the runtime remains the authority. */
const MAX_BYTES = 1_048_576;
const ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * "Agent visual" — the optional image an agent is shown with.
 *
 * Three states, and the third is a real one rather than a gap: an image
 * uploaded here, a built-in icon chosen from the catalog, or nothing at all,
 * in which case the agent renders as initials on its owning team's tone. Most
 * agents will stay in the third state and that is a finished design, not a
 * placeholder.
 *
 * Nothing on this control saves. An upload is held in the draft and travels in
 * the same change-set as the document that references it, so the pull request
 * either brings both or neither.
 */
export function AgentVisual(props: {
  name: string;
  owner: string;
  avatar?: Avatar | null;
  /** what the agent has on disk, so "Remove" can be distinguished from "unchanged" */
  existing?: { asset: string; fit: 'cover' | 'contain' };
  onChange: (next: Avatar | null | undefined) => void;
}) {
  const actions = useAgentActions();
  const file = useRef<HTMLInputElement>(null);
  const [icons, setIcons] = useState<BuiltIn[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    actions.avatarIcons().then(result => setIcons(result.icons)).catch(() => setIcons([]));
    // the catalog is static for a deployment; fetching it once is enough
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removed = props.avatar === null;
  const chosen = props.avatar ?? undefined;
  const showsExisting = chosen === undefined && !removed && props.existing !== undefined;
  const fit = chosen?.fit ?? props.existing?.fit ?? 'contain';

  const onFile = async (chosenFile: File | undefined) => {
    if (chosenFile === undefined) return;
    setError(undefined);
    // the cheap checks first, so an obviously wrong file never leaves the browser
    if (chosenFile.size > MAX_BYTES) {
      setError(`That image is ${Math.round(chosenFile.size / 1024)} KB. The limit is ${MAX_BYTES / 1024} KB.`);
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await chosenFile.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const base64 = btoa(binary);

      // the definitive answer comes from the runtime, which reads the BYTES
      // rather than the name or the type the browser reported
      await actions.validateAvatar(base64);
      setPreview(`data:${chosenFile.type};base64,${base64}`);
      props.onChange({ upload: base64, fit });
    } catch (failure) {
      const body = failure as { message?: string };
      setError(body.message ?? 'That file could not be read as a PNG, JPEG or WebP image.');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };

  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: C.body, marginBottom: 4 }}>Agent visual</div>
      <Muted size={11.5}>Optional. Without one the agent is shown as its initials.</Muted>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: S.lg, marginTop: S.md, flexWrap: 'wrap' }}>
        <Preview name={props.name} owner={props.owner} src={preview} asset={chosen?.asset ?? (showsExisting ? props.existing?.asset : undefined)} agentId={showsExisting ? props.name : undefined} fit={fit} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: S.sm, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: S.sm, flexWrap: 'wrap' }}>
            <input ref={file} type="file" accept={ACCEPT} aria-label="Upload agent image" style={{ display: 'none' }} onChange={event => void onFile(event.target.files?.[0])} />
            <Button variant="secondary" onClick={() => file.current?.click()} disabled={busy}>{busy ? 'Checking…' : 'Upload image'}</Button>
            <Button variant="secondary" onClick={() => setPicking(!picking)}>Choose icon</Button>
            {(chosen !== undefined || showsExisting) && (
              <Button variant="link" onClick={() => { setPreview(undefined); setError(undefined); props.onChange(props.existing === undefined ? undefined : null); }}>Remove</Button>
            )}
          </div>

          <Muted size={11.5}>PNG, JPEG or WebP · up to {MAX_BYTES / 1024} KB · 32–2048 px</Muted>

          <div style={{ display: 'flex', alignItems: 'center', gap: S.sm }}>
            <Muted size={11.5}>Fit</Muted>
            <select
              aria-label="Image fit"
              style={{ ...selectStyle, padding: '5px 8px', fontSize: 12.5 }}
              value={fit}
              disabled={chosen === undefined && !showsExisting}
              onChange={event => {
                const next = event.target.value as 'cover' | 'contain';
                props.onChange(chosen !== undefined ? { ...chosen, fit: next } : props.existing ? { asset: props.existing.asset, fit: next } : undefined);
              }}
            >
              <option value="contain">contain — a product logo</option>
              <option value="cover">cover — fills the tile</option>
            </select>
          </div>

          {removed && <StatusPill tone="warn">Will be removed; the agent falls back to initials.</StatusPill>}
          {error !== undefined && <StatusPill tone="danger">{error}</StatusPill>}
        </div>
      </div>

      {picking && (
        <div style={{ marginTop: S.md, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: S.sm }}>
          {icons.length === 0 && <Muted size={12}>No built-in icons are bundled with this deployment.</Muted>}
          {icons.map(icon => (
            <button
              key={icon.id}
              type="button"
              onClick={() => { setPreview(undefined); props.onChange({ asset: icon.asset, fit: icon.fit }); setPicking(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: S.sm, padding: '8px 10px', cursor: 'pointer',
                border: `1px solid ${chosen?.asset === icon.asset ? C.accent : C.border}`, borderRadius: 8,
                background: chosen?.asset === icon.asset ? C.accentSoft : C.surface, fontSize: 12.5, fontFamily: 'inherit', color: C.body,
              }}
            >
              <span style={{ width: 22, height: 22, borderRadius: 6, background: tileTone(icon.id).bg, flex: 'none' }} />
              {icon.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What the agent will look like.
 *
 * A freshly uploaded file previews from the bytes in the browser, because it is
 * not in Git yet and there is nothing to fetch. Anything already committed is
 * fetched through the same route the console uses everywhere else, so the
 * preview and the real thing cannot disagree.
 */
function Preview({ name, owner, src, asset, agentId, fit }: { name: string; owner: string; src?: string; asset?: string; agentId?: string; fit: 'cover' | 'contain' }) {
  const tone = tileTone(owner || name || 'agent');
  const showing = src ?? (agentId !== undefined ? `/api/agent-management/agents/${encodeURIComponent(agentId)}/avatar` : undefined);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: S.md }}>
      <div style={{ width: 72, height: 72, borderRadius: 10, background: tone.bg, color: tone.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flex: 'none', fontSize: 20, fontWeight: 700 }}>
        {showing !== undefined
          ? <img src={showing} alt="" style={{ width: '100%', height: '100%', objectFit: fit, padding: fit === 'contain' ? 10 : 0, boxSizing: 'border-box' }} />
          : <AgentTile id={name || 'agent'} owner={owner || name || 'agent'} size={72} />}
      </div>
      {asset !== undefined && <Muted size={11.5} mono>{asset}</Muted>}
      {asset === undefined && showing !== undefined && <Muted size={11.5} mono>{`assets/agents/${name || '<name>'}`}</Muted>}
    </div>
  );
}
