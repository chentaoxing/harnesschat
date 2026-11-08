// 完成通知的 Electron 接线层。判据与文案在 ./notify（纯函数，断言脚本量同一份）；
// 这里只负责平台动作：读窗口可见/聚焦、闪任务栏、写托盘提示、造 toast、点击回跳。
//
// 单独成文件的理由与 landing-ipc 一样：界面验收脚本要能注册**同一份**接线，
// 否则测的是"测试自己搭的假 handler"——0.8.0 就是这么挂死过一次。
const notify = require('./notify');

/**
 * deps:
 *   getWindow()  → BrowserWindow | null
 *   getTray()    → Tray | null
 *   getServer()  → GroupServer | null（读通知开关）
 *   Notification → Electron 的 Notification 构造器（验收时可换成记录用的替身，
 *                  但"这台机器到底支不支持 toast"要另外用真的 isSupported() 验）
 *   defaultTip   → 托盘默认提示语
 */
function createNotifications(deps) {
  const d = deps || {};
  const getWindow = d.getWindow || (() => null);
  const getTray = d.getTray || (() => null);
  const getServer = d.getServer || (() => null);
  const Notification = d.Notification;
  const defaultTip = d.defaultTip || 'HarnessChat';

  const alive = (w) => !!w && !w.isDestroyed();

  // 点通知/托盘回到那一单：窗口拉起来 + 渲染层滚到那张卡片并高亮
  function focusTask(taskId) {
    const win = getWindow();
    if (!alive(win)) return false;
    win.show();
    win.focus();
    win.flashFrame(false);
    const tray = getTray();
    if (tray && !tray.isDestroyed()) tray.setToolTip(defaultTip);
    win.webContents.send(notify.FOCUS_EVENT, String(taskId || ''));
    return true;
  }

  /**
   * 一单跑完了 → 桌面通知。他正看着窗口就不打扰；否则闪任务栏 + 弹通知 + 托盘留一句结论。
   * 返回一个说明这次做了什么的对象（验收脚本据此断言，不靠肉眼看桌面）。
   * 任何异常都不许冒泡到派单流程。
   */
  function announce(info) {
    const done = { notified: false, flashed: false, tip: '', skipped: '' };
    try {
      const server = getServer();
      if (!server || !notify.enabled(server.config)) { done.skipped = 'disabled'; return done; }
      const win = getWindow();
      const visible = alive(win) ? win.isVisible() : false;
      const focused = alive(win) ? win.isFocused() : false;
      if (!notify.shouldNotify({ enabled: true, quiet: info && info.quiet, taskKind: info && info.taskKind, visible, focused })) {
        done.skipped = info && (info.quiet || info.taskKind === 'health') ? 'probe' : 'watching';
        return done;
      }
      const tray = getTray();
      if (tray && !tray.isDestroyed()) {
        done.tip = notify.trayTip(info);
        tray.setToolTip(done.tip);
      }
      if (alive(win) && !focused) { win.flashFrame(true); done.flashed = true; }
      const n = notify.build(info);
      if (n && Notification && Notification.isSupported()) {
        const toast = new Notification({ title: n.title, body: n.body, silent: false });
        toast.on('click', () => focusTask(n.taskId));
        toast.show();
        done.notified = true;
        done.title = n.title;
        done.body = n.body;
      } else {
        done.skipped = 'unsupported';
      }
    } catch (e) {
      done.skipped = 'error: ' + String((e && e.message) || e).slice(0, 120);
    }
    return done;
  }

  return { focusTask, announce };
}

module.exports = { createNotifications, FOCUS_EVENT: notify.FOCUS_EVENT };