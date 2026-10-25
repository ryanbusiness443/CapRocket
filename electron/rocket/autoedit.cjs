// Auto Edit: turns one source video into a full, still-editable CapRocket project:
// dead air cut out, transitions on the cuts, hit effects + SFX on highlights, captions, hook title.
const path = require('path');
const { analyze } = require('./analyze.cjs');
const { remapToTimeline, chunk, readSrt } = require('./captions.cjs');
const { STYLES, hitEffects } = require('./effects.cjs');
const { ensureLibrary } = require('./sfx.cjs');
const { videoLayout, probe } = require('../ffmpeg.cjs');

let counter = 0;
const id = (p) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;
const r3 = (v) => Math.round(v * 1000) / 1000;

// Fit the source into a sensible project size (max 1080p on the short side, even numbers).
function projectSize(info) {
  let w = info.width || 1920;
  let h = info.height || 1080;
  const short = Math.min(w, h);
  if (short > 1080) {
    const k = 1080 / short;
    w *= k;
    h *= k;
  }
  return { width: Math.round(w / 2) * 2, height: Math.round(h / 2) * 2 };
}

/**
 * opts: {
 *   media: { id, path, ... }          source video (already in the project's media list)
 *   style: 'crazy' | 'hype' | 'clean'
 *   cut: 'dead' | 'silence' | 'off', minGap
 *   transitions, effects, sfx: booleans
 *   captionsFile: optional .srt path; captionStyle: 'karaoke' | 'pop' | 'clean' | 'off'
 *   fillers: optional [[start, end]] spans to cut (e.g. from Descript)
 *   hook: optional title text for the opening seconds
 *   shorts: number of highlight candidates to find, shortLen
 *   sfxDir: folder for the generated sound effects
 * }
 * Returns { project, report }.
 */
async function autoEdit(base, opts, onProgress) {
  const media = opts.media;
  const style = STYLES[opts.style] ? opts.style : 'crazy';
  const st = STYLES[style];
  const captions = opts.captionsFile ? readSrt(opts.captionsFile) : opts.captions || null;

  const a = await analyze(media.path, {
    mode: opts.cut || 'dead', minGap: opts.minGap ?? 1.2, captions,
    removeSpans: opts.fillers, shortLen: opts.shortLen ?? 30, maxShorts: opts.shorts ?? 3,
  }, onProgress);
  onProgress?.('Building your timeline', 1);

  // 1) Main track: one clip per kept segment, transitions between long-enough neighbours.
  const T = st.duration;
  let keep = a.keep.map(([i, o]) => ({ in: i, out: o }));
  const useTrans = opts.transitions !== false;
  const canTrans = (x, y) => useTrans && x.out - x.in >= 2 * T + 0.4 && y.out - y.in >= 2 * T + 0.4;
  // Transitions should blend action, not the quiet padding left around a cut: trim it.
  for (let i = 0; i < keep.length - 1; i++) {
    if (canTrans(keep[i], keep[i + 1])) {
      keep[i].out -= 0.25;
      keep[i + 1].in += 0.25;
    }
  }
  let t = 0;
  const clips = keep.map((k, i) => {
    const c = { id: id('c'), mediaId: media.id, in: r3(k.in), out: r3(k.out), volume: 1, muted: false };
    if (i < keep.length - 1 && canTrans(keep[i], keep[i + 1])) {
      c.transition = { type: st.transitions[t++ % st.transitions.length], duration: T };
    }
    return c;
  });
  const layout = videoLayout(clips);
  const segments = layout.map((l) => ({ in: l.clip.in, out: l.clip.out, start: l.start }));
  const total = layout[layout.length - 1].end;
  // Source time -> timeline time (null if that moment was cut).
  const toTimeline = (src) => {
    const s = segments.find((g) => src >= g.in && src <= g.out);
    return s ? s.start + (src - s.in) : null;
  };

  // 2) Highlights -> effects + SFX.
  const peaks = a.highlights.map((h) => toTimeline(h.peak)).filter((p) => p !== null);
  const effects = [];
  if (opts.effects !== false) {
    for (const p of peaks) for (const e of hitEffects(p, style)) effects.push({ id: id('e'), ...e, start: r3(e.start) });
  }

  const newMedia = [];
  const audioClips = [];
  if (opts.sfx !== false && st.sfx) {
    const lib = ensureLibrary(opts.sfxDir);
    const mediaFor = {};
    const use = (name) => {
      if (!mediaFor[name]) {
        const m = { id: id('sfx'), path: lib[name].path, name: `${lib[name].label}.wav`, type: 'audio', duration: lib[name].duration, hasAudio: true, hasVideo: false, sfx: true };
        mediaFor[name] = m;
        newMedia.push(m);
      }
      return mediaFor[name];
    };
    const place = (name, at, volume) => {
      if (at < 0 || at > total) return;
      const m = use(name);
      audioClips.push({ id: id('s'), mediaId: m.id, start: r3(at), in: 0, out: r3(Math.min(m.duration, total - at)), volume, sfx: true });
    };
    let last = -9;
    layout.forEach((l) => {
      if (!l.overlap) return;
      const mid = l.end - l.overlap / 2;
      if (mid - last >= 2) {
        place('whoosh', Math.max(0, mid - 0.25), 0.4);
        last = mid;
      }
    });
    for (const p of peaks) {
      place('boom', p, 0.6);
      if (p >= 2.2) place('riser', p - 2, 0.25);
      if (style === 'crazy') place('glitch', Math.max(0, p - 0.14), 0.35);
    }
  }

  // 3) Captions mapped onto the edit, in short punchy chunks.
  const captionClips = captions
    ? chunk(remapToTimeline(captions, segments), opts.captionWords ?? 3).map((c) => ({ id: id('k'), start: r3(c.start), duration: r3(c.end - c.start), text: c.text }))
    : [];

  // 4) Optional hook title over the first seconds.
  const size = projectSize(a.info);
  const textClips = [];
  if (opts.hook) {
    textClips.push({ id: id('t'), text: opts.hook.toUpperCase(), start: 0.15, duration: Math.min(3, total), x: 0.5, y: 0.12,
      size: Math.round(size.height * (size.height > size.width ? 0.04 : 0.075)), color: '#ffffff', anim: 'pop' });
  }

  const project = {
    ...base,
    width: size.width, height: size.height, fps: Math.min(60, Math.round(a.info.fps || 30)),
    media: [...base.media, ...newMedia],
    videoClips: clips,
    textClips,
    audioClips: [...base.audioClips.filter((c) => !c.sfx), ...audioClips],
    effects,
    captionClips,
    captionStyle: { style: captionClips.length ? opts.captionStyle || 'karaoke' : 'off' },
    grade: style !== 'clean',
    loudnorm: true,
    fades: true,
    autoEdit: {
      sourceMediaId: media.id, style, highlights: a.highlights, keep: a.keep, captionsFile: opts.captionsFile || null,
      sourceCaptions: captions || null, peaks,
    },
  };
  const report = {
    originalSeconds: Math.round(a.info.duration * 10) / 10,
    editedSeconds: Math.round(total * 10) / 10,
    removedSeconds: a.removedSeconds,
    fillersRemoved: a.fillersRemoved,
    cuts: clips.length - 1,
    transitions: clips.filter((c) => c.transition).length,
    effects: effects.length,
    sfx: audioClips.length,
    captions: captionClips.length,
    highlights: a.highlights.map((h, i) => ({ ...h, timeline: peaks[i] ?? null })),
    transcriptUsed: a.transcriptUsed,
  };
  return { project, report };
}

module.exports = { autoEdit, projectSize };
