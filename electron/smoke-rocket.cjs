// Full-app test of RocketPilot through the real IPC bridge:
//   FVE_SMOKE=<dir> FVE_SMOKE_MODE=rocket electron .
// <dir> must contain video.mp4 (and optionally captions.srt). File dialogs are answered automatically.
// Writes screenshots, outputs and result.json into <dir>.
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smokeRocket(win, app, dir) {
  const wc = win.webContents;
  const result = { steps: {}, errors: [] };
  const shot = async (name) => fs.writeFileSync(path.join(dir, name), (await win.capturePage()).toPNG());
  const run = (js) => wc.executeJavaScript(js, true);
  wc.on('console-message', (_e, level, msg) => level >= 2 && result.errors.push(msg));
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  // Answer dialogs without a human.
  dialog.showOpenDialog = async (_w, o) => {
    const title = (o && o.title) || '';
    if (/captions/i.test(title)) return { canceled: false, filePaths: [path.join(dir, 'captions.srt')] };
    if (/folder/i.test(title)) return { canceled: false, filePaths: [outDir] };
    return { canceled: false, filePaths: [path.join(dir, 'video.mp4')] };
  };
  dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: path.join(outDir, (o && o.defaultPath) || 'out.bin') });

  const skip = (process.env.FVE_SMOKE_SKIP || '').split(',').filter(Boolean);
  const step = async (name, fn) => {
    if (skip.includes(name)) return;
    const t = Date.now();
    try {
      result.steps[name] = { ok: true, ...(await fn()), seconds: (Date.now() - t) / 1000 };
    } catch (e) {
      result.steps[name] = { ok: false, error: String(e && e.message || e).slice(0, 2000), seconds: (Date.now() - t) / 1000 };
    }
  };

  try {
    await wait(800);
    await step('import', () => run(`(async () => {
      const items = await window.api.importMedia();
      window.__fve.dispatch({ type: 'addMedia', items: items.map((i) => ({ ...i, id: 'src' })) });
      return { items: items.length, duration: items[0].duration, fps: items[0].fps };
    })()`));

    const hasSrt = fs.existsSync(path.join(dir, 'captions.srt'));
    await step('autoEdit', () => run(`(async () => {
      const caps = ${hasSrt} ? await window.api.pickCaptions() : null;
      const r = await window.api.autoEdit(window.__fve.project(), { mediaId: 'src', style: 'crazy', cut: 'dead', minGap: 1.2,
        transitions: true, effects: true, sfx: true, captionsFile: caps && caps.path, captionStyle: 'karaoke', hook: 'He did WHAT?!', shorts: 2, shortLen: 15 });
      if (!r.ok) throw new Error(r.error);
      window.__fve.dispatch({ type: 'replace', project: r.project });
      window.__fve.seek(0);
      return { report: r.report };
    })()`));
    await wait(1200);
    await shot('1-auto-edit.png');

    if (process.env.FVE_SMOKE_JS) await run(process.env.FVE_SMOKE_JS);
    // Playback smoothness: play 4 s across a cut/transition and measure frame pacing.
    await step('playback', () => run(`(async () => {
      const p = window.__fve.project();
      const peaks = (p.autoEdit && p.autoEdit.peaks) || [2];
      const peak = Math.max(...peaks);
      window.__fve.seek(Math.max(0, peak - 2));
      await new Promise((r) => setTimeout(r, 600));
      const gaps = []; let last = performance.now(); let run = true;
      const loop = (t) => { gaps.push(t - last); last = t; if (run) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      const tc0 = document.querySelector('.tc').textContent;
      window.__fve.play();
      await new Promise((r) => setTimeout(r, 4000));
      window.__fve.pause(); run = false;
      const v = document.querySelector('.stage video');
      gaps.sort((a, b) => a - b);
      return { tc0, tc1: document.querySelector('.tc').textContent, frames: gaps.length,
        p95ms: Math.round(gaps[Math.floor(gaps.length * 0.95)]), maxms: Math.round(gaps[gaps.length - 1]),
        videoReady: v.readyState, audioEls: document.querySelectorAll('.stage audio').length,
        clips: p.videoClips.length, playheadVisible: (() => { const s = document.querySelector('.tl-scroll'); const ph = document.querySelector('.playhead');
          const a = s.getBoundingClientRect(); const b = ph.getBoundingClientRect(); return b.left >= a.left && b.left <= a.right; })() };
    })()`));
    await shot('2-played.png');

    await step('export', () => run(`(async () => {
      const p = { ...window.__fve.project(), draft: true };
      let last = 0; const off = window.api.onExportProgress((x) => { last = x; });
      const r = await window.api.exportVideo(p); off();
      if (!r.ok) throw new Error(r.error || 'canceled');
      return { file: r.file, lastProgress: last };
    })()`));

    await step('shorts', () => run(`(async () => {
      const r = await window.api.renderShorts(window.__fve.project(), { hooks: ['NO WAY', 'CLUTCH'], layout: 'crop45', replay: true, count: 2 });
      if (!r.ok) throw new Error(r.error || 'canceled');
      return { files: r.files };
    })()`));

    await step('pack', () => run(`(async () => {
      const r = await window.api.youtubePack(window.__fve.project(), { game: 'Fortnite' });
      if (!r.ok) throw new Error(r.error);
      return { source: r.pack.source, titles: r.pack.titles, chapters: r.pack.chapters };
    })()`));
    await step('thumbnail', () => run(`window.api.renderThumbnail(window.__fve.project(), 'INSANE CLUTCH')`));
    await step('srt', () => run(`window.api.exportSrt(window.__fve.project())`));
    await step('settings', () => run(`(async () => {
      const a = await window.api.setSettings({ apiKey: 'sk-test', game: 'Fortnite' });
      const b = await window.api.getSettings();
      const c = await window.api.setSettings({ clearKey: true });
      return { saved: a.hasKey, readBack: b.hasKey && !('apiKey' in b), cleared: !c.hasKey };
    })()`));

    // UI: open each dialog once.
    await run(`window.__fve.open('auto')`); await wait(400); await shot('3-dialog-auto.png');
    await run(`window.__fve.open('pack')`); await wait(400); await shot('4-dialog-pack.png');
    await run(`window.__fve.open(null)`);
  } catch (e) {
    result.fatal = String(e && e.message || e);
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  app.quit();
};
