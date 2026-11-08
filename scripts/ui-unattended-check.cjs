// 无人值守三件事的**界面验收**：真 Electron 渲染层 + 真托盘 + 真桌面通知。
// 用法：node_modules/electron/dist/electron.exe scripts/ui-unattended-check.cjs
//
// 为什么要自己起服务器：装机版跑的是旧渲染层，而 app.js 里 BASE/WS 是写死的 18790，
// 换端口就得改产品代码去迁就测试——那是本末倒置。所以这里停掉装机版，用临时 dataDir
// 起一份**仓库里的**服务器与渲染层，验完再把装机版拉回来。
//
// 接线用的是产品同一份 src/notify-electron（0.8.0 的 UI 验收就是因为测试进程没注册
// 真 handler 而挂死过一次）。Notification 与 Tray 都是真的，不搭替身。
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { GroupServer } = require(path.join(ROOT, 'src', 'server', 'server'));
const health = require(path.join(ROOT, 'src', 'server', 'health'));
const { createNotifications } = require(path.join(ROOT, 'src', 'notify-electron'));

const PORT = 18790;
const TOKEN = 'ui-unattended-token';
const TRAY_TIP = 'HarnessChat — harness 群聊';

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('UI_UNATTENDED_TIMEOUT'); app.exit(1); }, 120000);
  let win = null, tray = null, server = null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ui-unatt-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      workspace: dir, members: {}, membersCustom: [], firstRunAck: true
    }), 'utf8');

    const notifications = createNotifications({
      getWindow: () => win, getTray: () => tray, getServer: () => server,
      Notification, defaultTip: TRAY_TIP
    });
    server = new GroupServer({
      dataDir: dir, staticDir: path.join(ROOT, 'src', 'renderer'), port: PORT, token: TOKEN,
      onTaskFinished: notifications.announce
    });
    await server.listen();

    // 种四种门状态 + 一个没体检过的：验的是"界面上分得清"，不是"体检判得对"（那在 health-checks 里）
    const now = Date.now();
    health.record({ memberId: 'codebuddy', level: 'green', layer: null, reason: '实测会用工具（canary 命中）', at: now - 5 * 60000, ms: 1200, canaryHit: true });
    health.record({ memberId: 'zcode', level: 'red', layer: 'auth', reason: '鉴权不通', at: now - 10 * 60000, ms: 800 });
    health.record({ memberId: 'cline', level: 'chatter', layer: null, reason: '答完了但没回出文件名', at: now - 20 * 60000, ms: 2000 });
    health.record({ memberId: 'gemini', level: 'green', layer: null, reason: '实测会用工具（canary 命中）', at: now - 3 * 24 * 3600000, ms: 1500, canaryHit: true });

    require(path.join(ROOT, 'src', 'landing-ipc')).register(ipcMain, shell);

    const trayPath = path.join(ROOT, 'assets', 'tray.png');
    tray = new Tray(fs.existsSync(trayPath) ? nativeImage.createFromPath(trayPath) : nativeImage.createEmpty());
    tray.setToolTip(TRAY_TIP);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '验收中', enabled: false }]));

    win = new BrowserWindow({
      show: false, width: 1180, height: 800,
      webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true }
    });
    await win.loadURL(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
    await sleep(2500);

    // ---------- 主进程侧：平台动作真的发生了 ----------
    const supported = Notification.isSupported();
    check('这台机器支持桌面通知（真 isSupported）', supported === true, String(supported));

    const info = {
      id: 'ui-unatt-task', memberId: 'zcode', memberName: 'ZCode', status: 'done',
      prompt: '把这段整理成一份说明文档，保存到工作区', taskKind: 'execute', quiet: false,
      delivery: {
        verdict: 'talked_only', changed: 0, headline: '文件没变化（0 个）',
        landing: { ok: true, dir: dir, files: [{ name: '回答.md', abs: path.join(dir, '回答.md'), size: 12, kind: 'answer' }],
          note: '控制台把它的回答原文落成了 1 个文件（不是它自己写的文件，别当成它动了手）：回答.md' }
      }
    };
    const a1 = notifications.announce(info);
    check('窗口藏起来时真的弹了通知', a1.notified === true, JSON.stringify(a1));
    check('同时闪了任务栏', a1.flashed === true, JSON.stringify(a1));
    check('托盘留了一句结论', typeof a1.tip === 'string' && a1.tip.length > 0 && a1.tip.length <= 120, a1.tip);
    check('通知标题带成员名', /ZCode/.test(a1.title || ''), a1.title);
    check('只动了嘴就不许说完成', /只说了没动手/.test(a1.title || '') && !/完成|成功/.test(a1.title || ''), a1.title);
    check('通知正文保留"不是它自己写的"', /不是它自己写的/.test(a1.body || ''), (a1.body || '').slice(0, 120));
    check('通知正文有界', (a1.body || '').length <= 400, String((a1.body || '').length));

    const a2 = notifications.announce(Object.assign({}, info, { id: 'probe', taskKind: 'health', quiet: true }));
    check('体检探针永不弹', a2.notified === false && a2.skipped === 'probe', JSON.stringify(a2));

    win.show(); win.focus();
    await sleep(900);
    const a3 = notifications.announce(Object.assign({}, info, { id: 'watching' }));
    check('他正看着窗口就不打扰', a3.notified === false && a3.skipped === 'watching', JSON.stringify(a3));
    win.hide();
    await sleep(400);

    server.config.notify = { onFinish: false };
    const a4 = notifications.announce(Object.assign({}, info, { id: 'off' }));
    check('设置关掉就不弹', a4.notified === false && a4.skipped === 'disabled', JSON.stringify(a4));
    server.config.notify = { onFinish: true };

    // 产品接线同一性：main.js 交给服务器的就是这份 announce（源码级断言，配合集成套件里真跑完一单）
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check('main.js 把同一份 announce 交给服务器', /onTaskFinished:\s*notifications\.announce/.test(mainSrc));
    check('main.js 不再留一份内联通知实现', !/function announceFinished/.test(mainSrc) && !/new Notification\(/.test(mainSrc));
    check('服务器拿到的回调就是它', server.onTaskFinished === notifications.announce);

    // ---------- 渲染层侧：DOM 与真点击 ----------
    const out = await win.webContents.executeJavaScript(`(async () => {
      const R = {};
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const readBadge = (b) => b ? { text: b.innerText.trim(), cls: b.className, title: b.getAttribute('title') || '' } : null;
      const memberBadge = (name) => {
        const el = [...document.querySelectorAll('#member-list .member')].find(d => (d.querySelector('.m-name')||{}).innerText === name);
        return el ? readBadge(el.querySelector('.door-badge')) : null;
      };
      R.memberTotal = document.querySelectorAll('#member-list .member').length;
      R.memberWithBadge = document.querySelectorAll('#member-list .member .door-badge').length;
      R.green = memberBadge('CodeBuddy (cbc)');
      R.red = memberBadge('ZCode');
      R.chatter = memberBadge('Cline');
      R.stale = memberBadge('Gemini CLI');
      R.none = memberBadge('Claude Code');

      // @ 名单：真敲一个 @ 进去，让产品自己的 input 监听去弹
      const input = document.querySelector('#input');
      input.value = '@';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(400);
      const pop = document.querySelector('#mention-pop');
      R.popOpen = !pop.classList.contains('hidden');
      R.popItems = pop.querySelectorAll('.mention-item').length;
      R.popBadges = pop.querySelectorAll('.mention-item .door-badge').length;
      const zi = [...pop.querySelectorAll('.mention-item')].find(d => (d.querySelector('.mi-name')||{}).innerText === 'ZCode');
      R.popRed = zi && zi.querySelector('.door-badge') ? { text: zi.querySelector('.door-badge').innerText.trim(), cls: zi.querySelector('.door-badge').className } : null;
      // 真点一下名单里的那一行（不是直接改 state）
      if (zi) { zi.click(); await sleep(500); }
      R.clickedValue = input.value;
      R.hintAfterClick = { hidden: document.querySelector('#door-hint').classList.contains('hidden'), text: document.querySelector('#door-hint').textContent };

      // 绿门：提醒条该收起来
      input.value = '@CodeBuddy (cbc) ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(600);
      R.hintGreenHidden = document.querySelector('#door-hint').classList.contains('hidden');

      // 布局：提醒条不许把输入框挤没（#composer 是 nowrap 的 flex 行）
      input.value = '@ZCode ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(600);
      const ib = input.getBoundingClientRect();
      const hb = document.querySelector('#door-hint').getBoundingClientRect();
      R.inputWidth = Math.round(ib.width);
      R.inputHeight = Math.round(ib.height);
      R.hintAboveInput = Math.round(hb.bottom) <= Math.round(ib.top) + 1;
      R.hintVisible = !document.querySelector('#door-hint').classList.contains('hidden');

      // 设置开关：真点、真存、真回读
      document.querySelector('#btn-settings').click();
      await sleep(400);
      const nf = document.querySelector('#set-notify');
      R.notifyExists = !!nf;
      R.notifyDefaultOn = !!nf && nf.checked;
      nf.checked = false;
      document.querySelector('#btn-settings-save').click();
      await sleep(900);
      const st1 = await (await fetch('/api/state', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(TOKEN)} } })).json();
      R.savedOff = !!(st1.notify && st1.notify.onFinish === false);
      document.querySelector('#btn-settings').click();
      await sleep(400);
      R.reopenUnchecked = document.querySelector('#set-notify').checked === false;
      document.querySelector('#set-notify').checked = true;
      document.querySelector('#btn-settings-save').click();
      await sleep(900);
      const st2 = await (await fetch('/api/state', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(TOKEN)} } })).json();
      R.savedOn = !!(st2.notify && st2.notify.onFinish === true);

      // 渲染一张真卡片，等主进程点通知那条路把它高亮
      renderMessage({
        id: 'ui-unatt-task', type: 'task', threadId: null, memberId: 'zcode', memberName: 'ZCode',
        color: '#888', prompt: '把这段整理成一份说明文档，保存到工作区', text: '好的，我建议这样组织……',
        status: 'done', at: Date.now(), model: '', cwd: ${JSON.stringify(dir)}, taskKind: 'execute',
        delivery: { verdict: 'talked_only', changed: 0, partial: false, artifacts: [],
          headline: '文件没变化（0 个）', reason: '它自述做了事，但盘上零变化。', next: '……', cwd: ${JSON.stringify(dir)},
          landing: { ok: true, dir: ${JSON.stringify(dir)}, truncated: false,
            files: [{ name: '回答.md', abs: ${JSON.stringify(path.join(dir, '回答.md'))}, size: 12, kind: 'answer' }],
            note: '控制台把它的回答原文落成了 1 个文件（不是它自己写的文件，别当成它动了手）：回答.md' } }
      });
      await sleep(300);
      R.cardRendered = !!document.querySelector('[data-task-id="ui-unatt-task"]');
      R.bridgeFocus = !!(window.harnesschat && window.harnesschat.onTaskFocus);
      return JSON.stringify(R);
    })()`);
    const R = JSON.parse(out);
    console.log('UI_UNATTENDED_DOM=' + out);

    check('成员列表每一行都有门徽标', R.memberTotal > 0 && R.memberWithBadge === R.memberTotal, `${R.memberWithBadge}/${R.memberTotal}`);
    check('绿门说"能干活"', !!R.green && R.green.text === '能干活' && /green/.test(R.green.cls), JSON.stringify(R.green));
    check('鉴权红的门说清是哪一层', !!R.red && R.red.text === '鉴权不通' && /red/.test(R.red.cls), JSON.stringify(R.red));
    check('只会聊天的门不冒充绿', !!R.chatter && R.chatter.text === '只会聊天' && /chatter/.test(R.chatter.cls), JSON.stringify(R.chatter));
    check('过期的绿标成"久了没复核"', !!R.stale && /久了没复核/.test(R.stale.text) && /stale/.test(R.stale.cls), JSON.stringify(R.stale));
    check('没体检过的说"未体检"而不是"不可用"', !!R.none && R.none.text === '未体检' && /none/.test(R.none.cls), JSON.stringify(R.none));
    check('红门徽标带得出原因', !!R.red && R.red.title.length > 0, JSON.stringify(R.red));
    check('@ 名单真的弹出来了', R.popOpen === true && R.popItems === R.memberTotal, `${R.popOpen} ${R.popItems}/${R.memberTotal}`);
    check('@ 名单每行也有门徽标', R.popBadges === R.popItems, `${R.popBadges}/${R.popItems}`);
    check('@ 名单里的红门当场看得见', !!R.popRed && R.popRed.text === '鉴权不通' && /red/.test(R.popRed.cls), JSON.stringify(R.popRed));
    check('点名单行真的写进了输入框', /^@ZCode/.test(R.clickedValue || ''), R.clickedValue);
    check('派给红门前提醒条出来了', R.hintAfterClick && R.hintAfterClick.hidden === false && /鉴权/.test(R.hintAfterClick.text), JSON.stringify(R.hintAfterClick));
    check('提醒条只提醒不拦他', !!R.hintAfterClick && !/禁止|已拦|不能派/.test(R.hintAfterClick.text), R.hintAfterClick && R.hintAfterClick.text);
    check('派给绿门时提醒条收起来', R.hintGreenHidden === true, String(R.hintGreenHidden));
    check('提醒条没把输入框挤没', R.inputWidth > 300 && R.inputHeight > 20, `${R.inputWidth}x${R.inputHeight}`);
    check('提醒条悬在输入区上方而不是挤进 flex 行', R.hintVisible === true && R.hintAboveInput === true, JSON.stringify({ v: R.hintVisible, above: R.hintAboveInput }));
    check('设置里有完成通知开关且默认开', R.notifyExists === true && R.notifyDefaultOn === true, JSON.stringify({ e: R.notifyExists, on: R.notifyDefaultOn }));
    check('关掉真的存进了服务器', R.savedOff === true, String(R.savedOff));
    check('重开设置回读的是盘上那份', R.reopenUnchecked === true, String(R.reopenUnchecked));
    check('再打开也真的存回去了', R.savedOn === true, String(R.savedOn));
    check('卡片渲染出来了', R.cardRendered === true, String(R.cardRendered));
    check('渲染层拿到了回跳桥', R.bridgeFocus === true, String(R.bridgeFocus));

    // 点通知那条路：主进程 focusTask → IPC → 渲染层滚到卡片并高亮
    const focused = notifications.focusTask('ui-unatt-task');
    await sleep(700);
    const flash = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-task-id="ui-unatt-task"]');
      return JSON.stringify({ exists: !!el, flash: !!el && el.classList.contains('task-flash') });
    })()`);
    const F = JSON.parse(flash);
    check('focusTask 报告成功', focused === true, String(focused));
    check('点通知回到那张卡片并高亮', F.exists === true && F.flash === true, flash);
    check('窗口被拉起来了', win.isVisible() === true, String(win.isVisible()));

    // 正对照：高亮会自己退掉；不存在的 id 不许再点亮任何卡片
    await sleep(2800);
    const faded = await win.webContents.executeJavaScript(`!!document.querySelector('.task-flash')`);
    check('高亮会自己退掉（不是一直亮着）', faded === false, String(faded));
    notifications.focusTask('no-such-task');
    await sleep(500);
    const noFlash = await win.webContents.executeJavaScript(`!!document.querySelector('.task-flash')`);
    check('不存在的卡片不许假报高亮', noFlash === false, String(noFlash));
  } catch (e) {
    check('验收脚本本身没炸', false, String((e && e.stack) || e).slice(0, 400));
  }

  for (const n of oks) console.log('  ok  ' + n);
  for (const n of fails) console.log('  FAIL ' + n);
  const pass = fails.length === 0;
  console.log(`\nUI_UNATTENDED_${pass ? 'OK' : 'FAILED'} ${oks.length}/${oks.length + fails.length}`);
  try { fs.writeFileSync(path.join(os.tmpdir(), 'hc-ui-unattended.json'), JSON.stringify({ ok: oks, fail: fails }, null, 1), 'utf8'); } catch (e) { /* noop */ }
  clearTimeout(watchdog);
  app.exit(pass ? 0 : 1);
});