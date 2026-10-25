import React, { useEffect, useState } from 'react';
import { CAPTION_STYLES, STYLES } from '../rocket.js';
import { formatTime } from '../store.js';

// ---------------------------------------------------------------- shared bits
function Modal({ title, children, onClose, wide }) {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal rocket ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          {onClose && <button className="ghost" onClick={onClose} title="Close">✕</button>}
        </div>
        {children}
      </div>
    </div>
  );
}

function Progress({ step, progress }) {
  return (
    <div className="rocket-progress">
      <div className="step">{step || 'Starting…'}</div>
      <div className="progress"><div style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div>
    </div>
  );
}

function useRocketProgress(active) {
  const [p, setP] = useState({ step: '', progress: 0 });
  useEffect(() => {
    if (!active) return undefined;
    setP({ step: '', progress: 0 });
    return window.api.onRocketProgress(setP);
  }, [active]);
  return p;
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <em>{hint}</em>}</span>
    </label>
  );
}

function Copy({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="small" onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); })}>
      {ok ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

// ---------------------------------------------------------------- Auto Edit
export function AutoEditDialog({ project, onClose, onApply, onShorts, onPack }) {
  const videos = project.media.filter((m) => m.type === 'video');
  const [o, setO] = useState({
    mediaId: project.autoEdit?.sourceMediaId || project.videoClips[0]?.mediaId || videos[0]?.id || '',
    style: 'crazy', cut: 'dead', minGap: 1.2, transitions: true, effects: true, sfx: true,
    captionsFile: null, captionStyle: 'karaoke', fillers: null, hook: '', shorts: 3, shortLen: 30,
  });
  const [captions, setCaptions] = useState(null);
  const [fillers, setFillers] = useState(null);
  const [phase, setPhase] = useState('setup'); // setup | running | done | error
  const [result, setResult] = useState(null);
  const prog = useRocketProgress(phase === 'running');
  const set = (patch) => setO((x) => ({ ...x, ...patch }));

  const run = async () => {
    setPhase('running');
    const res = await window.api.autoEdit(project, { ...o, captionsFile: captions?.path || null, fillers: fillers?.spans || null });
    if (!res.ok) {
      setResult(res);
      return setPhase('error');
    }
    onApply(res.project);
    setResult(res);
    setPhase('done');
  };

  if (!videos.length) {
    return (
      <Modal title="⚡ Auto Edit" onClose={onClose}>
        <p>Import a gameplay video first (Media → + Import), then come back here.</p>
        <div className="modal-actions"><button className="primary" onClick={onClose}>OK</button></div>
      </Modal>
    );
  }

  if (phase === 'running') {
    return (
      <Modal title="⚡ Auto Edit">
        <Progress {...prog} />
        <p className="dim">Long videos take a little while: the whole file is listened to and watched once.</p>
      </Modal>
    );
  }

  if (phase === 'error') {
    return (
      <Modal title="Auto Edit failed" onClose={onClose}>
        <pre className="error">{result?.error}</pre>
        <div className="modal-actions"><button onClick={() => setPhase('setup')}>Back</button></div>
      </Modal>
    );
  }

  if (phase === 'done') {
    const r = result.report;
    return (
      <Modal title="⚡ Auto Edit done" onClose={onClose}>
        <div className="stats">
          <div><b>{formatTime(r.originalSeconds).slice(0, 5)}</b><span>original</span></div>
          <div><b>{formatTime(r.editedSeconds).slice(0, 5)}</b><span>edited</span></div>
          <div><b>{r.removedSeconds}s</b><span>dead air cut</span></div>
          <div><b>{r.transitions}</b><span>transitions</span></div>
          <div><b>{r.effects}</b><span>effects</span></div>
          <div><b>{r.sfx}</b><span>sound effects</span></div>
          <div><b>{r.captions}</b><span>captions</span></div>
          <div><b>{r.highlights.length}</b><span>highlights</span></div>
        </div>
        {r.fillersRemoved > 0 && <p className="dim">{r.fillersRemoved} filler words cut.</p>}
        <p className="dim">Everything is on the timeline: tweak any clip, transition, effect or caption, then Export MP4. Ctrl+Z undoes the whole Auto Edit.</p>
        <div className="modal-actions">
          <button onClick={onPack}>✨ YouTube pack</button>
          <button onClick={onShorts}>🎬 Make Shorts</button>
          <button className="primary" onClick={onClose}>Open the edit</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="⚡ Auto Edit" onClose={onClose} wide>
      <div className="rocket-grid">
        <section>
          <label className="field">
            <span>Video to edit</span>
            <select value={o.mediaId} onChange={(e) => set({ mediaId: e.target.value })}>
              {videos.map((m) => <option key={m.id} value={m.id}>{m.name} ({formatTime(m.duration).slice(0, 5)})</option>)}
            </select>
          </label>

          <div className="field"><span>Style</span></div>
          <div className="style-cards">
            {Object.entries(STYLES).map(([k, s]) => (
              <button key={k} className={`style-card ${o.style === k ? 'on' : ''}`} onClick={() => set({ style: k })}>
                <b>{s.label}</b><span>{s.blurb}</span>
              </button>
            ))}
          </div>

          <label className="field">
            <span>Cut</span>
            <select value={o.cut} onChange={(e) => set({ cut: e.target.value })}>
              <option value="dead">Dead air: quiet and nothing moving (best for gaming)</option>
              <option value="silence">Silences only (talking videos)</option>
              <option value="off">Don't cut anything</option>
            </select>
          </label>
          {o.cut !== 'off' && (
            <label className="field">
              <span>Shortest pause to cut <b>{o.minGap.toFixed(1)} s</b></span>
              <input type="range" min="0.5" max="4" step="0.1" value={o.minGap} onChange={(e) => set({ minGap: Number(e.target.value) })} />
            </label>
          )}
          <Toggle label="Transitions on the cuts" checked={o.transitions} onChange={(v) => set({ transitions: v })} />
          <Toggle label="Effects on highlights" hint="glitch, flash, shake, trails" checked={o.effects} onChange={(v) => set({ effects: v })} />
          <Toggle label="Sound effects" hint="whoosh, riser, boom — made on your PC" checked={o.sfx} onChange={(v) => set({ sfx: v })} />
        </section>

        <section>
          <div className="field"><span>Captions</span></div>
          <div className="row-gap">
            <button onClick={async () => setCaptions(await window.api.pickCaptions())}>{captions ? '✓ ' + captions.name : 'Add .srt captions…'}</button>
            {captions && <button className="ghost" onClick={() => setCaptions(null)}>Remove</button>}
          </div>
          <p className="hint">{captions ? `${captions.count} lines. They also help find the hype moments ("no way", "let's go"…).`
            : 'Use YouTube auto-captions, Descript or CapCut .srt. Um / uh are removed automatically.'}</p>
          {captions && (
            <label className="field">
              <span>Caption style</span>
              <select value={o.captionStyle} onChange={(e) => set({ captionStyle: e.target.value })}>
                {Object.entries(CAPTION_STYLES).filter(([k]) => k !== 'off').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span>Hook title for the first 3 seconds (optional)</span>
            <input type="text" placeholder="He did WHAT?!" value={o.hook} onChange={(e) => set({ hook: e.target.value })} />
          </label>
          <div className="two">
            <label className="field">
              <span>Highlights to find</span>
              <select value={o.shorts} onChange={(e) => set({ shorts: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Short length</span>
              <select value={o.shortLen} onChange={(e) => set({ shortLen: Number(e.target.value) })}>
                {[15, 30, 45, 60].map((n) => <option key={n} value={n}>{n} s</option>)}
              </select>
            </label>
          </div>
          <details>
            <summary>Advanced: cut filler words</summary>
            <p className="hint">A .json list of [start, end] times to cut, e.g. filler words exported from Descript.</p>
            <button onClick={async () => setFillers(await window.api.pickFillers())}>{fillers ? `✓ ${fillers.name} (${fillers.spans.length})` : 'Add filler list…'}</button>
          </details>
        </section>
      </div>
      <div className="modal-actions">
        <span className="dim">Replaces the current timeline (Ctrl+Z to undo).</span>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={run} disabled={!o.mediaId}>⚡ Auto Edit</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Shorts
export function ShortsDialog({ project, pack, onClose }) {
  const a = project.autoEdit;
  const [hooks, setHooks] = useState(() => (a?.highlights || []).map((_, i) => pack?.hooks?.[i] || ''));
  const [layout, setLayout] = useState('crop45');
  const [replay, setReplay] = useState(true);
  const [count, setCount] = useState(a?.highlights?.length || 0);
  const [phase, setPhase] = useState('setup');
  const [res, setRes] = useState(null);
  const prog = useRocketProgress(phase === 'running');

  if (!a) {
    return (
      <Modal title="🎬 Shorts" onClose={onClose}>
        <p>Run ⚡ Auto Edit first: it finds the highlights the Shorts are made from.</p>
        <div className="modal-actions"><button className="primary" onClick={onClose}>OK</button></div>
      </Modal>
    );
  }
  const go = async () => {
    setPhase('running');
    const r = await window.api.renderShorts(project, { hooks, layout, replay, count });
    if (r.canceled) return setPhase('setup');
    setRes(r);
    setPhase('done');
  };
  if (phase === 'running') return <Modal title="🎬 Making Shorts"><Progress {...prog} /></Modal>;
  if (phase === 'done') {
    return (
      <Modal title={res.ok ? '🎬 Shorts ready' : 'Shorts failed'} onClose={onClose}>
        {res.ok ? <ul className="files">{res.files.map((f) => <li key={f}>{f}</li>)}</ul> : <pre className="error">{res.error}</pre>}
        <div className="modal-actions">
          {res.folder && <button onClick={() => window.api.openFolder(res.folder)}>Open folder</button>}
          <button className="primary" onClick={onClose}>OK</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="🎬 Make Shorts (9:16)" onClose={onClose} wide>
      <p className="dim">One Short per highlight, with a bouncing hook, captions, a zoom punch on the peak and a slow-mo replay.</p>
      <div className="hooks">
        {a.highlights.slice(0, count).map((h, i) => (
          <label key={i} className="field">
            <span>Short {i + 1} · peak at {formatTime(h.peak).slice(0, 5)} in the source</span>
            <input type="text" placeholder="Hook text, e.g. HE DID WHAT?!" value={hooks[i] || ''}
              onChange={(e) => setHooks((x) => x.map((v, k) => (k === i ? e.target.value : v)))} />
          </label>
        ))}
      </div>
      <div className="two">
        <label className="field">
          <span>How many</span>
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {a.highlights.map((_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Framing</span>
          <select value={layout} onChange={(e) => setLayout(e.target.value)}>
            <option value="crop45">Gameplay over blurred background</option>
            <option value="crop916">Full-height crop</option>
          </select>
        </label>
      </div>
      <Toggle label="Slow-mo replay at the end" checked={replay} onChange={setReplay} />
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={go}>Render Shorts…</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- YouTube pack
export function PackDialog({ project, pack, onPack, onClose, onSettings }) {
  const [settings, setSettings] = useState(null);
  const [game, setGame] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [thumb, setThumb] = useState(pack?.thumbnailText || '');
  useEffect(() => {
    window.api.getSettings().then((s) => { setSettings(s); setGame(s.game || ''); });
  }, []);
  useEffect(() => { if (pack?.thumbnailText) setThumb(pack.thumbnailText); }, [pack]);

  const generate = async () => {
    setBusy(true);
    setErr('');
    const r = await window.api.youtubePack(project, { game, notes });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onPack(r.pack);
  };
  const tags = pack?.tags?.join(', ') || '';

  return (
    <Modal title="✨ YouTube pack" onClose={onClose} wide>
      <div className="two">
        <label className="field"><span>Game</span><input type="text" value={game} placeholder="Fortnite, Valorant…" onChange={(e) => setGame(e.target.value)} /></label>
        <label className="field"><span>Notes for the writer (optional)</span><input type="text" value={notes} placeholder="1v4 clutch in ranked" onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      <div className="row-gap">
        <button className="primary" onClick={generate} disabled={busy}>{busy ? 'Writing…' : pack ? 'Write again' : 'Write titles, description & tags'}</button>
        <span className="dim">
          {settings?.hasKey ? 'Written by Claude with your API key.' : 'Using templates. '}
          {!settings?.hasKey && <a href="#" onClick={(e) => { e.preventDefault(); onSettings(); }}>Add a Claude API key</a>}
        </span>
      </div>
      {err && <pre className="error">{err}</pre>}
      {!project.autoEdit && <p className="hint">Tip: run ⚡ Auto Edit first so chapters and hooks come from your highlights.</p>}
      {pack && (
        <div className="pack">
          <div className="pack-block">
            <div className="pack-head"><b>Titles</b></div>
            {pack.titles.map((t) => <div key={t} className="pack-line"><span>{t}</span><Copy text={t} /></div>)}
          </div>
          <div className="pack-block">
            <div className="pack-head"><b>Description + chapters</b><Copy text={pack.description} /></div>
            <pre className="pack-text">{pack.description}</pre>
          </div>
          <div className="pack-block">
            <div className="pack-head"><b>Tags</b><Copy text={tags} /></div>
            <div className="pack-text">{tags}</div>
          </div>
          <div className="pack-block">
            <div className="pack-head"><b>Hooks for the Shorts</b></div>
            <div className="pack-text">{pack.hooks.join(' · ')}</div>
          </div>
          <div className="pack-block">
            <div className="pack-head"><b>Thumbnail</b></div>
            <div className="row-gap">
              <input type="text" value={thumb} onChange={(e) => setThumb(e.target.value)} />
              <button onClick={async () => {
                const r = await window.api.renderThumbnail(project, thumb);
                if (r.ok) window.api.showInFolder(r.file);
                else if (!r.canceled) setErr(r.error);
              }}>🖼 Make thumbnail…</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Settings
export function SettingsDialog({ onClose }) {
  const [s, setS] = useState(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [game, setGame] = useState('');
  useEffect(() => {
    window.api.getSettings().then((x) => { setS(x); setModel(x.model); setGame(x.game); });
  }, []);
  const save = async () => {
    setS(await window.api.setSettings({ ...(key ? { apiKey: key.trim() } : {}), model: model.trim(), game: game.trim() }));
    setKey('');
    onClose();
  };
  return (
    <Modal title="⚙ Settings" onClose={onClose}>
      <label className="field">
        <span>Claude API key {s?.hasKey && <b className="ok">saved ✓</b>}</span>
        <input type="password" value={key} placeholder={s?.hasKey ? '•••••••• (leave empty to keep)' : 'sk-ant-…'} onChange={(e) => setKey(e.target.value)} />
      </label>
      <p className="hint">Optional. Used only for the YouTube pack (titles, description, hooks). Stored encrypted on this PC and sent only to Anthropic. Get one at console.anthropic.com.</p>
      <label className="field"><span>Model</span><input type="text" value={model} onChange={(e) => setModel(e.target.value)} /></label>
      <label className="field"><span>Your main game</span><input type="text" value={game} placeholder="Fortnite" onChange={(e) => setGame(e.target.value)} /></label>
      <div className="modal-actions">
        {s?.hasKey && <button onClick={async () => setS(await window.api.setSettings({ clearKey: true }))}>Remove key</button>}
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
