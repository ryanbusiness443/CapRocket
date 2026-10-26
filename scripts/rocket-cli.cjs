#!/usr/bin/env node
// RocketPilot from the command line: the same engine as the app's Auto Edit, no window needed.
//
//   node scripts/rocket-cli.cjs VIDEO [--style pro|crazy|hype|clean] [--srt captions.srt] [--hook "TEXT"]
//        [--cut dead|silence|speech|off] [--shorts 3] [--short-len 30] [--no-teaser] [--no-zooms]
//        [--fillers fillers.json] [--game Fortnite] [--draft] [--out DIR]
//
// Writes into DIR: edited.mp4, captions.srt (if any), shorts/short_N.mp4, thumbnail.jpg,
// project.json (open it in CapRocket to tweak), report.json and youtube-pack.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probe, runExport, videoLayout } = require('../electron/ffmpeg.cjs');
const { autoEdit } = require('../electron/rocket/autoedit.cjs');
const { renderShort, renderThumbnail } = require('../electron/rocket/shorts.cjs');
const { fallbackPack } = require('../electron/rocket/ai.cjs');
const { writeSrt } = require('../electron/rocket/captions.cjs');

function args() {
  const a = process.argv.slice(2);
  const o = { style: 'crazy', shorts: 3, shortLen: 30, out: 'rocket_out' };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = () => a[++i];
    if (k === '--style') o.style = v();
    else if (k === '--srt') o.srt = v();
    else if (k === '--hook') o.hook = v();
    else if (k === '--cut') o.cut = v();
    else if (k === '--shorts') o.shorts = Number(v());
    else if (k === '--short-len') o.shortLen = Number(v());
    else if (k === '--no-teaser') o.teaser = false;
    else if (k === '--no-zooms') o.jumpZooms = false;
    else if (k === '--fillers') o.fillers = JSON.parse(fs.readFileSync(v(), 'utf8')).map((x) => (Array.isArray(x) ? x : [x.start, x.end]));
    else if (k === '--game') o.game = v();
    else if (k === '--draft') o.draft = true;
    else if (k === '--out') o.out = v();
    else if (!o.video) o.video = k;
  }
  if (!o.video) {
    console.error('usage: node scripts/rocket-cli.cjs VIDEO [--style pro|crazy|hype|clean] [--srt file] [--hook text] [--out dir]');
    process.exit(2);
  }
  return o;
}

(async () => {
  const o = args();
  fs.mkdirSync(path.join(o.out, 'shorts'), { recursive: true });
  const log = (s) => process.stderr.write(s + '\n');
  const info = await probe(o.video);
  const media = { id: 'src', path: path.resolve(o.video), name: path.basename(o.video), type: 'video', ...info };
  const base = { name: path.basename(o.video), width: 1920, height: 1080, fps: 30, media: [media], videoClips: [], textClips: [], audioClips: [], effects: [], captionClips: [] };
  let last = '';
  const { project, report } = await autoEdit(base, {
    media, style: o.style, cut: o.cut, captionsFile: o.srt, hook: o.hook, shorts: o.shorts, shortLen: o.shortLen,
    teaser: o.teaser, jumpZooms: o.jumpZooms, fillers: o.fillers, sfxDir: path.join(os.homedir(), '.caprocket', 'sfx'),
  }, (step) => { if (step !== last) log(`… ${step}`); last = step; });
  fs.writeFileSync(path.join(o.out, 'project.json'), JSON.stringify(project, null, 1));

  log('… Exporting the edit');
  const edited = path.join(o.out, 'edited.mp4');
  await runExport({ ...project, draft: !!o.draft }, edited, () => {}).promise;
  if (project.captionClips.length) {
    writeSrt(project.captionClips.map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text })), path.join(o.out, 'captions.srt'));
  }
  const a = project.autoEdit;
  const pack = fallbackPack({ highlights: a.highlights.map((h, i) => ({ ...h, timeline: a.peaks[i] ?? null })), captions: a.sourceCaptions,
    editedSeconds: videoLayout(project.videoClips).slice(-1)[0].end, game: o.game || '' });
  fs.writeFileSync(path.join(o.out, 'youtube-pack.json'), JSON.stringify(pack, null, 1));

  const shorts = [];
  for (let i = 0; i < Math.min(o.shorts, a.highlights.length); i++) {
    log(`… Short ${i + 1}`);
    const f = path.join(o.out, 'shorts', `short_${i + 1}.mp4`);
    await renderShort(media, a, a.highlights[i], f, { hook: pack.hooks[i], style: a.style, sfxDir: path.join(os.homedir(), '.caprocket', 'sfx'), draft: !!o.draft });
    shorts.push(f);
  }
  await renderThumbnail(media, a.highlights[0]?.peak ?? 1, path.join(o.out, 'thumbnail.jpg'), pack.thumbnailText);
  const result = { ...report, edited, shorts, pack: path.join(o.out, 'youtube-pack.json'), project: path.join(o.out, 'project.json') };
  fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
})().catch((e) => {
  console.error(e.message.slice(-3000));
  process.exit(1);
});
