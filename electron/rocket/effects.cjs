// Shared FFmpeg filter builders for transitions, highlight "hit" effects and animated text.
// Used by the project export (ffmpeg.cjs) and the Shorts renderer.

// FFmpeg xfade transitions with friendly names (shown in the Inspector).
const TRANSITIONS = {
  fade: 'Crossfade', fadewhite: 'Flash white', fadeblack: 'Dip to black', zoomin: 'Zoom in', pixelize: 'Pixelate',
  radial: 'Radial wipe', hblur: 'Blur', circleopen: 'Circle open', circleclose: 'Circle close', squeezeh: 'Squeeze',
  slideleft: 'Slide left', slideright: 'Slide right', smoothleft: 'Smooth left', hrwind: 'Wind', diagtl: 'Diagonal',
  coverup: 'Cover up', rectcrop: 'Rectangle', wipeleft: 'Wipe left', dissolve: 'Dissolve', hlslice: 'Slices',
};

// Auto Edit styles.
const STYLES = {
  clean: { label: 'Clean', transitions: ['fade'], duration: 0.25, hits: [], sfx: false },
  hype: { label: 'Hype', transitions: ['fadewhite', 'zoomin', 'smoothleft', 'slideleft'], duration: 0.3, hits: ['flash', 'shake'], sfx: true },
  crazy: {
    label: 'Crazy',
    transitions: ['zoomin', 'pixelize', 'radial', 'hblur', 'circleopen', 'fadewhite', 'squeezeh', 'slideleft', 'hrwind', 'diagtl', 'coverup', 'rectcrop'],
    duration: 0.35, hits: ['glitch', 'flash', 'shake', 'trails'], sfx: true,
  },
};

// Effects that can sit on the Effects track. Each lasts `duration` from `start`.
const EFFECTS = {
  glitch: { label: 'Glitch', duration: 0.26 },
  flash: { label: 'Flash', duration: 0.11 },
  shake: { label: 'Camera shake', duration: 0.4 },
  trails: { label: 'Motion trails', duration: 0.95 },
  invert: { label: 'Invert hit', duration: 0.05 },
  boost: { label: 'Color boost', duration: 0.9 },
};

const n3 = (v) => Number(v).toFixed(3);
const between = (a, b) => `between(t,${n3(a)},${n3(b)})`;

// Turns Effects-track items into a comma-joined filter chain for a W x H stream ('' when none).
// Items of the same type (and intensity) share ONE filter whose `enable` covers all their time ranges:
// filters like lagfun keep working on every frame even when disabled, so one instance per highlight
// would multiply the cost of the whole export.
function effectChain(effects, W, H) {
  const groups = new Map();
  const shakes = [];
  for (const e of effects || []) {
    const d = e.duration ?? EFFECTS[e.type]?.duration ?? 0.3;
    const k = Math.round((e.intensity ?? 1) * 20) / 20;
    if (e.type === 'shake') {
      shakes.push({ s: e.start, d, amp: (W < H ? 18 : 14) * k });
      continue;
    }
    if (!EFFECTS[e.type]) continue;
    const key = `${e.type}:${k}`;
    if (!groups.has(key)) groups.set(key, { type: e.type, k, ranges: [] });
    groups.get(key).ranges.push([e.start, e.start + d]);
  }
  const anyOf = (ranges, f0 = 0, f1 = 1) => ranges.map(([a, b]) => between(a + (b - a) * f0, a + (b - a) * f1)).join('+');
  const parts = [];
  for (const { type, k, ranges } of groups.values()) {
    switch (type) {
      case 'glitch': {
        const sh = Math.round(22 * k);
        // chromashift works on YUV directly (rgbashift would convert every frame to RGB and back).
        parts.push(`chromashift=cbh=-${sh}:crh=${sh}:cbv=${Math.round(6 * k)}:edge=smear:enable='${anyOf(ranges)}'`,
          `noise=alls=${Math.round(38 * k)}:allf=t:enable='${anyOf(ranges)}'`);
        break;
      }
      case 'flash': {
        const a = Math.min(0.95, 0.6 * k);
        parts.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@${a.toFixed(2)}:t=fill:enable='${anyOf(ranges, 0, 0.36)}'`,
          `drawbox=x=0:y=0:w=iw:h=ih:color=white@${(a / 2).toFixed(2)}:t=fill:enable='${anyOf(ranges, 0.36, 1)}'`);
        break;
      }
      case 'invert':
        parts.push(`negate=enable='${anyOf(ranges)}'`);
        break;
      case 'boost':
        parts.push(`hue=s=${(1 + 0.7 * k).toFixed(2)}:enable='${anyOf(ranges)}'`);
        break;
      case 'trails':
        parts.push(`lagfun=decay=${Math.min(0.97, 0.86 + 0.04 * k).toFixed(2)}:enable='${anyOf(ranges)}'`);
        break;
      default:
        break;
    }
  }
  if (shakes.length) {
    const term = (f, ph) => shakes.map(({ s, d, amp }) =>
      `if(${between(s, s + d)},${amp.toFixed(1)}*sin(t*${f}+${ph})*(1-(t-${n3(s)})/${n3(d)}),0)`).join('+');
    const sw = Math.floor((W * 1.04) / 2) * 2;
    const sh = Math.floor((H * 1.04) / 2) * 2;
    parts.push(`scale=${sw}:${sh},crop=${W}:${H}:x='(${sw}-${W})/2+${term(95, 0)}':y='(${sh}-${H})/2+${term(71, 1.3)}'`);
  }
  return parts.join(',');
}

// The "hit" bundle the Auto Edit puts on each highlight, for a given style.
function hitEffects(peak, style) {
  const st = STYLES[style] || STYLES.crazy;
  const out = [];
  for (const type of st.hits) {
    if (type === 'glitch') out.push({ type: 'glitch', start: Math.max(0, peak - 0.14), duration: 0.26 }, { type: 'invert', start: peak, duration: 0.05 });
    else if (type === 'trails') out.push({ type: 'trails', start: peak + 0.05, duration: 0.95 }, { type: 'boost', start: peak, duration: 0.9 });
    else out.push({ type, start: peak, duration: EFFECTS[type].duration });
  }
  return out;
}

function escText(t) {
  return t.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%').replace(/,/g, '\\,');
}

// Bouncy pop-in drawtext. `font` is a font file path already escaped for filters.
function popText({ fontExpr, textExpr, size, x, y, start, end, color = 'white', box = true }) {
  const rel = `(t-${n3(start)})`;
  const fs = `${size}*(1+0.55*exp(-${rel}*7)*cos(${rel}*15))`;
  return `drawtext=fontfile=${fontExpr}:${textExpr}:fontcolor=${color}:borderw=${Math.max(3, Math.round(size / 10))}:bordercolor=black:` +
    (box ? 'box=1:boxcolor=black@0.35:boxborderw=18:' : '') +
    `x=${x}:y=${y}:fontsize='${fs}':alpha='min(1,max(0,${rel}*8))':enable='${between(start, end)}'`;
}

module.exports = { TRANSITIONS, STYLES, EFFECTS, effectChain, hitEffects, popText, escText };
