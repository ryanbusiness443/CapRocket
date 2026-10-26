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
  console.log('Long take: punch-in zooms + teaser…');
  const longSrc = path.join(dir, 'long.mp4');
  gen(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=75', '-f', 'lavfi', '-i', 'anoisesrc=d=75:a=0.1:r=48000',
    '-af', 'volume=enable=between(t\\,50\\,54):volume=8', '-t', '75', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-ac', '2', longSrc]);
  const li = await probe(longSrc);
  const lm = { id: 'm2', path: longSrc, name: 'long.mp4', type: 'video', ...li };
  const r2 = await autoEdit({ ...base, media: [lm] }, { media: lm, style: 'hype', sfxDir: path.join(dir, 'sfx'), shorts: 1, shortLen: 10 });
  assert(r2.report.jumpZooms >= 1 && r2.project.videoClips.every((c) => c.out - c.in <= 15.01), `${r2.report.jumpZooms} punch-in zoom(s); no shot longer than 15 s`);
  assert(r2.report.teaser && r2.project.videoClips[0].teaser, 'teaser opens the video');
  assert(Math.abs(r2.report.highlights[0].peak - 52) < 3 && r2.report.highlights[0].timeline > 3, 'highlight maps into the main edit, not the teaser');
  const lout = path.join(dir, 'long_edit.mp4');
  await runExport({ ...r2.project, draft: true }, lout).promise;
  const lo = await probe(lout);
  const lexp = videoLayout(r2.project.videoClips).slice(-1)[0].end;
  assert(Math.abs(lo.duration - lexp) < 0.3, `zoomed export ${lo.duration.toFixed(2)}s (expected ${lexp.toFixed(2)}s)`);

  console.log('Pro style (talking): zero dead space, read captions, money in full…');
  const talk = path.join(dir, 'talk.mp4');
  // 30 s of "speech" with a 0.6 s room-tone pause every 3 s (10 pauses)
  gen(['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=30', '-f', 'lavfi', '-i', 'anoisesrc=d=30:a=0.3:r=48000',
    '-af', "volume='if(lt(mod(t,3),2.4),1,0.01)':eval=frame", '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-ac', '2', talk]);
  const tsrt = path.join(dir, 'talk.srt');
  fs.writeFileSync(tsrt, '1\n00:00:00,500 --> 00:00:04,000\nso I went to the bank and we hit $11.5k MRR\n');
  const ti = await probe(talk);
  const tm = { id: 'm3', path: talk, name: 'talk.mp4', type: 'video', ...ti };
  const r3 = await autoEdit({ ...base, media: [tm] }, { media: tm, style: 'pro', captionsFile: tsrt, sfxDir: path.join(dir, 'sfx'), shorts: 1, shortLen: 10 });
  // each 0.6 s pause loses all but 60 ms of word fade + 10 ms lead-in -> ~0.53 s x 10
  assert(r3.report.removedSeconds > 4.8 && r3.report.removedSeconds < 5.8 && r3.report.silentGapsLeft === 0, `pauses cut: ${r3.report.removedSeconds}s (~5.3s expected), ${r3.report.silentGapsLeft} left`);
  assert(r3.report.transitions === 0 && r3.report.effects === 0 && r3.report.sfx === 0, 'Pro: hard cuts, no effects, no SFX');
  const texts = r3.project.captionClips.map((c) => c.text);
  assert(texts.includes('$11,500 MRR'), `money in full (${texts.join(' | ')})`);
  assert(!texts.some((t) => /\b(a|the|to|my|and)$/i.test(t)), 'no caption ends on a weak word');
  assert(r3.project.captionStyle.style === 'read', 'read captions');

  console.log('\nROCKET OK  ' + dir);
})().catch((e) => {
  console.error(e.message.slice(-3000));
  process.exit(1);
});
