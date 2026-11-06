// 在真实 Electron 渲染层里验证「门体检」面板：点侧栏按钮，读回 DOM。
// 用法：node_modules/electron/dist/electron.exe scripts/ui-health-check.cjs
// （需要应用已在跑；这个脚本只连它的 HTTP 页面，不派单、不花额度）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const token = fs.readFileSync(path.join(process.env.APPDATA, 'HarnessChat', 'token.txt'), 'utf8').trim();
  const win = new BrowserWindow({ show: false, width: 1180, height: 800 });
  await win.loadURL(`http://127.0.0.1:18790/?token=${token}`);
  await new Promise(r => setTimeout(r, 2500));
  const out = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#btn-health').click();
    await new Promise(r => setTimeout(r, 1500));
    const rows = [...document.querySelectorAll('.health-row')].map(el => el.innerText.replace(/\\n+/g, ' | ').trim());
    return JSON.stringify({
      open: !document.querySelector('#health-mask').classList.contains('hidden'),
      status: document.querySelector('#health-status').textContent,
      note: document.querySelector('.health-note').textContent.slice(0, 60),
      hasRunButton: !!document.querySelector('#btn-health-run'),
      autoCheckbox: !!document.querySelector('#health-auto') && document.querySelector('#health-auto').checked,
      rowTotal: rows.length,
      rows
    }, null, 1);
  })()`);
  console.log('UI_HEALTH_PANEL=' + out);
  try { fs.writeFileSync(path.join(require('os').tmpdir(), 'hc-ui-health.json'), 'UI_HEALTH_PANEL=' + out, 'utf8'); } catch (e) { /* noop */ }
  app.exit(0);
});
