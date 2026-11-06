// 在真实 Electron 渲染层里验证「用量账本」面板：打开侧栏按钮，读回 DOM 文本。
// 用法：node_modules/electron/dist/electron.exe scripts/ui-usage-check.cjs （需要应用已在跑，脚本只连它的 HTTP 页面）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  // 这个脚本以裸 electron 启动，userData 是 Electron 默认目录，要显式指向 HarnessChat 的数据目录
  const token = fs.readFileSync(path.join(process.env.APPDATA, 'HarnessChat', 'token.txt'), 'utf8').trim();
  const win = new BrowserWindow({ show: false, width: 1180, height: 800 });
  await win.loadURL(`http://127.0.0.1:18790/?token=${token}`);
  await new Promise(r => setTimeout(r, 2500));
  const out = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#btn-usage').click();
    await new Promise(r => setTimeout(r, 1800));
    const rows = [...document.querySelectorAll('.usage-row')].map(el => el.innerText.replace(/\\n+/g, ' | ').trim());
    return JSON.stringify({
      open: !document.querySelector('#usage-mask').classList.contains('hidden'),
      status: document.querySelector('#usage-status').textContent,
      badge: document.querySelector('#usage-badge').textContent,
      kindSelect: [...document.querySelectorAll('#task-kind option')].map(o => o.textContent).join('/'),
      rows
    }, null, 1);
  })()`);
  console.log('UI_USAGE_PANEL=' + out);
  try { fs.writeFileSync(path.join(require('os').tmpdir(), 'hc-ui-usage.json'), 'UI_USAGE_PANEL=' + out, 'utf8'); } catch (e) { /* noop */ }
  app.exit(0);
});
