// Electron 主进程：内嵌 HarnessChat 服务器 + 窗口 + 托盘常驻 + 自研更新器
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { GroupServer } = require('./server/server');
const updater = require('./updater');

let win = null;
let tray = null;
const PORT = 18790;

ipcMain.handle('app:version', () => app.getVersion());

// 更新器 IPC：进度用主进程→渲染进程单向推送，避免渲染层轮询
ipcMain.handle('updater:check', () => updater.check());
ipcMain.handle('updater:download', () => updater.downloadAndRun((text) => {
  if (win && !win.isDestroyed()) win.webContents.send('updater:progress', text);
}));

function loadOrCreateToken(dataDir) {
  const tokenPath = path.join(dataDir, 'token.txt');
  try {
    const t = fs.readFileSync(tokenPath, 'utf8').trim();
    if (t) return t;
  } catch (e) {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenPath, t, 'utf8');
  return t;
}

// 单实例：二次启动直接聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const dataDir = app.getPath('userData');
    const staticDir = path.join(__dirname, 'renderer');
    const token = loadOrCreateToken(dataDir);
    const server = new GroupServer({ dataDir, staticDir, port: PORT, token });
    await server.listen();
    console.log(`[harnesschat] server ready at http://127.0.0.1:${PORT}  data: ${dataDir}`);

    win = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 900,
      minHeight: 620,
      title: 'HarnessChat',
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      autoHideMenuBar: true,
      backgroundColor: '#f2f2f2',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    win.loadURL(`http://127.0.0.1:${PORT}/?token=${token}`);
    win.on('close', (e) => {
      // 关窗 = 最小化到托盘，群继续干活；托盘菜单退出才真正退出
      if (!app.isQuiting) {
        e.preventDefault();
        win.hide();
      }
    });

    const trayPath = path.join(__dirname, '..', 'assets', 'tray.png');
    const img = fs.existsSync(trayPath) ? nativeImage.createFromPath(trayPath) : nativeImage.createEmpty();
    tray = new Tray(img);
    tray.setToolTip('HarnessChat — harness 群聊');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开群聊', click: () => { win.show(); win.focus(); } },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuiting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => { win.show(); win.focus(); });

    app.on('activate', () => { if (win) win.show(); });
  });

  // 全部窗口关闭不退出（托盘常驻）
  app.on('window-all-closed', (e) => { /* 托盘常驻，不退出 */ });
}
