// YouTube pack: hooks, thumbnail text, titles, description with chapters, tags.
// Uses Claude (Anthropic API) with the user's own key when one is saved; otherwise a
// template version built from the transcript and highlights, so the feature always works.

const DEFAULT_MODEL = 'claude-sonnet-5-5';

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Chapters for YouTube: must start at 0:00, at least 10 s apart.
function chapters(highlights, editedSeconds, names = []) {
  const pts = highlights.map((h, i) => ({ t: h.timeline ?? null, name: names[i] })).filter((h) => h.t !== null).sort((a, b) => a.t - b.t);
  const out = [{ t: 0, name: 'Intro' }];
  pts.forEach((p) => {
    const t = Math.max(0, p.t - 3);
    if (t - out[out.length - 1].t >= 10 && editedSeconds - t >= 10) out.push({ t, name: p.name || `Highlight ${out.length}` });
  });
  return out;
}

function transcriptAround(captions, t, span = 8) {
  return (captions || []).filter((c) => c.end > t - span && c.start < t + span).map((c) => c.text).join(' ');
}

const FALLBACK_HOOKS = ['He did WHAT?!', 'Wait for it…', 'No way that worked', 'Clutch of the year', 'This is insane', 'Watch till the end'];

function fallbackPack({ highlights = [], captions = null, editedSeconds = 0, game = '' }) {
  const hooks = highlights.map((h, i) => {
    const near = transcriptAround(captions, h.peak, 4);
    const m = /(no way|let'?s go|insane|clutch|oh my god|what)/i.exec(near);
    return m ? `${m[1].replace(/^lets/i, "Let's")}!`.toUpperCase() : FALLBACK_HOOKS[i % FALLBACK_HOOKS.length];
  });
  const ch = chapters(highlights, editedSeconds);
  return {
    source: 'template',
    hooks,
    thumbnailText: 'INSANE CLUTCH',
    titles: [game ? `This ${game} Clutch Was INSANE` : 'This Clutch Was INSANE', `I Can't Believe This Worked${game ? ` (${game})` : ''}`,
      game ? `${game} Moments You Have To See` : 'Moments You Have To See'],
    description: `${hooks[0] || 'You have to see this.'}\n\nThe best moments from today's session.\n\n` +
      ch.map((c) => `${mmss(c.t)} ${c.name}`).join('\n') + '\n\nSubscribe for more!',
    chapters: ch.map((c) => ({ time: mmss(c.t), name: c.name })),
    tags: [...new Set(['gaming', 'highlights', 'clutch', 'funny moments', 'gameplay', ...(game ? [game, `${game} highlights`] : [])])],
  };
}

function buildPrompt({ highlights = [], captions = null, editedSeconds = 0, game = '', notes = '' }) {
  const full = (captions || []).map((c) => c.text).join(' ').slice(0, 6000);
  const hl = highlights.map((h, i) => `Highlight ${i + 1} at ${mmss(h.timeline ?? h.peak)}: "${transcriptAround(captions, h.peak).slice(0, 400)}"`).join('\n');
  return `You write YouTube packaging for a gaming creator. Video length after editing: ${mmss(editedSeconds)}.
${game ? `Game: ${game}\n` : ''}${notes ? `Creator notes: ${notes}\n` : ''}
Transcript (may be empty):
${full || '(no transcript)'}

Highlights the editor found:
${hl || '(none)'}

Reply with ONLY a JSON object, no prose:
{"hooks": [one punchy on-screen hook per highlight, max 5 words, gaming tone],
 "thumbnailText": "2-3 words, all caps",
 "titles": [3 titles, under 60 characters, curiosity-driven, no clickbait lies],
 "chapterNames": [one short chapter name per highlight, same order],
 "descriptionIntro": "2 sentences hooking the viewer",
 "tags": [10 tags]}`;
}

function parseJson(text) {
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (!m) throw new Error('Claude did not return JSON.');
  return JSON.parse(m[0]);
}

async function generatePack(input, { apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return fallbackPack(input);
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: 'user', content: buildPrompt(input) }] }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const j = parseJson((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const base = fallbackPack(input);
  const ch = chapters(input.highlights || [], input.editedSeconds || 0, j.chapterNames || []);
  return {
    source: 'claude',
    hooks: Array.isArray(j.hooks) && j.hooks.length ? j.hooks : base.hooks,
    thumbnailText: j.thumbnailText || base.thumbnailText,
    titles: Array.isArray(j.titles) && j.titles.length ? j.titles.slice(0, 3) : base.titles,
    description: `${j.descriptionIntro || base.hooks[0] || ''}\n\n` + ch.map((c) => `${mmss(c.t)} ${c.name}`).join('\n') + '\n\nSubscribe for more!',
    chapters: ch.map((c) => ({ time: mmss(c.t), name: c.name })),
    tags: Array.isArray(j.tags) && j.tags.length ? j.tags : base.tags,
  };
}

module.exports = { generatePack, fallbackPack, buildPrompt, parseJson, chapters, DEFAULT_MODEL };
