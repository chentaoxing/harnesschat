// 产出落点的"打开"IPC。抽出来是因为主进程和界面验收脚本要用同一份守卫——
// 各写一遍的话，验收测的就不是产品里跑的那一道。
const fs = require('fs');
const landing = require('./server/landing');

// 渲染层传来的路径一律当不可信输入：只认落点目录内的绝对路径。
// 没有这道守卫，这个 IPC 就是一个任意文件打开器。
function landingTarget(p) {
  const s = typeof p === 'string' ? p : '';
  if (!landing.isOpenable(s)) return { error: '只允许打开落点目录里的文件' };
  if (!fs.existsSync(s)) return { error: '文件已经不在了（可能被清理或移动过）' };
  return { path: s };
}

function register(ipcMain, shell) {
  ipcMain.handle('landing:open', async (_e, p) => {
    const t = landingTarget(p);
    if (t.error) return t;
    const err = await shell.openPath(t.path);
    return err ? { error: String(err) } : { ok: true };
  });
  ipcMain.handle('landing:reveal', (_e, p) => {
    const t = landingTarget(p);
    if (t.error) return t;
    shell.showItemInFolder(t.path);
    return { ok: true };
  });
}

module.exports = { register, landingTarget };