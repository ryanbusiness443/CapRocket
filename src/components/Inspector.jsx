import React from 'react';
import { formatTime } from '../store.js';
import { CAPTION_STYLES, EFFECTS, TRANSITIONS } from '../rocket.js';

function TransitionFields({ clip, dispatch }) {
  const tr = clip.transition;
  const setTr = (patch) => dispatch({ type: 'update', track: 'video', id: clip.id,
    patch: { transition: patch === null ? undefined : { type: 'fade', duration: 0.35, ...tr, ...patch } } });
  return (
    <>
      <label className="field">
        <span>Transition to the next clip</span>
        <select value={tr?.type || 'none'} onChange={(e) => setTr(e.target.value === 'none' ? null : { type: e.target.value })}>
          <option value="none">None (hard cut)</option>
          {Object.entries(TRANSITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {tr && <Slider label="Durée" value={tr.duration ?? 0.35} min={0.1} max={1.5} step={0.05} fmt={(v) => v.toFixed(2) + ' s'} onChange={(duration) => setTr({ duration })} />}
      {tr && <button className="small" onClick={() => dispatch({ type: 'transitionAll', transition: tr })}>Apply to all cuts</button>}
    </>
  );
}

function Num({ label, value, onChange, step = 0.1, min, max }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={Number(value.toFixed(2))} step={step} min={min} max={max}
        onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
    </label>
  );
}

function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01, fmt = (v) => v }) {
  return (
    <label className="field">
      <span>{label} <b>{fmt(value)}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export default function Inspector({ project, selection, dispatch }) {
  const track = selection?.track;
  const list = track === 'video' || track === 'transition' ? project.videoClips : track === 'text' ? project.textClips
    : track === 'audio' ? project.audioClips : track === 'effect' ? project.effects || [] : track === 'caption' ? project.captionClips || [] : [];
  const clip = list.find((c) => c.id === selection?.id);
  const set = (patch) => dispatch({ type: 'update', track, id: clip.id, patch });
  const setP = (patch) => dispatch({ type: 'setProject', patch });
  const media = clip?.mediaId && project.media.find((m) => m.id === clip.mediaId);
  const pct = (v) => `${Math.round(v * 100)}%`;

  return (
    <aside className="panel inspector">
      <div className="panel-title">Propriétés</div>
      {!clip && (
        <div className="fields">
          <div className="info">Project · {project.width}×{project.height} · {project.fps} fps</div>
          <label className="field">
            <span>Captions</span>
            <select value={project.captionStyle?.style || 'karaoke'} onChange={(e) => setP({ captionStyle: { ...project.captionStyle, style: e.target.value } })}>
              {Object.entries(CAPTION_STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <Slider label="Caption size" value={project.captionStyle?.size ?? 1} min={0.6} max={1.8} step={0.05} fmt={(v) => Math.round(v * 100) + '%'}
            onChange={(size) => setP({ captionStyle: { ...project.captionStyle, size } })} />
          <label className="field row"><span>Color boost</span><input type="checkbox" checked={!!project.grade} onChange={(e) => setP({ grade: e.target.checked })} /></label>
          <label className="field row"><span>YouTube loudness (-14 LUFS)</span><input type="checkbox" checked={!!project.loudnorm} onChange={(e) => setP({ loudnorm: e.target.checked })} /></label>
          <label className="field row"><span>Fade in / out</span><input type="checkbox" checked={!!project.fades} onChange={(e) => setP({ fades: e.target.checked })} /></label>
          <label className="field row"><span>Fast draft export</span><input type="checkbox" checked={!!project.draft} onChange={(e) => setP({ draft: e.target.checked })} /></label>
          <button className="small" disabled={!project.captionClips?.length} onClick={async () => {
            const r = await window.api.exportSrt(project);
            if (r.ok) window.api.showInFolder(r.file);
            else if (!r.canceled) alert(r.error);
          }}>Save captions as .srt (for YouTube)</button>
          <div className="empty">Khtar clip f l-timeline bach tbeddel l-propriétés dyalo.</div>
        </div>
      )}

      {clip && track === 'transition' && (
        <div className="fields">
          <div className="info">Cut after “{media?.name}”</div>
          <TransitionFields clip={clip} dispatch={dispatch} />
        </div>
      )}

      {clip && track === 'effect' && (
        <div className="fields">
          <label className="field">
            <span>Effect</span>
            <select value={clip.type} onChange={(e) => set({ type: e.target.value })}>
              {Object.entries(EFFECTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <Slider label="Intensity" value={clip.intensity ?? 1} min={0.3} max={2} step={0.05} fmt={(v) => Math.round(v * 100) + '%'} onChange={(intensity) => set({ intensity })} />
          <Num label="Début (s)" value={clip.start} min={0} onChange={(start) => set({ start: Math.max(0, start) })} />
          <Num label="Durée (s)" value={clip.duration} min={0.05} step={0.05} onChange={(duration) => set({ duration: Math.max(0.05, duration) })} />
        </div>
      )}

      {clip && track === 'caption' && (
        <div className="fields">
          <label className="field">
            <span>Caption</span>
            <textarea rows={2} value={clip.text} onChange={(e) => set({ text: e.target.value })} />
          </label>
          <Num label="Début (s)" value={clip.start} min={0} onChange={(start) => set({ start: Math.max(0, start) })} />
          <Num label="Durée (s)" value={clip.duration} min={0.1} onChange={(duration) => set({ duration: Math.max(0.1, duration) })} />
          <p className="dim">Style for all captions: click an empty spot on the timeline.</p>
        </div>
      )}

      {clip && track === 'text' && (
        <div className="fields">
          <label className="field">
            <span>Texte</span>
            <textarea rows={3} value={clip.text} onChange={(e) => set({ text: e.target.value })} />
          </label>
          <Slider label="Taille" value={clip.size} min={12} max={200} step={1} onChange={(size) => set({ size })} />
          <label className="field row">
            <span>Couleur</span>
            <input type="color" value={clip.color} onChange={(e) => set({ color: e.target.value })} />
          </label>
          <Slider label="Position X" value={clip.x} fmt={pct} onChange={(x) => set({ x })} />
          <Slider label="Position Y" value={clip.y} fmt={pct} onChange={(y) => set({ y })} />
          <Num label="Début (s)" value={clip.start} min={0} onChange={(start) => set({ start: Math.max(0, start) })} />
          <Num label="Durée (s)" value={clip.duration} min={0.1} onChange={(duration) => set({ duration: Math.max(0.1, duration) })} />
          <label className="field row"><span>Pop-in animation</span><input type="checkbox" checked={clip.anim === 'pop'} onChange={(e) => set({ anim: e.target.checked ? 'pop' : undefined })} /></label>
        </div>
      )}

      {clip && track === 'video' && (
        <div className="fields">
          <div className="info">{media?.name}<br /><span className="dim">{media?.width}×{media?.height} · {formatTime(media?.duration ?? 0)}</span></div>
          <Num label="Début source (s)" value={clip.in} min={0} onChange={(v) => set({ in: Math.max(0, Math.min(v, clip.out - 0.1)) })} />
          <Num label="Fin source (s)" value={clip.out} onChange={(v) => set({ out: Math.max(clip.in + 0.1, Math.min(v, media?.duration ?? v)) })} />
          <Slider label="Volume" value={clip.volume ?? 1} max={2} fmt={pct} onChange={(volume) => set({ volume })} />
          <label className="field row">
            <span>Muet</span>
            <input type="checkbox" checked={!!clip.muted} onChange={(e) => set({ muted: e.target.checked })} />
          </label>
          {project.videoClips[project.videoClips.length - 1]?.id !== clip.id && <TransitionFields clip={clip} dispatch={dispatch} />}
        </div>
      )}

      {clip && track === 'audio' && (
        <div className="fields">
          <div className="info">{media?.name}</div>
          <Num label="Début timeline (s)" value={clip.start} min={0} onChange={(start) => set({ start: Math.max(0, start) })} />
          <Slider label="Volume" value={clip.volume ?? 1} max={2} fmt={pct} onChange={(volume) => set({ volume })} />
        </div>
      )}

      <div className="shortcuts dim">
        <b>Raccourcis</b><br />
        Space: play/pause · S / Ctrl+B: split<br />
        Delete: msa7 · Ctrl+Z / Ctrl+Y: undo/redo<br />
        ← →: frame · Shift+← →: 1s
      </div>
    </aside>
  );
}
