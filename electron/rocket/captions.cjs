// Captions: SRT read/write, filler-word cleanup, retiming onto an edited timeline,
// short punchy chunks, and animated ASS subtitles (pop-in + word-by-word highlight).
const fs = require('fs');
const path = require('path');

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

// Money in full: "$11.5k" -> "$11,500", "2k dollars" -> "$2,000". Other counts ("10k views") stay as spoken.
function formatMoney(t) {
  const full = (n, unit) => {
    const v = Math.round(parseFloat(n) * ({ k: 1e3, m: 1e6, b: 1e9 }[(unit || '').toLowerCase()] || 1));
    return '$' + v.toLocaleString('en-US');
  };
  return t
    .replace(/\$\s?(\d+(?:\.\d+)?)\s?([kmb])\b/gi, (_, n, u) => full(n, u))
    .replace(/\$(\d{4,})(?![\d,])/g, (_, n) => full(n))
    .replace(/\b(\d+(?:\.\d+)?)\s?([kmb])?\s+(?:dollars|bucks)\b/gi, (_, n, u) => full(n, u));
}

function cleanText(t) {
  return formatMoney(t.replace(FILLER_RE, '$1').replace(/\s{2,}/g, ' ').replace(/^[\s,]+/, '').trim());
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

// A chunk never ends on one of these (rule: never end a caption on a weak word).
const WEAK = new Set(['a', 'an', 'the', 'to', 'my', 'and', 'of', 'in', 'on', 'at', 'for', 'with', 'is', 'i', 'your', 'our', 'but', 'or', 'so', 'it', 'this', 'that', 'be']);
const isWeak = (w) => WEAK.has(w.toLowerCase().replace(/[^a-z']/g, ''));

// Splits captions into short chunks (<= maxWords), timed by word count, never ending on a weak word.
function chunk(items, maxWords = 3) {
  const out = [];
  for (const c of items) {
    const words = c.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const per = (c.end - c.start) / words.length;
    let i = 0;
    while (i < words.length) {
      let n = Math.min(maxWords, words.length - i);
      // shorten while the chunk would end on a weak word and more words follow
      while (n > 1 && i + n < words.length && isWeak(words[i + n - 1])) n--;
      // a lone weak word pulls in the next one instead
      if (n === 1 && isWeak(words[i]) && i + 1 < words.length) n = 2;
      out.push({ start: c.start + i * per, end: c.start + (i + n) * per, text: words.slice(i, i + n).join(' ') });
      i += n;
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
  read: { upper: false, highlight: null, pop: false, words: false, read: true },
  karaoke: { upper: true, highlight: '#FFE500', pop: true, words: true },
  pop: { upper: true, highlight: null, pop: true, words: false, alternate: '#FFE500' },
  clean: { upper: false, highlight: null, pop: false, words: false },
};

// items: [{ start, end, text }] in output time. Returns the .ass text (and writes it if `file`).
function writeAss(items, { width, height, vertical = height > width, style = 'karaoke', font = 'Arial Black', file, sizeScale = 1 } = {}) {
  const st = STYLES[style] || STYLES.karaoke;
  if (st.read) return writeReadAss(items, { width, height, vertical, file, sizeScale });
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

// Pro "read" captions: TikTok Sans, pure white, one centred line, soft shadow only (black 20%, blur 13 px),
// no outline / box / highlight / animation. 52 px on a 1080-wide frame; centred at y 1055 of 1920
// (on the mouth) in vertical video, in the lower third for 16:9.
function writeReadAss(items, { width, height, vertical, file, sizeScale = 1 }) {
  const ref = Math.min(width, height);
  const size = Math.round(ref * (52 / 1080) * sizeScale);
  const blur = Math.max(1, Math.round(ref * (13 / 1080)));
  const x = Math.round(width / 2);
  const y = Math.round(vertical ? height * (1055 / 1920) : height * 0.82);
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Read,TikTok Sans SemiBold,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,20,20,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = [];
  for (const c of items) {
    const t = c.text.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    const s = assTime(c.start);
    const e = assTime(c.end);
    // soft shadow: the same words in black at 20 % opacity, blurred, under the white text
    lines.push(`Dialogue: 0,${s},${e},Read,,0,0,0,,{\\an5\\pos(${x},${y})\\1c&H000000&\\1a&HCC&\\blur${blur}}${t}`);
    lines.push(`Dialogue: 1,${s},${e},Read,,0,0,0,,{\\an5\\pos(${x},${y})}${t}`);
  }
  const text = head.concat(lines).join('\n') + '\n';
  if (file) fs.writeFileSync(file, text, 'utf8');
  return text;
}

const FONTS_DIR = path.join(__dirname, 'fonts').replace('app.asar', 'app.asar.unpacked');

module.exports = { formatMoney, isWeak, FONTS_DIR, parseSrt, readSrt, writeSrt, cleanText, remapToTimeline, chunk, writeAss, assColor, fmtSrtTime };
