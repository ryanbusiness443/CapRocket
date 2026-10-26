// Builds FFmpeg arguments for exporting a project to MP4.
// Pure module (no Electron imports) so it can be tested from plain Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { effectChain, popText } = require('./rocket/effects.cjs');
const { writeAss, FONTS_DIR: CAPTION_FONTS_DIR } = require('./rocket/captions.cjs');

// FFmpeg binaries: the bundled static builds, or FFMPEG_PATH / FFPROBE_PATH, or whatever is on PATH.
function binary(envName, mod, pick) {
  if (process.env[envName]) return process.env[envName];
  try {
    const p = pick(require(mod)).replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(p)) return p;
  } catch (_) { /* not installed */ }
  return envName === 'FFMPEG_PATH' ? 'ffmpeg' : 'ffprobe';
}
const ffmpegPath = binary('FFMPEG_PATH', 'ffmpeg-static', (m) => m);
const ffprobePath = binary('FFPROBE_PATH', 'ffprobe-static', (m) => m.path);

// First font file that exists: Windows fonts, then common Linux/macOS ones.
const FONT_CANDIDATES = [
  process.env.FVE_FONT,
  'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
].filter(Boolean);
const DEFAULT_FONT = FONT_CANDIDATES.find((f) => fs.existsSync(f)) || 'C:/Windows/Fonts/arial.ttf';

// Escape a path for use as a quoted filter option value: C:/x -> 'C\:/x'
function filterPath(p) {
  return "'" + p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''") + "'";
}

const num = (n) => Number(n).toFixed(3);

function probe(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
    const p = spawn(ffprobePath, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exited with ${code}`));
      const info = JSON.parse(out);
      const streams = info.streams || [];
      const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const a = streams.find((s) => s.codec_type === 'audio');
      let fps = 0;
      if (v && v.r_frame_rate) {
        const [n, d] = v.r_frame_rate.split('/').map(Number);
        fps = d ? n / d : n;
      }
      resolve({
        duration: parseFloat(info.format && info.format.duration) || 0,
        fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : 0,
        hasVideo: !!v,
        hasAudio: !!a,
        width: v ? v.width : 0,
        height: v ? v.height : 0,
      });
    });
  });
}

// Overlap between clip a and the next clip b when a has a transition (kept identical to src/store.js).
function transitionDuration(a, b) {
  if (!a || !b || !a.transition || !a.transition.type || a.transition.type === 'none') return 0;
  const T = a.transition.duration ?? 0.3;
  const room = Math.min(a.out - a.in, b.out - b.in) / 2 - 0.05;
  const d = Math.max(0, Math.min(T, room));
  return d >= 0.05 ? d : 0;
}

// Timeline position of every main-track clip (transitions make neighbours overlap).
function videoLayout(clips) {
  let t = 0;
  return clips.map((c, i) => {
    const start = t;
    const end = start + (c.out - c.in);
    const overlap = transitionDuration(c, clips[i + 1]);
    t = end - overlap;
    return { clip: c, start, end, overlap };
  });
}

function captionFont() {
  if (process.env.FVE_CAPTION_FONT) return process.env.FVE_CAPTION_FONT;
  return process.platform === 'win32' ? 'Arial Black' : 'Poppins';
}

// ---------------------------------------------------------------- export
// Two stages so memory stays flat however long the edit is:
//   1. every main-track clip body and every transition is rendered on its own (one source open at a time)
//      into a normalized piece: W x H, fps, PCM stereo audio, an exact number of frames;
//   2. the pieces are joined with the concat demuxer and one final pass adds the look, Effects track,
//      text, captions, loudness, fades and the music / SFX mix.
// Piece boundaries sit on frame boundaries of the timeline, so effects, captions and SFX stay in sync.

// project: { width, height, fps, media[], videoClips[], textClips[], audioClips[],
//            effects[], captionClips[], captionStyle, grade, loudnorm, fades, draft }
function planPieces(project) {
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));
  const clips = project.videoClips.filter((c) => mediaById[c.mediaId]);
  if (clips.length === 0) throw new Error('The video track is empty.');
  const fps = project.fps;
  const layout = videoLayout(clips);
  const F = (t) => Math.round(t * fps); // timeline seconds -> frame index
  const pieces = [];
  layout.forEach((l, i) => {
    const prev = i > 0 ? layout[i - 1].overlap : 0;
    const next = l.overlap;
    // Body: the part of the clip that is not inside a transition.
    const a = F(l.start + prev);
    const b = F(l.end - next);
    if (b > a) {
      pieces.push({ kind: 'body', clip: l.clip, media: mediaById[l.clip.mediaId], frames: b - a,
        src: l.clip.in + (a / fps - l.start) });
    }
    if (next > 0) {
      const ta = F(l.end - next);
      const tb = F(l.end);
      const n = tb - ta;
      if (n > 0) {
        const nextClip = layout[i + 1].clip;
        pieces.push({ kind: 'transition', type: l.clip.transition.type, frames: n,
          a: { clip: l.clip, media: mediaById[l.clip.mediaId], src: l.clip.in + (ta / fps - l.start) },
          b: { clip: nextClip, media: mediaById[nextClip.mediaId], src: nextClip.in + (ta / fps - layout[i + 1].start) } });
      }
    }
  });
  const totalFrames = pieces.reduce((s, p) => s + p.frames, 0);
  return { pieces, totalFrames, total: totalFrames / fps };
}

const SR = 48000;
// zoom > 1 punches in (static crop around the centre): the editor's "jump zoom".
const even = (v) => Math.round(v / 2) * 2;
const normV = (W, H, fps, zoom = 1) =>
  `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
  (zoom > 1.001 ? `scale=${even(W * zoom)}:${even(H * zoom)},crop=${W}:${H},` : '') +
  `fps=${fps},settb=AVTB,format=yuv420p,tpad=stop_mode=clone:stop_duration=2`;
const normA = (vol) => `aresample=${SR}:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,volume=${vol}`;

// Inputs + video/audio chains for one source span of `dur` seconds starting at `src`.
function sourceChain(part, idx, dur, W, H, fps) {
  const { media, clip } = part;
  const args = ['-ss', num(Math.max(0, part.src)), '-t', num(dur + 0.5), '-i', media.path];
  const v = `[${idx}:v]${normV(W, H, fps, clip.zoom || 1)}`;
  const hasA = media.hasAudio && !clip.muted;
  const a = hasA ? `[${idx}:a]${normA(clip.volume ?? 1)}` : null;
  return { args, v, a };
}

function pieceArgs(piece, out, W, H, fps, draft) {
  const n = piece.frames;
  const dur = n / fps;
  const samples = Math.round(dur * SR);
  const enc = ['-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'veryfast', '-crf', draft ? '24' : '16', '-pix_fmt', 'yuv420p'];
  const aEnd = `apad,atrim=end_sample=${samples},asetpts=PTS-STARTPTS`;
  let inputs = [];
  let g;
  if (piece.kind === 'body') {
    const s = sourceChain(piece, 0, dur, W, H, fps);
    inputs = s.args;
    g = `${s.v}[v];` + (s.a ? `${s.a},${aEnd}[a]` : `anullsrc=r=${SR}:cl=stereo,aformat=sample_fmts=s16,${aEnd}[a]`);
  } else {
    const A = sourceChain(piece.a, 0, dur, W, H, fps);
    const B = sourceChain(piece.b, 1, dur, W, H, fps);
    inputs = [...A.args, ...B.args];
    const silent = (lbl) => `anullsrc=r=${SR}:cl=stereo,aformat=sample_fmts=s16,atrim=end_sample=${samples}[${lbl}]`;
    g = `${A.v},trim=end_frame=${n}[va];${B.v},trim=end_frame=${n}[vb];` +
      `[va][vb]xfade=transition=${piece.type}:duration=${num(Math.max(dur - 0.5 / fps, 0.01))}:offset=0[v];` +
      (A.a ? `${A.a},apad,atrim=end_sample=${samples}[aa];` : silent('aa') + ';') +
      (B.a ? `${B.a},apad,atrim=end_sample=${samples}[ab];` : silent('ab') + ';') +
      `[aa][ab]acrossfade=d=${num(dur)}:c1=tri:c2=tri,${aEnd}[a]`;
  }
  return ['-y', '-hide_banner', '-v', 'error', ...inputs, '-filter_complex', g, '-map', '[v]', '-map', '[a]',
    '-frames:v', String(n), ...enc, '-c:a', 'pcm_s16le', '-ar', String(SR), '-f', 'matroska', out];
}

function finalArgs(project, listFile, total, outFile, tmpDir) {
  const { width: W, height: H } = project;
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));
  const inputs = ['-f', 'concat', '-safe', '0', '-i', listFile];
  const filters = [];

  // Look: colour boost, Effects track (glitch, flash, shake…), fades.
  const look = [];
  if (project.grade) look.push('eq=contrast=1.06:saturation=1.22:gamma=0.98');
  const fx = effectChain(project.effects, W, H);
  if (fx) look.push(fx);
  if (project.fades) look.push('fade=t=in:st=0:d=0.5', `fade=t=out:st=${num(Math.max(0, total - 0.7))}:d=0.7`);
  filters.push(`[0:v]${look.length ? look.join(',') : 'null'}[vlook]`);
  let vLabel = 'vlook';

  // Text overlays (anim: 'pop' bounces in).
  project.textClips.forEach((t, i) => {
    const txtFile = path.join(tmpDir, `text_${i}.txt`);
    fs.writeFileSync(txtFile, t.text, 'utf8');
    const color = (t.color || '#ffffff').replace('#', '0x');
    const next = `vt${i}`;
    const size = Math.round(t.size || 48);
    const x = `(w*${num(t.x ?? 0.5)})-text_w/2`;
    const y = `(h*${num(t.y ?? 0.85)})-text_h/2`;
    const fontExpr = filterPath(t.font || DEFAULT_FONT);
    if (t.anim === 'pop') {
      filters.push(`[${vLabel}]` + popText({ fontExpr, textExpr: `textfile=${filterPath(txtFile)}:expansion=none`, size, x, y,
        start: t.start, end: t.start + t.duration, color, box: t.box !== false }) + `[${next}]`);
    } else {
      filters.push(
        `[${vLabel}]drawtext=fontfile=${fontExpr}:textfile=${filterPath(txtFile)}:` +
          `expansion=none:fontsize=${size}:fontcolor=${color}:borderw=2:bordercolor=black:` +
          `x=${x}:y=${y}:enable='between(t,${num(t.start)},${num(t.start + t.duration)})'[${next}]`
      );
    }
    vLabel = next;
  });

  // Animated captions (word-by-word highlight / pop) rendered with libass.
  const caps = (project.captionClips || []).filter((c) => c.text && c.duration > 0);
  const capStyle = project.captionStyle?.style || 'karaoke';
  if (caps.length && capStyle !== 'off') {
    const assFile = path.join(tmpDir, 'captions.ass');
    writeAss(caps.map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text })),
      { width: W, height: H, style: capStyle, font: project.captionStyle?.font || captionFont(), sizeScale: project.captionStyle?.size ?? 1, file: assFile });
    const fontsDir = capStyle === 'read' ? CAPTION_FONTS_DIR : process.platform === 'win32' ? 'C:/Windows/Fonts' : path.dirname(DEFAULT_FONT);
    filters.push(`[${vLabel}]ass=${filterPath(assFile)}:fontsdir=${filterPath(fontsDir)}[vcap]`);
    vLabel = 'vcap';
  }

  // Main audio: optional YouTube loudness, then music / SFX mixed at their timeline positions.
  const aLook = ['aformat=sample_fmts=fltp:channel_layouts=stereo'];
  if (project.loudnorm) aLook.push('loudnorm=I=-14:TP=-1.5:LRA=11', `aresample=${SR}`);
  if (project.fades) aLook.push('afade=t=in:st=0:d=0.4', `afade=t=out:st=${num(Math.max(0, total - 0.7))}:d=0.7`);
  filters.push(`[0:a]${aLook.join(',')}[amain]`);
  let aLabel = 'amain';
  const music = project.audioClips.filter((c) => mediaById[c.mediaId] && c.start < total);
  const mixLabels = ['[amain]'];
  music.forEach((c, j) => {
    inputs.push('-i', mediaById[c.mediaId].path);
    const delay = Math.round(c.start * 1000);
    filters.push(
      `[${j + 1}:a]atrim=start=${num(c.in)}:end=${num(c.out)},asetpts=PTS-STARTPTS,volume=${c.volume ?? 1},` +
        `aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delay}|${delay}[m${j}]`
    );
    mixLabels.push(`[m${j}]`);
  });
  if (music.length) {
    filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0,alimiter=limit=0.95[amix]`);
    aLabel = 'amix';
  }

  return [
    '-y', '-hide_banner',
    ...inputs,
    '-filter_complex_script', writeScript(tmpDir, filters.join(';\n')),
    '-map', `[${vLabel}]`, '-map', `[${aLabel}]`,
    '-c:v', 'libx264', '-preset', project.draft ? 'ultrafast' : 'veryfast', '-crf', project.draft ? '27' : '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-t', num(total),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outFile,
  ];
}

// Long filter graphs go in a file (Windows command lines are limited to ~32k characters).
function writeScript(tmpDir, graph) {
  const f = path.join(tmpDir, 'graph.txt');
  fs.writeFileSync(f, graph, 'utf8');
  return f;
}

// Runs the export; onProgress receives a 0..1 fraction. Returns { promise, cancel }.
function runExport(project, outFile, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fve-'));
  const { width: W, height: H, fps } = project;
  let proc = null;
  let canceled = false;
  const STAGE1 = 0.55; // share of the progress bar for rendering the pieces

  const exec = (args, onLine) => new Promise((resolve, reject) => {
    if (canceled) return reject(new Error('canceled'));
    proc = spawn(ffmpegPath, args, { windowsHide: true });
    let log = '';
    proc.stdout.on('data', (d) => onLine?.(d.toString()));
    proc.stderr.on('data', (d) => {
      log += d;
      if (log.length > 20000) log = log.slice(-20000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      proc = null;
      if (code === 0) resolve();
      else reject(new Error(canceled ? 'canceled' : `FFmpeg failed (code ${code}):\n${log.slice(-3000)}`));
    });
  });

  const promise = (async () => {
    try {
      const { pieces, totalFrames, total } = planPieces(project);
      const files = [];
      let done = 0;
      for (let i = 0; i < pieces.length; i++) {
        const f = path.join(tmpDir, `piece_${String(i).padStart(4, '0')}.mkv`);
        await exec(pieceArgs(pieces[i], f, W, H, fps, project.draft));
        files.push(f);
        done += pieces[i].frames;
        onProgress?.((done / totalFrames) * STAGE1);
      }
      const list = path.join(tmpDir, 'pieces.txt');
      fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
      await exec(finalArgs(project, list, total, outFile, tmpDir), (txt) => {
        const m = /out_time_us=(\d+)/.exec(txt);
        if (m && total > 0) onProgress?.(STAGE1 + (1 - STAGE1) * Math.min(1, Number(m[1]) / 1e6 / total));
      });
      onProgress?.(1);
      return outFile;
    } catch (e) {
      // Never leave a half-written video where the user asked to save.
      fs.rmSync(outFile, { force: true });
      throw e;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
  return {
    promise,
    cancel: () => {
      canceled = true;
      if (proc) proc.kill('SIGKILL');
    },
  };
}

module.exports = { ffmpegPath, ffprobePath, probe, planPieces, runExport, videoLayout, transitionDuration, filterPath, DEFAULT_FONT, captionFont };
