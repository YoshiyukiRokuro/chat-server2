// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  startServer: (port) => ipcRenderer.invoke('start-server', port),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  getDbPath: () => ipcRenderer.invoke('get-db-path'), // この行は変更なしだが、念のため記載
  setDbPath: (newPath) => ipcRenderer.invoke('set-db-path', newPath), // 追加
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'), // 追加
  onServerStatusUpdate: (callback) => ipcRenderer.on('server-status-update', (event, status) => callback(status)),
  onServerLog: (callback) => ipcRenderer.on('server-log', (event, log) => callback(log)),
});