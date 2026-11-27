// Ricochet Rumble app — what the game page may ask the app to do.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rrApp', {
  info: () => ipcRenderer.invoke('rr:info'),
  checkForUpdates: () => ipcRenderer.invoke('rr:check'),
  installUpdate: (latest) => ipcRenderer.invoke('rr:install', latest),
  resetGame: () => ipcRenderer.invoke('rr:reset'),
  reload: () => ipcRenderer.invoke('rr:reload'),
  toggleFullscreen: () => ipcRenderer.invoke('rr:fullscreen'),
  openLink: (url) => ipcRenderer.invoke('rr:open', url),
  quit: () => ipcRenderer.invoke('rr:quit'),
  onProgress: (fn) => ipcRenderer.on('rr:progress', (e, p) => fn(p)),
});
