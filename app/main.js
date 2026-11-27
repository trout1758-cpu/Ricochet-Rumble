// Ricochet Rumble — the Windows app (Electron).
// Runs the game in its own full-screen window instead of a browser, serves the
// Wi-Fi phone controller, lets Wii Remotes / the DolphinBar and Bluetooth
// phones connect without the browser's device pickers, and updates the game
// from GitHub when you press "Check for updates" in Settings.
'use strict';

const { app, BrowserWindow, ipcMain, session, shell, net } = require('electron');
const path = require('path');
const { start } = require('./lib/server');
const { Updater, REPO } = require('./lib/updater');

const NINTENDO = 0x057e;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let port = 0;
let updater = null;
let gameDir = null;

function bundledGame() {
  // packaged: resources/game · running from the repo: ../game
  return app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..', 'game');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 720, fullscreen: true, autoHideMenuBar: true,
    backgroundColor: '#1c1a22', title: 'Ricochet Rumble', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  win.removeMenu();
  win.loadURL(`http://localhost:${port}/`);
  // F11: full screen on/off · Ctrl+Shift+I: developer tools · Ctrl+R: reload
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.control && input.shift && input.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (input.control && input.key.toLowerCase() === 'r') { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
  });
  // links (Releases page, help) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // ---- Bluetooth (the Android phone app): pick the first matching phone ----------
  let btPick = null;
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    if (devices.length) {
      if (btPick) clearTimeout(btPick.timer);
      btPick = null;
      callback(devices[0].deviceId);
    } else if (!btPick) {
      // keep scanning for a while; the list fills in as phones are found
      btPick = { timer: setTimeout(() => { btPick = null; callback(''); }, 20000) };
    }
  });
}

function setupDevices() {
  const ses = session.defaultSession;
  // Wii Remotes (direct or through a DolphinBar in mode 4) and Bluetooth phones
  // are allowed without asking.
  ses.setPermissionCheckHandler((wc, permission) => ['hid', 'bluetooth', 'media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  ses.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'hid') return details.device.vendorId === NINTENDO;
    return details.deviceType === 'bluetooth';
  });
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const dev = details.deviceList.find((d) => d.vendorId === NINTENDO);
    callback(dev ? dev.deviceId : '');
  });
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(true));
}

function setupIpc() {
  const info = () => {
    const cur = updater.current();
    return { app: app.getVersion(), game: { sha: cur.sha, date: cur.date, source: cur.source }, repo: REPO, fullscreen: !!(win && win.isFullScreen()) };
  };
  ipcMain.handle('rr:info', () => info());
  ipcMain.handle('rr:check', async () => {
    try { return { ok: true, ...(await updater.check()) }; } catch (e) { return { ok: false, error: friendly(e) }; }
  });
  ipcMain.handle('rr:install', async (e, latest) => {
    try {
      const cur = await updater.install(latest, (p) => { if (win) win.webContents.send('rr:progress', p); });
      gameDir = cur.dir;
      return { ok: true, info: info() };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  });
  ipcMain.handle('rr:reset', () => { gameDir = updater.reset().dir; return info(); });
  ipcMain.handle('rr:reload', () => { if (win) win.webContents.reloadIgnoringCache(); });
  ipcMain.handle('rr:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); return !!(win && win.isFullScreen()); });
  ipcMain.handle('rr:open', (e, url) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('rr:quit', () => app.quit());
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET|ERR_NAME|fetch failed|network/i.test(m)) return 'No internet connection. Connect to the internet to check for updates.';
  return m;
}

app.whenReady().then(async () => {
  updater = new Updater({ bundledDir: bundledGame(), dataDir: app.getPath('userData'), appVersion: app.getVersion(), fetch: (u, o) => net.fetch(u, o) });
  gameDir = updater.current().dir;
  setupDevices();
  setupIpc();
  ({ port } = await start({ root: () => gameDir }));
  createWindow();
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('window-all-closed', () => app.quit());
