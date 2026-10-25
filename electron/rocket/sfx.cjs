// Sound effects synthesised in code: no downloads, no licences, identical on every PC.
// Each sound is written once as a 48 kHz stereo WAV in the cache folder.
const fs = require('fs');
const path = require('path');

const SR = 48000;

// Small deterministic PRNG so the sounds are the same every time.
function rng(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
const noise = (n, seed) => {
  const r = rng(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = gauss(r);
  return x;
};

// One-pole lowpass with a per-sample cutoff (number or function of i).
function lowpass(x, cutoff) {
  const y = new Float64Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const c = typeof cutoff === 'function' ? cutoff(i) : cutoff;
    const a = 1 - Math.exp((-2 * Math.PI * c) / SR);
    s += a * (x[i] - s);
    y[i] = s;
  }
  return y;
}
function normalize(x, peak = 0.89) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i] / m) * peak;
  return x;
}
const len = (d) => Math.round(d * SR);

function whoosh(d = 0.5) {
  const n = len(d);
  const a = noise(n, 1);
  const b = noise(n, 2);
  const lp = lowpass(a, (i) => 300 + 5000 * Math.sin((Math.PI * i) / n) ** 3);
  const hp = lowpass(b, 120);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = (lp[i] - hp[i]) * Math.sin((Math.PI * i) / n) ** 2;
  normalize(x);
  // pan left -> right
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pan = -0.8 + (1.6 * i) / n;
    L[i] = x[i] * Math.cos(((pan + 1) * Math.PI) / 4) * 1.41;
    R[i] = x[i] * Math.sin(((pan + 1) * Math.PI) / 4) * 1.41;
  }
  return [L, R];
}

function boom(d = 1.6) {
  const n = len(d);
  const x = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * 52 * (1 - (0.15 * t) / d)) / SR;
    const v = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * Math.exp(-t * 2.2) * Math.min(1, t * 400);
    x[i] = Math.tanh(3 * v);
  }
  return normalize(x);
}

function impact(d = 1.3) {
  const n = len(d);
  const click = lowpass(noise(n, 3), 2500);
  const tail = lowpass(noise(n, 4), 400);
  const x = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (40 + 90 * Math.exp(-t * 9))) / SR;
    const body = Math.sin(ph) * Math.exp(-t * 3.2);
    x[i] = Math.tanh(2.2 * (body + 0.8 * click[i] * Math.exp(-t * 60) + 0.35 * tail[i] * Math.exp(-t * 5)));
  }
  return normalize(x);
}

function riser(d = 2.0) {
  const n = len(d);
  const nz = lowpass(noise(n, 5), (i) => 200 + 9000 * (i / n) ** 2);
  const x = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    ph += (2 * Math.PI * (200 + 1400 * p * p)) / SR;
    const env = p ** 2.2 * (1 - Math.min(1, Math.max(0, (p - 0.97) / 0.03)));
    x[i] = (nz[i] + 0.35 * Math.sin(ph)) * env;
  }
  return normalize(x);
}

function pop(d = 0.14) {
  const n = len(d);
  const x = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (1100 * Math.exp(-t * 25) + 300)) / SR;
    x[i] = Math.sin(ph) * Math.exp(-t * 35);
  }
  return normalize(x, 0.7);
}

function glitch(d = 0.35) {
  const n = len(d);
  const r = rng(9);
  const x = new Float64Array(n);
  let f = 400;
  let gate = 1;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    if (i % 800 === 0) f = 180 + 900 * r();
    if (i % 600 === 0) gate = r() > 0.35 ? 1 : 0;
    ph += (2 * Math.PI * f) / SR;
    x[i] = Math.sign(Math.sin(ph)) * gate;
  }
  const y = lowpass(x, 4000);
  for (let i = 0; i < n; i++) y[i] *= Math.exp((-i / SR) * 4);
  return normalize(y, 0.6);
}

const SOUNDS = { whoosh, boom, impact, riser, pop, glitch };
const LABELS = { whoosh: 'Whoosh', boom: 'Bass boom', impact: 'Impact', riser: 'Riser', pop: 'Pop', glitch: 'Glitch' };

function writeWav(file, chans) {
  const [L, R] = Array.isArray(chans) ? chans : [chans, chans];
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

// Writes any missing sounds; returns { name: { path, duration, label } }.
function ensureLibrary(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lib = {};
  for (const [name, fn] of Object.entries(SOUNDS)) {
    const file = path.join(dir, `rocket-${name}.wav`);
    if (!fs.existsSync(file)) writeWav(file, fn());
    const bytes = fs.statSync(file).size - 44;
    lib[name] = { path: file, duration: bytes / 4 / SR, label: LABELS[name] };
  }
  return lib;
}

module.exports = { ensureLibrary, SOUNDS, LABELS, writeWav };
