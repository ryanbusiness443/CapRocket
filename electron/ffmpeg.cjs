// Builds FFmpeg arguments for exporting a project to MP4.
// Pure module (no Electron imports) so it can be tested from plain Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { effectChain, popText } = require('./rocket/effects.cjs');
const { writeAss } = require('./rocket/captions.cjs');

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

// project: { width, height, fps, media[], videoClips[], textClips[], audioClips[],
//            effects[], captionClips[], captionStyle, grade, loudnorm }
function buildExportArgs(project, outFile, tmpDir) {
  const { width: W, height: H, fps } = project;
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));
  const inputs = [];
  const filters = [];

  const clips = project.videoClips.filter((c) => mediaById[c.mediaId]);
  if (clips.length === 0) throw new Error('The video track is empty.');
  const layout = videoLayout(clips);
  const total = layout[layout.length - 1].end;

  // Main (video) track: trim each clip, normalize size/fps/audio.
  clips.forEach((clip, i) => {
    const m = mediaById[clip.mediaId];
    const dur = clip.out - clip.in;
    inputs.push('-i', m.path);
    filters.push(
      `[${i}:v]trim=start=${num(clip.in)}:end=${num(clip.out)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},settb=AVTB,format=yuv420p[v${i}]`
    );
    const vol = clip.volume ?? 1;
    if (m.hasAudio && !clip.muted) {
      filters.push(
        `[${i}:a]atrim=start=${num(clip.in)}:end=${num(clip.out)},asetpts=PTS-STARTPTS,` +
          `volume=${vol},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      );
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${num(dur)},aformat=sample_fmts=fltp[a${i}]`);
    }
  });

  // Join clips: plain cuts concat, transitions use xfade / acrossfade.
  let vCur = 'v0';
  let aCur = 'a0';
  for (let i = 1; i < clips.length; i++) {
    const T = layout[i - 1].overlap;
    const vn = `vj${i}`;
    const an = `aj${i}`;
    if (T > 0) {
      const type = clips[i - 1].transition.type;
      filters.push(`[${vCur}][v${i}]xfade=transition=${type}:duration=${num(T)}:offset=${num(layout[i].start)}[${vn}]`);
      filters.push(`[${aCur}][a${i}]acrossfade=d=${num(T)}[${an}]`);
    } else {
      filters.push(`[${vCur}][v${i}]concat=n=2:v=1:a=0[${vn}]`);
      filters.push(`[${aCur}][a${i}]concat=n=2:v=0:a=1[${an}]`);
    }
    vCur = vn;
    aCur = an;
  }

  // Look: colour boost, Effects track (glitch, flash, shake…), fades.
  const look = [];
  if (project.grade) look.push('eq=contrast=1.06:saturation=1.22:gamma=0.98');
  const fx = effectChain(project.effects, W, H);
  if (fx) look.push(fx);
  if (project.fades) look.push(`fade=t=in:st=0:d=0.5`, `fade=t=out:st=${num(Math.max(0, total - 0.7))}:d=0.7`);
  let vLabel = vCur;
  if (look.length) {
    filters.push(`[${vCur}]${look.join(',')}[vlook]`);
    vLabel = 'vlook';
  }

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
          `x=${x}:y=${y}:` +
          `enable='between(t,${num(t.start)},${num(t.start + t.duration)})'[${next}]`
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
    const fontsDir = process.platform === 'win32' ? 'C:/Windows/Fonts' : path.dirname(DEFAULT_FONT);
    filters.push(`[${vLabel}]ass=${filterPath(assFile)}:fontsdir=${filterPath(fontsDir)}[vcap]`);
    vLabel = 'vcap';
  }

  // Main audio: optional YouTube loudness, then music / SFX mixed at their timeline positions.
  let aLabel = aCur;
  const aLook = [];
  if (project.loudnorm) aLook.push('loudnorm=I=-14:TP=-1.5:LRA=11', 'aresample=48000');
  if (project.fades) aLook.push('afade=t=in:st=0:d=0.4', `afade=t=out:st=${num(Math.max(0, total - 0.7))}:d=0.7`);
  if (aLook.length) {
    filters.push(`[${aCur}]${aLook.join(',')}[amain]`);
    aLabel = 'amain';
  }
  const music = project.audioClips.filter((c) => mediaById[c.mediaId]);
  const mixLabels = [`[${aLabel}]`];
  music.forEach((c, j) => {
    const idx = clips.length + j;
    inputs.push('-i', mediaById[c.mediaId].path);
    const delay = Math.round(c.start * 1000);
    filters.push(
      `[${idx}:a]atrim=start=${num(c.in)}:end=${num(c.out)},asetpts=PTS-STARTPTS,volume=${c.volume ?? 1},` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delay}|${delay}[m${j}]`
    );
    mixLabels.push(`[m${j}]`);
  });
  if (music.length) {
    filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0,alimiter=limit=0.95[amix]`);
    aLabel = 'amix';
  }

  const args = [
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
  return { args, total };
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
  const { args, total } = buildExportArgs(project, outFile, tmpDir);
  const proc = spawn(ffmpegPath, args, { windowsHide: true });
  let log = '';
  const promise = new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && total > 0) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / total));
    });
    proc.stderr.on('data', (d) => {
      log += d;
      if (log.length > 20000) log = log.slice(-20000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (code === 0) {
        onProgress?.(1);
        resolve(outFile);
      } else {
        reject(new Error(`FFmpeg failed (code ${code}):\n${log.slice(-3000)}`));
      }
    });
  });
  return { promise, cancel: () => proc.kill('SIGKILL') };
}

module.exports = { ffmpegPath, ffprobePath, probe, buildExportArgs, runExport, videoLayout, transitionDuration, filterPath, DEFAULT_FONT, captionFont };
