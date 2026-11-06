// 在真实 Electron 渲染层里验证「产出落点」块：卡片上要看得见文件、点得开。
// 用法：node_modules/electron/dist/electron.exe scripts/ui-landing-check.cjs
// （需要应用已在跑；这个脚本不派单、不花额度，只往 DOM 里渲染一张带落点的卡片）
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 注册与产品主进程**同一份**落点 IPC：否则这里测的是"没有处理器"，
// 而不是产品里那道守卫（上一版就是这么挂住的：invoke 无人接 → Promise 永不落地）。
require('../src/landing-ipc').register(ipcMain, shell);

app.whenReady().then(async () => {
  // 看门狗：验收脚本本身不许挂住（上一版就是因为 invoke 无人接而永不落地）
  const watchdog = setTimeout(() => { console.log('UI_LANDING_TIMEOUT'); app.exit(1); }, 60000);
  const token = fs.readFileSync(path.join(process.env.APPDATA, 'HarnessChat', 'token.txt'), 'utf8').trim();
  // 造一个真的落点文件，按钮指向它——"点得开"必须是真路径，不是占位串
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ui-land-'));
  const landDir = path.join(dir, '_落点', 'uitask');
  fs.mkdirSync(landDir, { recursive: true });
  const ansAbs = path.join(landDir, '回答.md');
  fs.writeFileSync(ansAbs, '界面验收用的回答原文\n', 'utf8');

  const win = new BrowserWindow({ show: false, width: 1180, height: 800, webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js'), contextIsolation: true } });
  await win.loadURL(`http://127.0.0.1:18790/?token=${token}`);
  await new Promise(r => setTimeout(r, 2500));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const abs = ${JSON.stringify(ansAbs)};
    const msg = {
      id: 'ui-landing-probe', type: 'task', threadId: null, memberId: 'probe', memberName: '界面验收',
      color: '#888', prompt: '只回答，不写盘', text: '界面验收用的回答原文', status: 'done', at: Date.now(),
      model: '', cwd: ${JSON.stringify(dir)}, taskKind: 'execute',
      delivery: {
        verdict: 'talked_only', changed: 0, partial: false, artifacts: [],
        headline: '文件没变化（0 个）', reason: '它自述做了事，但盘上零变化。', next: '……', cwd: ${JSON.stringify(dir)},
        landing: { ok: true, dir: ${JSON.stringify(landDir)}, truncated: false,
          files: [{ name: '回答.md', abs, size: 30, kind: 'answer' }],
          note: '控制台把它的回答原文落成了 1 个文件（不是它自己写的文件，别当成它动了手）：回答.md' }
      }
    };
    renderMessage(msg);
    await new Promise(r => setTimeout(r, 300));
    const card = document.querySelector('[data-task-id="ui-landing-probe"]');
    const block = card && card.querySelector('.task-landing');
    const btns = block ? [...block.querySelectorAll('.ld-file')] : [];
    // 真点一次：打开的是盘上真文件，按钮不该变成"打不开"
    let clickResult = 'no-button';
    if (btns[0]) {
      btns[0].click();
      await new Promise(r => setTimeout(r, 1800));
      clickResult = btns[0].innerText.trim();
    }
    // 守卫：落点目录外的路径必须被主进程拒掉（否则这就是个任意文件打开器）
    const guard = await window.harnesschat.openPath('C:\\\\Windows\\\\win.ini');
    const traversal = await window.harnesschat.openPath(${JSON.stringify(dir)} + '\\\\_落点\\\\..\\\\..\\\\evil.txt');
    return JSON.stringify({
      hasBlock: !!block,
      noteShown: !!block && /回答原文/.test(block.innerText),
      saysNotMemberWritten: !!block && /不是它自己写的/.test(block.innerText),
      fileButtons: btns.length,
      firstLabel: btns[0] ? btns[0].innerText.trim() : '',
      firstAbs: btns[0] ? btns[0].getAttribute('data-abs') : '',
      hasOpenFolder: !!block && !!block.querySelector('.ld-dir'),
      bridgeExists: !!(window.harnesschat && window.harnesschat.openPath),
      verdictStillHonest: !!card && /只动了嘴/.test(card.innerText),
      clickResult,
      clickOpened: !/打不开/.test(clickResult),
      guardRejected: !!(guard && guard.error),
      guardMessage: guard && guard.error,
      traversalRejected: !!(traversal && traversal.error)
    }, null, 1);
  })()`);
  console.log('UI_LANDING=' + out);
  const j = JSON.parse(out);
  const pass = j.hasBlock && j.noteShown && j.saysNotMemberWritten && j.fileButtons === 1 && j.firstAbs === ansAbs && j.hasOpenFolder && j.bridgeExists && j.verdictStillHonest && j.clickOpened && j.guardRejected && j.traversalRejected;
  try { fs.writeFileSync(path.join(os.tmpdir(), 'hc-ui-landing.json'), 'UI_LANDING=' + out + '\nPASS=' + pass, 'utf8'); } catch (e) { /* noop */ }
  console.log(pass ? 'ALL_UI_LANDING_OK' : 'UI_LANDING_FAILED');
  app.exit(pass ? 0 : 1);
});