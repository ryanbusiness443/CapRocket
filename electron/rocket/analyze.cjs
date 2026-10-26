// Video analysis: loudness + motion per 0.25 s window, dead-air detection, and highlight
// picking (loud + busy + exciting words in the transcript).
const { spawn } = require('child_process');
const { ffmpegPath, probe } = require('../ffmpeg.cjs');

const WIN = 0.25;

function pipe(args, onData) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-v', 'error', ...args], { windowsHide: true });
    let err = '';
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg analysis failed: ${err}`))));
  });
}

// RMS loudness in dB per window (default 0.25 s; talking mode uses 20 ms).
async function loudness(file, duration, onProgress, win = WIN) {
  const sr = 8000;
  const per = Math.round(win * sr);
  const out = [];
  let acc = 0;
  let cnt = 0;
  let carry = null;
  // aresample=async keeps the audio on its timestamps (gaps filled, overlaps dropped), so it lines up
  // with the video even for recordings with dropped frames, VFR or joined segments.
  await pipe(['-i', file, '-vn', '-af', `aresample=${sr}:async=1:first_pts=0`, '-ac', '1', '-f', 's16le', '-'], (chunk) => {
    let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    carry = usable < buf.length ? buf.subarray(usable) : null;
    for (let i = 0; i < usable; i += 2) {
      const v = buf.readInt16LE(i) / 32768;
      acc += v * v;
      if (++cnt === per) {
        out.push(20 * Math.log10(Math.sqrt(acc / per + 1e-12) + 1e-9));
        acc = 0;
        cnt = 0;
      }
    }
    onProgress?.(Math.min(1, (out.length * win) / Math.max(duration, 0.1)));
  });
  return out;
}

// Mean absolute frame difference per window, on 160x90 grey frames.
async function motion(file, duration, onProgress) {
  const W = 160;
  const H = 90;
  const size = W * H;
  const out = [];
  let prev = null;
  let pending = Buffer.alloc(0);
  await pipe(['-i', file, '-an', '-vf', `fps=${1 / WIN},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= size) {
      const f = pending.subarray(0, size);
      if (prev) {
        let s = 0;
        for (let i = 0; i < size; i++) s += Math.abs(f[i] - prev[i]);
        out.push(s / size);
      } else out.push(0);
      prev = Buffer.from(f);
      pending = pending.subarray(size);
    }
    onProgress?.(Math.min(1, (out.length * WIN) / Math.max(duration, 0.1)));
  });
  return out;
}

const HYPE_WORDS = ['no way', "let's go", 'lets go', 'oh my god', 'omg', 'what', 'insane', 'clutch', 'yes', 'holy', 'bro',
  'dude', 'crazy', 'wow', 'ace', 'clip it', 'clip that', 'gg', 'dead', 'win', 'victory', 'first place', '1v', 'one v',
  'headshot', 'noo', 'ahh', 'whoa', 'sheesh', 'goated', 'cracked'];

function hype(captions, n) {
  const x = new Array(n).fill(0);
  for (const c of captions || []) {
    const low = c.text.toLowerCase();
    let sc = HYPE_WORDS.reduce((a, w) => a + low.split(w).length - 1, 0);
    sc += (c.text.split('!').length - 1) * 0.7;
    sc += c.text.split(/\s+/).filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length * 0.5;
    sc += Math.max(0, c.text.split(/\s+/).length / Math.max(c.end - c.start, 0.3) - 3) * 0.3;
    const i0 = Math.floor(c.start / WIN);
    const i1 = Math.max(i0 + 1, Math.floor(c.end / WIN));
    for (let i = i0; i < Math.min(i1, n); i++) x[i] += sc;
  }
  return x;
}

// ---- small numeric helpers (match numpy behaviour used by the original Python engine)
function smooth(x, k) {
  if (k <= 1 || x.length < k) return x.slice();
  const lo = Math.floor(k / 2);
  const hi = Math.ceil(k / 2) - 1;
  return x.map((_, i) => {
    let s = 0;
    for (let j = i - lo; j <= i + hi; j++) if (j >= 0 && j < x.length) s += x[j];
    return s / k;
  });
}
function percentile(x, p) {
  if (!x.length) return 0;
  const s = [...x].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function zscore(x) {
  const m = x.reduce((a, b) => a + b, 0) / (x.length || 1);
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length || 1));
  return x.map((v) => (v - m) / (sd > 1e-9 ? sd : 1));
}
function spans(mask, win = WIN) {
  const out = [];
  let start = null;
  mask.forEach((m, i) => {
    if (m && start === null) start = i;
    if (!m && start !== null) {
      out.push([start * win, i * win]);
      start = null;
    }
  });
  if (start !== null) out.push([start * win, mask.length * win]);
  return out;
}
function mergeSpans(list, gap = 0.05) {
  const s = list.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of s) {
    if (out.length && a <= out[out.length - 1][1] + gap) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * opts: { mode: 'dead'|'silence'|'off', minGap, pad, silenceDb, shortLen, maxShorts, captions, removeSpans }
 * Returns { info, keep: [[in,out]], removed, removedSeconds, highlights: [{start,end,peak,score}] }
 */
async function analyze(file, opts = {}, onProgress) {
  const { mode = 'dead', minGap = 1.2, pad = 0.25, silenceDb = null, shortLen = 30, maxShorts = 3, captions = null, removeSpans = null } = opts;
  const info = await probe(file);
  const dur = info.duration;
  let db = info.hasAudio ? await loudness(file, dur, (p) => onProgress?.('Listening to the audio', p)) : [];
  let mo = info.hasVideo ? await motion(file, dur, (p) => onProgress?.('Watching the action', p)) : [];
  const n = Math.max(1, Math.min(db.length || Infinity, mo.length || Infinity, Math.ceil(dur / WIN)));
  if (!db.length) db = new Array(n).fill(-90);
  if (!mo.length) mo = new Array(n).fill(0);
  db = db.slice(0, n);
  mo = mo.slice(0, n);
  onProgress?.('Finding dead air and highlights', 1);

  // Dead air: quiet (and, in 'dead' mode, also static).
  const thr = silenceDb ?? Math.max(-50, percentile(db, 10) + 3);
  let removed = [];
  if (mode !== 'off' && mode !== 'speech') {
    const quiet = smooth(db, 3).map((v) => v < thr);
    const stillThr = Math.max(0.8, percentile(mo, 15));
    const still = smooth(mo, 3).map((v) => v < stillThr);
    const mask = quiet.map((q, i) => (mode === 'dead' ? q && still[i] : q));
    removed = spans(mask)
      .filter(([a, b]) => b - a >= minGap)
      .map(([a, b]) => [a + pad, b - pad])
      .filter(([a, b]) => b - a > 0.2);
  }
  // Talking mode (Pro rule "zero dead space"): every pause that sits 11 dB under the speaking level
  // goes, measured in 20 ms steps. 60 ms of each word's fade is kept; the next word starts 20 ms early.
  let silentGapsLeft = null;
  if (mode === 'speech' && info.hasAudio) {
    const FW = 0.02;
    const fine = await loudness(file, dur, (p) => onProgress?.('Finding every pause', p), FW);
    const peakDb = fine.reduce((m, v) => (v > m ? v : m), -120); // (no spread: long videos have 100k+ windows)
    const voiced = fine.filter((v) => v > peakDb - 40);
    const level = percentile(voiced.length ? voiced : fine, 90);
    const quietThr = level - (opts.deadDb ?? 11);
    const gap = opts.speechGap ?? 0.12;
    removed = spans(fine.map((v) => v < quietThr), FW)
      .filter(([a, b]) => b - a >= gap)
      .map(([a, b]) => [a === 0 ? 0 : a + 0.06, b >= fine.length * FW - 1e-6 ? dur : b - 0.01])
      .filter(([a, b]) => b - a > 0.04);
    // Check: any pause still left inside what we keep?
    const kept = (t) => !removed.some(([a, b]) => t >= a && t < b);
    let run = 0;
    silentGapsLeft = 0;
    fine.forEach((v, i) => {
      if (v < quietThr && kept(i * FW)) run++;
      else { if (run * FW >= gap + 0.08) silentGapsLeft++; run = 0; }
    });
  }
  let fillers = 0;
  if (removeSpans && removeSpans.length) {
    const ex = removeSpans.map(([a, b]) => [Math.max(0, a - 0.02), Math.min(dur, b + 0.02)]).filter(([a, b]) => b - a > 0.05);
    fillers = ex.length;
    removed = mergeSpans(removed.concat(ex));
  }
  const keep = [];
  let t = 0;
  for (const [a, b] of removed) {
    if (a > t) keep.push([r2(t), r2(a)]);
    t = b;
  }
  if (t < dur) keep.push([r2(t), Math.round(dur * 1000) / 1000]);

  // Highlights.
  const zd = zscore(smooth(db, 8));
  const zm = zscore(smooth(mo, 8));
  let score = zd.map((v, i) => 0.6 * v + 0.4 * zm[i]);
  const hy = hype(captions, n);
  if (hy.some((v) => v > 0)) {
    const zh = zscore(smooth(hy, 8));
    score = score.map((v, i) => v + 0.7 * zh[i]);
  }
  score = smooth(score, 4);
  const order = score.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const L = Math.min(shortLen, dur);
  const highlights = [];
  const taken = [];
  for (const [sc, i] of order) {
    const peak = i * WIN;
    const start = Math.max(0, Math.min(peak - L * 0.6, dur - L));
    const end = start + L;
    if (taken.some(([a, b]) => !(end <= a || start >= b))) continue;
    taken.push([start, end]);
    highlights.push({ start: r2(start), end: r2(end), peak: r2(peak), score: r2(sc) });
    if (highlights.length >= maxShorts) break;
  }
  return {
    info, keep, removed: removed.map(([a, b]) => [r2(a), r2(b)]),
    removedSeconds: r2(removed.reduce((s, [a, b]) => s + b - a, 0)), fillersRemoved: fillers, silentGapsLeft,
    quietThresholdDb: r2(thr), transcriptUsed: !!(captions && captions.length), highlights,
  };
}

module.exports = { analyze, mergeSpans, smooth, percentile, zscore, HYPE_WORDS, WIN };
