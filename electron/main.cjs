const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { probe, runExport, videoLayout } = require('./ffmpeg.cjs');
const { autoEdit } = require('./rocket/autoedit.cjs');
const { renderShort, renderThumbnail } = require('./rocket/shorts.cjs');
const { generatePack, DEFAULT_MODEL } = require('./rocket/ai.cjs');
const { readSrt, writeSrt } = require('./rocket/captions.cjs');

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];

let win;
let currentExport = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#141416',
    title: 'CapRocket',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  if (process.env.FVE_SMOKE) {
    const mod = process.env.FVE_SMOKE_MODE === 'rocket' ? './smoke-rocket.cjs' : './smoke.cjs';
    win.webContents.once('did-finish-load', () => require(mod)(win, app, process.env.FVE_SMOKE));
  }
}

ipcMain.handle('media:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: [...VIDEO_EXT, ...AUDIO_EXT] },
      { name: 'Video', extensions: VIDEO_EXT },
      { name: 'Audio', extensions: AUDIO_EXT },
    ],
  });
  if (res.canceled) return [];
  const items = [];
  for (const file of res.filePaths) {
    try {
      const info = await probe(file);
      items.push({ path: file, name: path.basename(file), type: info.hasVideo ? 'video' : 'audio', ...info });
    } catch (e) {
      items.push({ path: file, name: path.basename(file), error: e.message });
    }
  }
  return items;
});

ipcMain.handle('project:save', async (_e, json) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save project',
    defaultPath: 'project.fve.json',
    filters: [{ name: 'Project', extensions: ['json'] }],
  });
  if (res.canceled) return null;
  fs.writeFileSync(res.filePath, json, 'utf8');
  return res.filePath;
});

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open project',
    properties: ['openFile'],
    filters: [{ name: 'Project', extensions: ['json'] }],
  });
  if (res.canceled) return null;
  return fs.readFileSync(res.filePaths[0], 'utf8');
});

ipcMain.handle('export:start', async (_e, project) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export video',
    defaultPath: 'export.mp4',
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (res.canceled) return { canceled: true };
  try {
    currentExport = runExport(project, res.filePath, (p) => win.webContents.send('export:progress', p));
    await currentExport.promise;
    return { ok: true, file: res.filePath };
  } catch (e) {
    if (currentExport?.canceled) return { canceled: true };
    return { ok: false, error: e.message };
  } finally {
    currentExport = null;
  }
});

ipcMain.handle('export:cancel', () => {
  if (!currentExport) return;
  currentExport.canceled = true;
  currentExport.cancel();
});
ipcMain.handle('shell:show', (_e, file) => shell.showItemInFolder(file));

// ---------------------------------------------------------------- RocketPilot Auto Edit
const sfxDir = () => path.join(app.getPath('userData'), 'sfx');
const settingsFile = () => path.join(app.getPath('userData'), 'rocket-settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (_) { return {}; }
}
function apiKey() {
  const s = readSettings();
  if (!s.apiKey) return null;
  try {
    return s.encrypted ? safeStorage.decryptString(Buffer.from(s.apiKey, 'base64')) : Buffer.from(s.apiKey, 'base64').toString('utf8');
  } catch (_) { return null; }
}
const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// The interface only learns whether a key exists, never the key itself.
ipcMain.handle('settings:get', () => {
  const s = readSettings();
  return { hasKey: !!s.apiKey, model: s.model || DEFAULT_MODEL, game: s.game || '' };
});
ipcMain.handle('settings:set', (_e, patch) => {
  const s = readSettings();
  if (patch.clearKey) delete s.apiKey;
  if (patch.apiKey) {
    const enc = safeStorage.isEncryptionAvailable();
    s.apiKey = (enc ? safeStorage.encryptString(patch.apiKey) : Buffer.from(patch.apiKey, 'utf8')).toString('base64');
    s.encrypted = enc;
  }
  if (patch.model !== undefined) s.model = patch.model;
  if (patch.game !== undefined) s.game = patch.game;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
  return { hasKey: !!s.apiKey, model: s.model || DEFAULT_MODEL, game: s.game || '' };
});

ipcMain.handle('rocket:pickCaptions', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Captions file (.srt) — from YouTube, Descript, CapCut…',
    properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt'] }],
  });
  if (res.canceled) return null;
  const items = readSrt(res.filePaths[0]);
  return { path: res.filePaths[0], name: path.basename(res.filePaths[0]), count: items.length };
});

ipcMain.handle('rocket:pickFillers', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Filler words to cut (.json: [[start, end], …] or [{start, end}])',
    properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled) return null;
  let spans = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
  if (!Array.isArray(spans)) spans = spans.remove || spans.spans || [];
  spans = spans.map((x) => (Array.isArray(x) ? x : [x.start, x.end])).filter((x) => x.every(Number.isFinite));
  return { name: path.basename(res.filePaths[0]), spans };
});

ipcMain.handle('rocket:autoEdit', async (_e, project, opts) => {
  try {
    const media = project.media.find((m) => m.id === opts.mediaId);
    if (!media) throw new Error('Pick a video first.');
    const result = await autoEdit(project, { ...opts, media, sfxDir: sfxDir() }, (step, p) => send('rocket:progress', { step, progress: p }));
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('rocket:shorts', async (_e, project, opts) => {
  const a = project.autoEdit;
  if (!a) return { ok: false, error: 'Run Auto Edit first so the highlights are known.' };
  const src = project.media.find((m) => m.id === a.sourceMediaId);
  if (!src) return { ok: false, error: 'The video Auto Edit used is no longer in the project. Import it again and re-run Auto Edit.' };
  const res = await dialog.showOpenDialog(win, { title: 'Folder for the Shorts', properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled) return { canceled: true };
  const list = a.highlights.slice(0, opts.count ?? a.highlights.length);
  const files = [];
  try {
    for (let i = 0; i < list.length; i++) {
      const out = path.join(res.filePaths[0], `short_${i + 1}.mp4`);
      await renderShort(src, a, list[i], out, { hook: opts.hooks?.[i], style: opts.style || a.style, layout: opts.layout, replay: opts.replay, sfxDir: sfxDir(), fps: project.fps },
        (p) => send('rocket:progress', { step: `Short ${i + 1} of ${list.length}`, progress: (i + p) / list.length }));
      files.push(out);
    }
    return { ok: true, files, folder: res.filePaths[0] };
  } catch (e) {
    return { ok: false, error: e.message, files };
  }
});

ipcMain.handle('rocket:thumbnail', async (_e, project, text, at) => {
  const a = project.autoEdit;
  const srcId = a?.sourceMediaId || project.videoClips[0]?.mediaId;
  const src = project.media.find((m) => m.id === srcId);
  if (!src) return { ok: false, error: 'Add a video first.' };
  const res = await dialog.showSaveDialog(win, { title: 'Save thumbnail', defaultPath: 'thumbnail.jpg', filters: [{ name: 'JPEG', extensions: ['jpg'] }] });
  if (res.canceled) return { canceled: true };
  try {
    const t = at ?? a?.highlights?.[0]?.peak ?? 1;
    await renderThumbnail(src, t, res.filePath, text);
    return { ok: true, file: res.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('rocket:pack', async (_e, project, extra = {}) => {
  const a = project.autoEdit || {};
  const s = readSettings();
  const layout = videoLayout(project.videoClips);
  const edited = layout.length ? layout[layout.length - 1].end : 0;
  const input = {
    highlights: (a.highlights || []).map((h, i) => ({ ...h, timeline: a.peaks?.[i] ?? null })),
    captions: a.sourceCaptions || null, editedSeconds: edited, game: extra.game ?? s.game ?? '', notes: extra.notes || '',
  };
  try {
    return { ok: true, pack: await generatePack(input, { apiKey: apiKey(), model: s.model || DEFAULT_MODEL }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('rocket:exportSrt', async (_e, project) => {
  const items = (project.captionClips || []).map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text }));
  if (!items.length) return { ok: false, error: 'There are no captions on the timeline.' };
  const res = await dialog.showSaveDialog(win, { title: 'Save captions for YouTube', defaultPath: 'captions.srt', filters: [{ name: 'SRT', extensions: ['srt'] }] });
  if (res.canceled) return { canceled: true };
  writeSrt(items, res.filePath);
  return { ok: true, file: res.filePath };
});

ipcMain.handle('shell:openFolder', (_e, folder) => shell.openPath(folder));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
