// 预加载：仅暴露更新器所需的最小 IPC 面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnesschat', {
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('updater:check'),
  downloadAndRun: () => ipcRenderer.invoke('updater:download'),
  onUpdateProgress: (cb) => { ipcRenderer.on('updater:progress', (_e, text) => cb(text)); }
});
