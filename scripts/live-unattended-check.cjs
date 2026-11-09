// 装机版 0.9.0 的现场验收：连**正在跑的装机版**的页面，跑产品自己那几份模块。
// 用法：node_modules/electron/dist/electron.exe scripts/live-unattended-check.cjs
// 不派单、不花额度、不下载安装包。
//
// 两个必须说清的点：
//  1. preload 的 IPC 打到的是**创建这个窗口的进程**（也就是本脚本），不是装机版进程。
//     所以这里注册的是产品同一份 src/updater 与 src/landing-ipc（与 ui-landing-check 同法）。
//     第一版没注册就 invoke，直接 "No handler registered" —— 那是测试自己搭的空壳，不是产品坏了。
//  2. 为了证明"装机版跑的确实是这份代码"，先从装机版 asar 里取出 package.json / preload.js /
//     updater.js / notify.js，与仓库源文件逐字节比。比过了，下面用仓库模块跑才算量到装机版。
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('../src/updater');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(process.env.LOCALAPPDATA, 'Programs', 'HarnessChat');
const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 与产品 main.js 同一组 handler。
// app:version 在**本脚本进程**里会回 Electron 自己的版本（实测 44.6.0），不是装机版的 0.9.0——
// 跨进程量不到装机版的 app.getVersion()。所以这里回"从装机版 asar 里读出来的版本"，
// 那正是装机版自己的 handler 会回的值；版本真伪另由 asar 逐字节比对独立证明。
let installedVersion = '';
ipcMain.handle('app:version', () => installedVersion);
ipcMain.handle('updater:check', () => updater.check());
require('../src/landing-ipc').register(ipcMain, shell);

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('LIVE_UNATTENDED_TIMEOUT'); app.exit(1); }, 150000);
  try {
    // ---------- 装机版产物与仓库源文件逐字节相同 ----------
    const asar = require('@electron/asar');
    const asarPath = path.join(INSTALL, 'resources', 'app.asar');
    const installedPkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
    check('装机版 asar 里的版本是 0.9.0', installedPkg.version === '0.9.0', installedPkg.version);
    installedVersion = installedPkg.version;
    // updater.check() 内部读的是 app.getVersion()，不是上面那个 IPC handler。
    // 本进程的 app.getVersion() 是 Electron 自己的 44.6.0，会让 updateAvailable 变成
    // "因为 44.6.0 比 0.9.0 新所以没更新"——假绿。能设就设成装机版真实版本。
    const canSetVersion = typeof app.setVersion === 'function';
    if (canSetVersion) app.setVersion(installedVersion);
    check('本进程版本已对齐装机版（否则 updateAvailable 不可信）', !canSetVersion || app.getVersion() === installedVersion, `canSet=${canSetVersion} now=${app.getVersion()}`);
    for (const rel of ['src/preload.js', 'src/updater.js', 'src/notify.js', 'src/notify-electron.js', 'src/renderer/door-label.js', 'src/renderer/app.js', 'src/main.js']) {
      const a = asar.extractFile(asarPath, rel.replace(/\//g, path.sep));
      const b = fs.readFileSync(path.join(ROOT, rel));
      check(`装机版与仓库逐字节相同：${rel}`, Buffer.compare(a, b) === 0, `installed=${a.length}B repo=${b.length}B`);
    }

    const token = fs.readFileSync(path.join(process.env.APPDATA, 'HarnessChat', 'token.txt'), 'utf8').trim();
    const win = new BrowserWindow({
      show: false, width: 1180, height: 800,
      webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true }
    });
    await win.loadURL(`http://127.0.0.1:18790/?token=${token}`);
    await sleep(3000);

    const out = await win.webContents.executeJavaScript(`(async () => {
      const R = {};
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      R.bridgeKeys = window.harnesschat ? Object.keys(window.harnesschat) : [];
      R.version = window.harnesschat ? await window.harnesschat.version() : '';
      R.memberTotal = document.querySelectorAll('#member-list .member').length;
      R.badges = [...document.querySelectorAll('#member-list .member')].map(d => ({
        name: (d.querySelector('.m-name')||{}).innerText,
        badge: d.querySelector('.door-badge') ? d.querySelector('.door-badge').innerText.trim() : null,
        cls: d.querySelector('.door-badge') ? d.querySelector('.door-badge').className : ''
      }));
      R.hintExists = !!document.querySelector('#door-hint');
      document.querySelector('#btn-settings').click();
      await sleep(500);
      R.notifyToggle = !!document.querySelector('#set-notify');
      R.notifyChecked = document.querySelector('#set-notify') ? document.querySelector('#set-notify').checked : null;
      document.querySelector('#btn-settings-cancel').click();
      await sleep(200);
      const input = document.querySelector('#input');
      input.value = '@';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(500);
      R.popItems = document.querySelectorAll('#mention-pop .mention-item').length;
      R.popBadges = document.querySelectorAll('#mention-pop .mention-item .door-badge').length;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify(R);
    })()`);
    const R = JSON.parse(out);
    console.log('LIVE_DOM=' + out);

    check('桥的 invoke 真的 round-trip（值取自装机版 asar）', R.version === installedPkg.version, `${R.version} vs ${installedPkg.version}`);
    check('桥齐全（更新器+落点+回跳）', ['version','checkUpdate','downloadAndRun','onUpdateProgress','openPath','showItem','onTaskFocus'].every(k => R.bridgeKeys.includes(k)), R.bridgeKeys.join(','));
    check('真实成员列表每行都有门徽标', R.memberTotal > 0 && R.badges.every(b => b.badge), JSON.stringify(R.badges));
    check('徽标只用产品认得的形状', R.badges.every(b => /green|red|chatter|stale|pending|none/.test(b.cls)), JSON.stringify(R.badges.map(b => b.cls)));
    check('提醒条容器在装机版页面里存在', R.hintExists === true, String(R.hintExists));
    check('设置里有完成通知开关', R.notifyToggle === true, String(R.notifyToggle));
    check('开关默认开', R.notifyChecked === true, String(R.notifyChecked));
    check('@ 名单在真实数据上也带徽标', R.popItems > 0 && R.popBadges === R.popItems, `${R.popBadges}/${R.popItems}`);

    // 应用内更新器走 Electron net.request（系统代理），与 shell 的 HTTPS_PROXY 不是同一条路。
    // 发版后 shell curl 对新资产回 504、直连回 206，所以这条必须在应用里真跑一次才算数。
    const upd = await win.webContents.executeJavaScript(`(async () => {
      try { return JSON.stringify(await window.harnesschat.checkUpdate()); }
      catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
    })()`);
    console.log('LIVE_UPDATER=' + upd);
    let U = {}; try { U = JSON.parse(upd); } catch (e) { /* noop */ }
    check('应用内更新器真的拿到了 latest（不是 504/超时/配额）', U.ok === true && U.latest === '0.9.0', upd.slice(0, 240));
    check('当前已是最新，不该误报有更新', U.ok === true && U.current === '0.9.0' && U.updateAvailable === false, JSON.stringify({ cur: U.current, latest: U.latest, up: U.updateAvailable }));
    // 正对照：判据本身分得清"有更新"，否则上一条恒绿等于没量
    check('isNewer 正对照：0.9.0 对 0.8.0 该说有更新', updater.isNewer('0.9.0', '0.8.0') === true);
    check('isNewer 反对照：同版本不该说有更新', updater.isNewer('0.9.0', '0.9.0') === false);
    check('更新器如实标注来源（api 或 atom 回退）', U.ok === true && (U.source === 'api' || U.source === 'atom'), U.source);
    check('走 api 时认得出安装包资产名；走 atom 时不假造', U.ok === true && (U.source === 'atom' ? U.assetName === null : /HarnessChat-Setup-0\.9\.0\.exe/.test(U.assetName || '')), JSON.stringify({ source: U.source, asset: U.assetName }));
    win.destroy();
  } catch (e) {
    check('现场验收脚本本身没炸', false, String((e && e.stack) || e).slice(0, 400));
  }
  for (const n of oks) console.log('  ok  ' + n);
  for (const n of fails) console.log('  FAIL ' + n);
  const pass = fails.length === 0;
  console.log(`\nLIVE_UNATTENDED_${pass ? 'OK' : 'FAILED'} ${oks.length}/${oks.length + fails.length}`);
  try { fs.writeFileSync(path.join(os.tmpdir(), 'hc-live-unattended.json'), JSON.stringify({ ok: oks, fail: fails }, null, 1), 'utf8'); } catch (e) { /* noop */ }
  clearTimeout(watchdog);
  app.exit(pass ? 0 : 1);
});