'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wizard', {
  detect: () => ipcRenderer.invoke('sys:detect'),
  providers: () => ipcRenderer.invoke('sys:providers'),
  openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),

  runInstall: () => ipcRenderer.invoke('install:run'),

  verifyProvider: (payload) => ipcRenderer.invoke('models:verify', payload),
  saveModels: (payload) => ipcRenderer.invoke('models:save', payload),

  verifyTelegram: (token) => ipcRenderer.invoke('telegram:verify', token),
  saveTelegram: (token) => ipcRenderer.invoke('telegram:save', token),

  enableWhatsapp: (enabled) => ipcRenderer.invoke('whatsapp:enable', enabled),
  pairWhatsapp: () => ipcRenderer.invoke('whatsapp:pair'),

  stopProc: (procId) => ipcRenderer.invoke('proc:stop', procId),

  runDoctor: () => ipcRenderer.invoke('finish:doctor'),
  startGateway: (mode) => ipcRenderer.invoke('finish:gateway', mode),
  openTerminal: (argsLine) => ipcRenderer.invoke('finish:openTerminal', argsLine),

  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  getChangelog: () => ipcRenderer.invoke('updates:changelog'),

  onLog: (cb) => ipcRenderer.on('proc:log', (_e, m) => cb(m)),
  onExit: (cb) => ipcRenderer.on('proc:exit', (_e, m) => cb(m)),
});
