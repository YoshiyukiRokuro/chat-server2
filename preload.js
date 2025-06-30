// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  startServer: (port) => ipcRenderer.invoke('start-server', port),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  getDbPath: () => ipcRenderer.invoke('get-db-path'),
  onServerStatusUpdate: (callback) => ipcRenderer.on('server-status-update', (event, status) => callback(status)),
  onServerLog: (callback) => ipcRenderer.on('server-log', (event, log) => callback(log)),
});