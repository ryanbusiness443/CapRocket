// End-to-end test of RocketPilot Auto Edit without Electron:
// sample "gameplay" with a dead stretch -> Auto Edit -> export -> Short -> thumbnail -> YouTube pack.
// Run: npm run test:rocket   (uses the bundled FFmpeg, or FFMPEG_PATH / FFPROBE_PATH)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ffmpegPath, probe, runExport, videoLayout } = require('../electron/ffmpeg.cjs');
const { autoEdit } = require('../electron/rocket/autoedit.cjs');
const { renderShort, renderThumbnail } = require('../electron/rocket/shorts.cjs');
const { fallbackPack } = require('../electron/rocket/ai.cjs');

const assert = (ok, msg) => { if (!ok) throw new Error('FAILED: ' + msg); console.log('  ✓ ' + msg); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocket-test-'));
  const gen = (args) => execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  // 6 s action, 4 s dead air (still + silent), 8 s loud action, 3 s dead air, 6 s action.
  const parts = [
    ['testsrc2=s=1280x720:r=30:d=6', 'anoisesrc=d=6:a=0.08:r=48000'],
    ['color=c=0x202030:s=1280x720:r=30:d=4', 'anullsrc=r=48000:cl=stereo'],
    ['mandelbrot=s=1280x720:r=30', 'anoisesrc=d=8:a=0.6:r=48000', 8],
    ['color=c=0x202030:s=1280x720:r=30:d=3', 'anullsrc=r=48000:cl=stereo'],
    ['testsrc2=s=1280x720:r=30:d=6', 'anoisesrc=d=6:a=0.1:r=48000'],
  ];
  const files = parts.map(([v, a, d], i) => {
    const f = path.join(dir, `p${i}.mp4`);
    gen(['-f', 'lavfi', '-i', v, '-f', 'lavfi', '-i', a, '-t', String(d || /d=(\d+)/.exec(v)[1]), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-ac', '2', f]);
    return f;
  });
  const src = path.join(dir, 'gameplay.mp4');
  gen([...files.flatMap((f) => ['-i', f]), '-filter_complex', files.map((_, i) => `[${i}:v][${i}:a]`).join('') + `concat=n=${files.length}:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src]);
  const srt = path.join(dir, 'captions.srt');
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:04,000\num alright let\'s drop in\n\n2\n00:00:11,000 --> 00:00:15,000\nNO WAY he just did that!\n\n3\n00:00:22,000 --> 00:00:25,000\nok gg\n');

  const info = await probe(src);
  const media = { id: 'm1', path: src, name: 'gameplay.mp4', type: 'video', ...info };
  const base = { name: 'test', width: 1280, height: 720, fps: 30, media: [media], videoClips: [], textClips: [], audioClips: [], effects: [], captionClips: [] };

  console.log('Auto Edit…');
  const { project, report } = await autoEdit(base, { media, style: 'crazy', captionsFile: srt, hook: 'He did WHAT?!', sfxDir: path.join(dir, 'sfx'), shorts: 1, shortLen: 10 });
  assert(report.removedSeconds > 4, `dead air cut (${report.removedSeconds}s)`);
  assert(report.transitions >= 1, `${report.transitions} transitions`);
  assert(report.effects > 0 && report.sfx > 0, `${report.effects} effects, ${report.sfx} sound effects`);
  assert(report.captions >= 3 && !project.captionClips.some((c) => /\bum\b/i.test(c.text)), `${report.captions} captions, fillers removed`);
  const hl = report.highlights[0];
  assert(hl && hl.peak >= 9 && hl.peak <= 19, `highlight found in the loud part (${hl && hl.peak}s)`);

  console.log('Export…');
  const out = path.join(dir, 'edit.mp4');
  await runExport({ ...project, draft: true }, out).promise;
  const o = await probe(out);
  const expected = videoLayout(project.videoClips).slice(-1)[0].end;
  assert(Math.abs(o.duration - expected) < 0.3 && o.hasAudio && o.width === 1280, `export ${o.duration.toFixed(2)}s (expected ${expected.toFixed(2)}s)`);

  console.log('Short + thumbnail…');
  const short = path.join(dir, 'short_1.mp4');
  await renderShort(media, project.autoEdit, project.autoEdit.highlights[0], short, { hook: 'NO WAY', sfxDir: path.join(dir, 'sfx'), draft: true });
  const s = await probe(short);
  assert(s.width === 1080 && s.height === 1920 && s.hasAudio && s.duration > 10, `short ${s.width}x${s.height}, ${s.duration.toFixed(1)}s with replay`);
  const thumb = path.join(dir, 'thumb.jpg');
  await renderThumbnail(media, hl.peak, thumb, 'INSANE');
  assert(fs.statSync(thumb).size > 10000, 'thumbnail written');

  const pack = fallbackPack({ highlights: report.highlights, captions: project.autoEdit.sourceCaptions, editedSeconds: report.editedSeconds, game: 'Fortnite' });
  assert(pack.titles.length === 3 && pack.chapters[0].time === '0:00', 'YouTube pack (titles + chapters)');
  console.log('\nROCKET OK  ' + dir);
})().catch((e) => {
  console.error(e.message.slice(-3000));
  process.exit(1);
});
