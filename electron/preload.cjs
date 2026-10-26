const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  importMedia: () => ipcRenderer.invoke('media:import'),
  saveProject: (json) => ipcRenderer.invoke('project:save', json),
  openProject: () => ipcRenderer.invoke('project:open'),
  exportVideo: (project) => ipcRenderer.invoke('export:start', project),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  showInFolder: (file) => ipcRenderer.invoke('shell:show', file),
  openFolder: (folder) => ipcRenderer.invoke('shell:openFolder', folder),
  // RocketPilot Auto Edit
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickCaptions: () => ipcRenderer.invoke('rocket:pickCaptions'),
  pickFillers: () => ipcRenderer.invoke('rocket:pickFillers'),
  autoEdit: (project, opts) => ipcRenderer.invoke('rocket:autoEdit', project, opts),
  renderShorts: (project, opts) => ipcRenderer.invoke('rocket:shorts', project, opts),
  renderThumbnail: (project, text, at) => ipcRenderer.invoke('rocket:thumbnail', project, text, at),
  youtubePack: (project, extra) => ipcRenderer.invoke('rocket:pack', project, extra),
  exportSrt: (project) => ipcRenderer.invoke('rocket:exportSrt', project),
  onRocketProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('rocket:progress', handler);
    return () => ipcRenderer.removeListener('rocket:progress', handler);
  },
  onExportProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
});
