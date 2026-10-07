// 端到端验证更新器（真 Electron 主进程 + 真网络栈，不弹窗）
const { app } = require('electron');
const updater = require('../src/updater');

app.whenReady().then(async () => {
  console.log('CURRENT_VERSION=' + app.getVersion());
  const c = await updater.check();
  console.log('CHECK=' + JSON.stringify(c));
  if (process.env.HC_INSTALL === '1') {
    let last = '';
    const r = await updater.downloadAndRun((t) => { if (t !== last) { last = t; console.log('PROGRESS=' + t); } });
    console.log('DOWNLOAD=' + JSON.stringify(r));
  }
  app.exit(0);
});
