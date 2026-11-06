// 预加载：仅暴露更新器所需的最小 IPC 面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnesschat', {
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('updater:check'),
  downloadAndRun: () => ipcRenderer.invoke('updater:download'),
  onUpdateProgress: (cb) => { ipcRenderer.on('updater:progress', (_e, text) => cb(text)); },
  // 产出落点：只开落点目录内的文件，主进程那边还有一道守卫
  openPath: (p) => ipcRenderer.invoke('landing:open', p),
  showItem: (p) => ipcRenderer.invoke('landing:reveal', p)
});
