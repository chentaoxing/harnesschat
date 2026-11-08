// 预加载：仅暴露更新器、落点打开、通知回跳所需的最小 IPC 面。
// 这里**只能** require('electron')：沙箱 preload 不认仓库里的相对模块。
// 2026-11-08 实测过一次 require('./notify') → "module not found" → 整个 contextBridge
// 没暴露 → 更新器、落点打开、回跳一起死。事件名因此写成字面量，
// 与 src/notify.js 的 FOCUS_EVENT 是否漂移由 scripts/notify-checks.cjs 盯着。
const { contextBridge, ipcRenderer } = require('electron');

const FOCUS_EVENT = 'task:focus'; // === src/notify.js FOCUS_EVENT

contextBridge.exposeInMainWorld('harnesschat', {
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('updater:check'),
  downloadAndRun: () => ipcRenderer.invoke('updater:download'),
  onUpdateProgress: (cb) => { ipcRenderer.on('updater:progress', (_e, text) => cb(text)); },
  // 产出落点：只开落点目录内的文件，主进程那边还有一道守卫
  openPath: (p) => ipcRenderer.invoke('landing:open', p),
  showItem: (p) => ipcRenderer.invoke('landing:reveal', p),
  // 点了桌面通知 → 滚到那一单的卡片
  onTaskFocus: (cb) => { ipcRenderer.on(FOCUS_EVENT, (_e, taskId) => cb(String(taskId || ''))); }
});
