/**
 * preload.js — Secure bridge between renderer and main process
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ytdlp', {
  // Get video metadata
  getInfo: (url) => ipcRenderer.invoke('get-video-info', url),

  // Get playlist info
  getPlaylistInfo: (url) => ipcRenderer.invoke('get-playlist-info', url),

  // Save metadata JSON
  saveMetadataJson: (options) => ipcRenderer.invoke('save-metadata-json', options),

  // Start download
  download: (options) => ipcRenderer.invoke('start-download', options),

  // Cancel active download
  cancel: () => ipcRenderer.invoke('cancel-download'),

  // Select output folder
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Open folder in file explorer
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  // Open file in default app
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),

  // Check if binaries are ready
  checkBinaries: () => ipcRenderer.invoke('check-binaries'),

  // Setup binaries (download if missing)
  setupBinaries: () => ipcRenderer.invoke('setup-binaries'),

  // Get default download path
  getDownloadPath: () => ipcRenderer.invoke('get-download-path'),

  // Listen for progress updates
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },

  // Listen for setup status updates
  onSetupStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('setup-status', handler);
    return () => ipcRenderer.removeListener('setup-status', handler);
  },

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
});
