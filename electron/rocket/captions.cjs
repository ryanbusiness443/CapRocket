// Captions: SRT read/write, filler-word cleanup, retiming onto an edited timeline,
// short punchy chunks, and animated ASS subtitles (pop-in + word-by-word highlight).
const fs = require('fs');

function parseTime(s) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
}

function fmtSrtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

// Returns [{ start, end, text }] sorted by start.
function parseSrt(text) {
  const out = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a);
    const end = parseTime(b);
    const body = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && body) out.push({ start, end, text: body });
  }
  return out.sort((x, y) => x.start - y.start);
}

const readSrt = (file) => parseSrt(fs.readFileSync(file, 'utf8'));

function writeSrt(items, file) {
  const body = items.map((c, i) => `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}\n`).join('\n');
  if (file) fs.writeFileSync(file, body, 'utf8');
  return body;
}

const FILLER_RE = /(^|[^\w'])(um+|uh+|erm+|uhm+|hmm+)(?![\w'])[,.]?\s*/gi;
function cleanText(t) {
  return t.replace(FILLER_RE, '$1').replace(/\s{2,}/g, ' ').replace(/^[\s,]+/, '').trim();
}

// segments: [{ in, out, start }] = source range [in, out] placed at timeline `start`.
// Maps each caption onto the timeline; a caption whose edge falls in a removed part snaps to
// the nearest kept edge, captions entirely inside removed parts are dropped.
function remapToTimeline(items, segments) {
  const out = [];
  for (const c of items) {
    const pieces = segments.filter((s) => s.out > c.start && s.in < c.end);
    if (!pieces.length) continue;
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    const start = first.start + (Math.max(c.start, first.in) - first.in);
    const end = last.start + (Math.min(c.end, last.out) - last.in);
    const text = cleanText(c.text);
    if (text) out.push({ start, end: Math.max(end, start + 0.3), text });
  }
  return out;
}

// Splits captions into chunks of at most `maxWords` words, timed evenly.
function chunk(items, maxWords = 3) {
  const out = [];
  for (const c of items) {
    const words = c.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const n = Math.ceil(words.length / maxWords);
    const step = (c.end - c.start) / n;
    for (let k = 0; k < n; k++) {
      out.push({ start: c.start + k * step, end: c.start + (k + 1) * step, text: words.slice(k * maxWords, (k + 1) * maxWords).join(' ') });
    }
  }
  return out;
}

function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const p = (n) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
}

// ASS colours are &HBBGGRR.
function assColor(hex) {
  const h = (hex || '#ffffff').replace('#', '').padEnd(6, '0');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}

const STYLES = {
  karaoke: { upper: true, highlight: '#FFE500', pop: true, words: true },
  pop: { upper: true, highlight: null, pop: true, words: false, alternate: '#FFE500' },
  clean: { upper: false, highlight: null, pop: false, words: false },
};

// items: [{ start, end, text }] in output time. Returns the .ass text (and writes it if `file`).
function writeAss(items, { width, height, vertical = height > width, style = 'karaoke', font = 'Arial Black', file, sizeScale = 1 } = {}) {
  const st = STYLES[style] || STYLES.karaoke;
  const size = Math.round((vertical ? height * 0.052 : height * 0.06) * sizeScale);
  const marginV = Math.round(vertical ? height * 0.22 : height * 0.07);
  const outline = Math.max(3, Math.round(size / 12));
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${font},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},2,2,60,60,${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const popTag = st.pop ? '\\fad(40,60)\\fscx60\\fscy60\\t(0,90,\\fscx115\\fscy115)\\t(90,170,\\fscx100\\fscy100)' : '\\fad(60,60)';
  const lines = items.map((c, i) => {
    let t = (st.upper ? c.text.toUpperCase() : c.text).replace(/[{}]/g, '');
    const words = t.split(/\s+/).filter(Boolean);
    let body;
    if (st.words && st.highlight && words.length > 1) {
      const step = ((c.end - c.start) * 1000) / words.length;
      const hi = assColor(st.highlight);
      body = words.map((w, k) => {
        const s0 = Math.round(k * step);
        const s1 = Math.round((k + 1) * step);
        const on = `\\t(${s0},${s0 + 1},\\c${hi}\\fscx108\\fscy108)`;
        const off = k < words.length - 1 ? `\\t(${s1},${s1 + 1},\\c&HFFFFFF&\\fscx100\\fscy100)` : '';
        return `{\\c&HFFFFFF&${on}${off}}${w}`;
      }).join(' ');
    } else {
      const col = st.alternate && i % 2 ? `\\c${assColor(st.alternate)}` : '';
      body = `{${col}}${t}`;
    }
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,{${popTag}}${body}`;
  });
  const text = head.concat(lines).join('\n') + '\n';
  if (file) fs.writeFileSync(file, text, 'utf8');
  return text;
}

module.exports = { parseSrt, readSrt, writeSrt, cleanText, remapToTimeline, chunk, writeAss, assColor, fmtSrtTime };
