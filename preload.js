/**
 * Narrow, serializable IPC bridge exposed to the renderer.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback, transform = (value) => value) {
  if (typeof callback !== 'function') {
    return () => {};
  }

  const listener = (_event, value) => {
    callback(transform(value));
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge = {
  getVideoInfo: (url) => ipcRenderer.invoke('get-video-info', url),
  getInfo: (url) => ipcRenderer.invoke('get-video-info', url),
  getPlaylistInfo: (url) => ipcRenderer.invoke('get-playlist-info', url),

  startDownloadTask: (options) => ipcRenderer.invoke('start-download-task', options),
  download: (options) => ipcRenderer.invoke('start-download-task', options),
  cancelDownloadTask: (taskId) => ipcRenderer.invoke('cancel-download-task', taskId),
  cancel: (taskId) => ipcRenderer.invoke('cancel-download', taskId),
  getActiveTasks: () => ipcRenderer.invoke('get-active-tasks'),

  getHistory: () => ipcRenderer.invoke('get-history'),
  saveHistory: (items) => ipcRenderer.invoke('save-history', items),
  removeHistoryItem: (itemId) => ipcRenderer.invoke('remove-history-item', itemId),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  selectFolder: () => ipcRenderer.invoke('select-folder'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),

  checkBinaries: () => ipcRenderer.invoke('check-binaries'),
  setupBinaries: () => ipcRenderer.invoke('setup-binaries'),
  getDownloadPath: () => ipcRenderer.invoke('get-download-path'),

  onTaskUpdated: (callback) => subscribe('task-updated', callback),
  onProgress: (callback) => subscribe('download-progress', callback),
  onSetupStatus: (callback) => subscribe('setup-status', callback),

  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
};

contextBridge.exposeInMainWorld('ytdlp', Object.freeze(bridge));
