// Shorts (9:16) and thumbnail rendering straight from the source video and the Auto Edit analysis.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ffmpegPath, filterPath, DEFAULT_FONT, captionFont } = require('../ffmpeg.cjs');
const { STYLES, effectChain, hitEffects, popText, escText } = require('./effects.cjs');
const { remapToTimeline, chunk, writeAss } = require('./captions.cjs');
const { ensureLibrary } = require('./sfx.cjs');

const n3 = (v) => Number(v).toFixed(3);
const X264 = (draft) => ['-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'veryfast', '-crf', draft ? '27' : '20', '-pix_fmt', 'yuv420p'];
const AAC = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];

function ff(args, { onTime, total } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-y', '-hide_banner', '-v', 'error', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
    let err = '';
    p.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && total) onTime?.(Math.min(1, Number(m[1]) / 1e6 / total));
    });
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${err}`))));
  });
}

// Pieces of [s, e] that survived the dead-air cut, extended at the end to keep the target length.
function liveSegments(keep, s, e, duration) {
  const L = e - s;
  let segs = [];
  for (let k = 0; k < 4; k++) {
    segs = keep.filter(([a, b]) => b > s && a < e).map(([a, b]) => [Math.max(a, s), Math.min(b, e)]);
    const got = segs.reduce((x, [a, b]) => x + b - a, 0);
    if (got >= L - 0.05 || e >= duration) break;
    e = Math.min(duration, e + (L - got));
  }
  return { segs, end: e };
}

/**
 * Renders one Short. h: highlight { start, end, peak }, src: source media, a: project.autoEdit.
 * opts: { hook, style, layout: 'crop45' | 'crop916', replay, sfxDir, draft, fps }
 */
async function renderShort(src, a, h, out, opts = {}, onProgress) {
  const style = STYLES[opts.style] ? opts.style : a.style || 'crazy';
  const st = STYLES[style];
  const fps = opts.fps || 30;
  const W = 1080;
  const H = 1920;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rocket-short-'));
  try {
    const keep = a.keep && a.keep.length ? a.keep : [[0, src.duration]];
    const { segs, end } = liveSegments(keep, h.start, h.end, src.duration);
    const s = h.start;
    const rel = segs.map(([x, y]) => [x - s, y - s]);
    const dur = rel.reduce((x, [p, q]) => x + q - p, 0);
    let acc = 0;
    const local = rel.map(([p, q]) => { const r = { in: p, out: q, start: acc }; acc += q - p; return r; });
    const mapT = (t) => { const g = local.find((r) => t >= r.in && t <= r.out); return g ? g.start + t - g.in : null; };
    const peak = mapT(h.peak - s) ?? Math.min(h.peak - s, dur / 2);
    const sel = rel.map(([p, q]) => `between(t,${n3(p)},${n3(q)})`).join('+');

    const fgH = opts.layout === 'crop916' ? H : 1350;
    const crop = opts.layout === 'crop916' ? 'crop=\'min(iw,ih*9/16)\':ih' : 'crop=\'min(iw,ih*4/5)\':ih';
    const zoom = `1+0.14*exp(-pow((it-${n3(peak)})/0.35,2))`;
    let g = `[0:v]select='${sel}',setpts=N/FRAME_RATE/TB,split[a][b];` +
      `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=28,eq=brightness=-0.12:saturation=1.1[bg];` +
      `[b]${crop},scale=${W}:${fgH},setsar=1,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${fgH}:fps=${fps}[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,eq=contrast=1.07:saturation=1.25`;
    const fx = effectChain(hitEffects(peak, style), W, H);
    if (fx) g += ',' + fx;
    if (opts.hook) {
      const tf = path.join(tmp, 'hook.txt');
      fs.writeFileSync(tf, opts.hook.toUpperCase(), 'utf8');
      g += ',' + popText({ fontExpr: filterPath(DEFAULT_FONT), textExpr: `textfile=${filterPath(tf)}:expansion=none`, size: 72, x: '(w-text_w)/2', y: '150+(72-text_h)/2', start: 0.15, end: dur + 99 });
    }
    if (a.sourceCaptions && a.sourceCaptions.length) {
      const inWin = a.sourceCaptions.filter((c) => c.end > s && c.start < end).map((c) => ({ start: c.start - s, end: c.end - s, text: c.text }));
      const caps = chunk(remapToTimeline(inWin, local), 3);
      if (caps.length) {
        const ass = path.join(tmp, 'caps.ass');
        writeAss(caps, { width: W, height: H, style: opts.captionStyle || 'karaoke', font: captionFont(), file: ass, sizeScale: 1.1 });
        const fontsDir = process.platform === 'win32' ? 'C:/Windows/Fonts' : path.dirname(DEFAULT_FONT);
        g += `,ass=${filterPath(ass)}:fontsdir=${filterPath(fontsDir)}`;
      }
    }
    const replay = opts.replay !== false && style !== 'clean';
    g += ',fade=t=in:st=0:d=0.3' + (replay ? '' : `,fade=t=out:st=${n3(dur - 0.4)}:d=0.4`) + '[v]';

    const inputs = ['-ss', n3(s), '-t', n3(end - s), '-i', src.path];
    let aOut = null;
    if (src.hasAudio) {
      g += `;[0:a]aselect='${sel}',asetpts=N/SR/TB,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0]`;
      const events = [];
      if (st.sfx && opts.sfx !== false) {
        events.push(['whoosh', 0.1, 0.45], ['boom', peak, 0.7]);
        if (peak >= 2.2) events.push(['riser', peak - 2, 0.3]);
        if (style === 'crazy') events.push(['glitch', Math.max(0, peak - 0.14), 0.4]);
      }
      const lib = events.length ? ensureLibrary(opts.sfxDir || path.join(os.tmpdir(), 'rocket-sfx')) : {};
      const labels = ['[a0]'];
      events.forEach(([name, at, vol], k) => {
        inputs.push('-i', lib[name].path);
        const ms = Math.max(0, Math.round(at * 1000));
        g += `;[${k + 1}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms},volume=${vol}[e${k}]`;
        labels.push(`[e${k}]`);
      });
      g += `;${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,alimiter=limit=0.95` +
        (replay ? '' : `,afade=t=out:st=${n3(dur - 0.4)}:d=0.4`) + '[aud]';
      aOut = '[aud]';
    }
    const script = path.join(tmp, 'g.txt');
    fs.writeFileSync(script, g, 'utf8');
    const main = replay ? path.join(tmp, 'main.mp4') : out;
    await ff([...inputs, '-filter_complex_script', script, '-map', '[v]', ...(aOut ? ['-map', aOut] : []), ...X264(opts.draft),
      ...(aOut ? AAC : []), '-r', String(fps), '-t', n3(dur), '-movflags', '+faststart', main],
    { total: dur, onTime: (p) => onProgress?.(p * (replay ? 0.75 : 1)) });

    if (replay && aOut) {
      // Slow-motion REPLAY of the peak, pitched down, joined with a white flash.
      const before = 1.2;
      const after = 0.7;
      const rs = Math.max(0, peak - before);
      const rd = Math.min(before + after, dur - rs);
      const tag = `drawtext=fontfile=${filterPath(DEFAULT_FONT)}:text='REPLAY':fontsize=64:fontcolor=red:borderw=6:bordercolor=white:x=60:y=60:alpha='0.55+0.45*sin(t*9)'`;
      const rp = path.join(tmp, 'replay.mp4');
      await ff(['-ss', n3(rs), '-t', n3(rd), '-i', main, '-filter_complex',
        `[0:v]setpts=PTS/0.5,fps=${fps},settb=AVTB,eq=contrast=1.12:saturation=0.75,vignette=PI/4,tmix=frames=3,${tag},format=yuv420p[v];` +
        '[0:a]asetrate=48000*0.5,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.2[a]',
        '-map', '[v]', '-map', '[a]', ...X264(opts.draft), ...AAC, '-t', n3(rd * 2), rp]);
      const T = 0.3;
      await ff(['-i', main, '-i', rp, '-filter_complex',
        `[0:v]fps=${fps},settb=AVTB,format=yuv420p[v0];[1:v]fps=${fps},settb=AVTB,format=yuv420p[v1];` +
        `[v0][v1]xfade=transition=fadewhite:duration=${T}:offset=${n3(dur - T)},fade=t=out:st=${n3(dur - T + rd * 2 - 0.4)}:d=0.4[v];` +
        `[0:a][1:a]acrossfade=d=${T},afade=t=out:st=${n3(dur - T + rd * 2 - 0.4)}:d=0.4[a]`,
        '-map', '[v]', '-map', '[a]', ...X264(opts.draft), ...AAC, '-movflags', '+faststart', out]);
    }
    onProgress?.(1);
    return { file: out, duration: replay && aOut ? dur + 1.9 * 2 - 0.3 : dur, peak };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 1280x720 (or source-shaped) thumbnail from the top moment with big outlined text.
async function renderThumbnail(src, at, out, text) {
  let vf = 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=contrast=1.15:saturation=1.4:brightness=0.02,unsharp=5:5:0.8';
  if (text) {
    vf += `,drawtext=fontfile=${filterPath(DEFAULT_FONT)}:text='${escText(text.toUpperCase())}':fontsize=110:fontcolor=yellow:` +
      'borderw=10:bordercolor=black:x=50:y=h-text_h-60';
  }
  await ff(['-ss', n3(Math.max(0, at)), '-i', src.path, '-frames:v', '1', '-q:v', '2', '-vf', vf, out]);
  return out;
}

module.exports = { renderShort, renderThumbnail, liveSegments };
