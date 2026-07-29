/**
 * main.js — Electron Main Process
 * YouTube Downloader Pro
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const setup = require('./setup');

// Disable shader disk cache lock conflicts
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');

let mainWindow;
let activeProcess = null;
let downloadPath = path.join(os.homedir(), 'Downloads', 'YT-Downloader');

// Ensure download directory exists
if (!fs.existsSync(downloadPath)) {
  fs.mkdirSync(downloadPath, { recursive: true });
}

function createWindow() {
  console.log('Creating Electron window...');
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#09090B',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    show: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).then(() => {
    console.log('index.html loaded successfully');
    mainWindow.show();
  }).catch((err) => {
    console.error('Failed to load index.html:', err);
  });

  mainWindow.once('ready-to-show', () => {
    console.log('ready-to-show event fired');
    mainWindow.show();
    mainWindow.focus();
  });

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (activeProcess) {
    activeProcess.kill('SIGTERM');
  }
  app.quit();
});

// ─── Window Controls ────────────────────────────────────────

ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.handle('window-close', () => mainWindow?.close());

// ─── Binary Setup ───────────────────────────────────────────

ipcMain.handle('check-binaries', () => {
  return setup.areBinariesReady();
});

ipcMain.handle('setup-binaries', async () => {
  try {
    await setup.ensureBinaries((status) => {
      mainWindow?.webContents.send('setup-status', status);
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-download-path', () => downloadPath);

// ─── Folder Operations ─────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn thư mục lưu file',
    defaultPath: downloadPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!result.canceled && result.filePaths[0]) {
    downloadPath = result.filePaths[0];
    return downloadPath;
  }
  return null;
});

ipcMain.handle('open-folder', (_event, folderPath) => {
  shell.openPath(folderPath || downloadPath);
});

ipcMain.handle('open-file', (_event, filePath) => {
  shell.openPath(filePath);
});

// ─── Get Video Info ─────────────────────────────────────────

ipcMain.handle('get-video-info', async (_event, url) => {
  return new Promise((resolve, reject) => {
    const ytdlpPath = setup.getYtdlpPath();
    const args = [
      '--dump-json',
      '--all-subs',
      '--no-warnings',
      '--no-playlist',
      '--ffmpeg-location', path.dirname(setup.getFfmpegPath()),
      url
    ];

    let stdout = '';
    let stderr = '';

    const proc = spawn(ytdlpPath, args, { windowsHide: true });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && stdout) {
        try {
          const info = JSON.parse(stdout);
          // Extract relevant info
          const result = {
            id: info.id,
            title: info.title || info.fulltitle || 'Unknown',
            channel: info.channel || info.uploader || 'Unknown',
            channelUrl: info.channel_url || info.uploader_url || '',
            duration: info.duration || 0,
            durationString: info.duration_string || '0:00',
            viewCount: info.view_count || 0,
            uploadDate: info.upload_date || '',
            description: (info.description || '').substring(0, 500),
            thumbnail: info.thumbnail || '',
            thumbnails: info.thumbnails || [],
            formats: (info.formats || []).map(f => ({
              formatId: f.format_id,
              ext: f.ext,
              resolution: f.resolution || 'audio only',
              width: f.width,
              height: f.height,
              fps: f.fps,
              vcodec: f.vcodec,
              acodec: f.acodec,
              abr: f.abr,
              vbr: f.vbr,
              tbr: f.tbr,
              filesize: f.filesize || f.filesize_approx || 0,
              formatNote: f.format_note || '',
            })),
            subtitles: Object.keys(info.subtitles || {}).map(lang => ({
              code: lang,
              name: (info.subtitles[lang][0] || {}).name || lang,
              formats: (info.subtitles[lang] || []).map(s => s.ext),
            })),
            automaticCaptions: Object.keys(info.automatic_captions || {}).map(lang => ({
              code: lang,
              name: lang,
              formats: (info.automatic_captions[lang] || []).map(s => s.ext),
              auto: true,
            })),
          };
          resolve(result);
        } catch (e) {
          reject(new Error('Không thể parse thông tin video: ' + e.message));
        }
      } else {
        reject(new Error(stderr || `yt-dlp thoát với mã lỗi ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error('Không thể chạy yt-dlp: ' + err.message));
    });
  });
});

// ─── Download ───────────────────────────────────────────────

ipcMain.handle('start-download', async (_event, options) => {
  // options: { url, type, format, quality, subtitleLang, subtitleFormat, outputDir }
  const { url, type, format, quality, subtitleLang, subtitleFormat } = options;
  const outputDir = options.outputDir || downloadPath;
  const ytdlpPath = setup.getYtdlpPath();

  // Ensure output dir exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--ffmpeg-location', path.dirname(setup.getFfmpegPath()),
    '--progress-template', '%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s|%(progress._downloaded_bytes_str)s',
  ];

  const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

  switch (type) {
    case 'video':
      if (quality === 'best') {
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
      } else {
        // quality is like "1080", "720", etc
        args.push('-f', `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`);
      }
      if (format === 'mp4') {
        args.push('--merge-output-format', 'mp4');
      } else if (format === 'mkv') {
        args.push('--merge-output-format', 'mkv');
      } else if (format === 'webm') {
        args.push('-f', `bestvideo[height<=${quality || 9999}][ext=webm]+bestaudio[ext=webm]/best[ext=webm]`);
      }
      args.push('-o', outputTemplate);
      break;

    case 'audio':
      args.push('-x');
      if (format && format !== 'best') {
        args.push('--audio-format', format);
      }
      if (quality && quality !== 'best') {
        args.push('--audio-quality', quality);
      }
      args.push('-o', outputTemplate);
      break;

    case 'subtitle':
      args.push('--skip-download');
      args.push('--write-subs');
      args.push('--write-auto-subs');
      if (subtitleLang) {
        args.push('--sub-langs', `${subtitleLang},.*`);
      } else {
        args.push('--sub-langs', 'all');
      }
      if (subtitleFormat) {
        args.push('--sub-format', subtitleFormat);
        args.push('--convert-subs', subtitleFormat);
      }
      args.push('-o', outputTemplate);
      break;

    case 'thumbnail':
      if (options.thumbnailUrl) {
        const https = require('https');
        const videoTitle = (options.title || 'thumbnail').replace(/[\\/:*?"<>|]/g, '_').trim();
        const targetExt = format || 'jpg';
        const tempJpg = path.join(outputDir, `${videoTitle}_temp.jpg`);
        const finalPath = path.join(outputDir, `${videoTitle}.${targetExt}`);

        return new Promise((resolve) => {
          mainWindow?.webContents.send('download-progress', { status: 'downloading', percent: 50, speed: '', eta: '' });
          
          const file = fs.createWriteStream(tempJpg);
          https.get(options.thumbnailUrl, (res) => {
            res.pipe(file);
            file.on('finish', () => {
              mainWindow?.webContents.send('download-progress', { status: 'downloading', percent: 100, speed: '', eta: '' });
              file.close(() => {
                if (targetExt !== 'jpg') {
                  const ffmpegPath = setup.getFfmpegPath();
                  const ffmpegProc = spawn(ffmpegPath, ['-y', '-i', tempJpg, finalPath], { windowsHide: true });
                  ffmpegProc.on('close', () => {
                    if (fs.existsSync(tempJpg)) fs.unlinkSync(tempJpg);
                    mainWindow?.webContents.send('download-progress', { status: 'done', percent: 100, file: finalPath, outputDir });
                    resolve({ success: true, file: finalPath, outputDir });
                  });
                } else {
                  if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                  fs.renameSync(tempJpg, finalPath);
                  mainWindow?.webContents.send('download-progress', { status: 'done', percent: 100, file: finalPath, outputDir });
                  resolve({ success: true, file: finalPath, outputDir });
                }
              });
            });
          }).on('error', (err) => {
            mainWindow?.webContents.send('download-progress', { status: 'error', message: err.message });
            resolve({ success: false, error: err.message });
          });
        });
      }
      args.push('--skip-download');
      args.push('--write-thumbnail');
      args.push('--convert-thumbnails', format || 'jpg');
      args.push('-o', outputTemplate);
      break;

    default:
      return { success: false, error: 'Unknown download type' };
  }

  args.push(url);

  return new Promise((resolve) => {
    let lastFile = '';

    activeProcess = spawn(ytdlpPath, args, { windowsHide: true });

    activeProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Check if it's a progress line
        const parts = line.split('|');
        if (parts.length >= 3) {
          const percent = parseFloat(parts[0]) || 0;
          mainWindow?.webContents.send('download-progress', {
            status: 'downloading',
            percent: Math.min(percent, 100),
            speed: parts[1]?.trim() || '',
            eta: parts[2]?.trim() || '',
            totalSize: parts[3]?.trim() || '',
            downloaded: parts[4]?.trim() || '',
          });
        } else if (line.includes('[download] Destination:')) {
          lastFile = line.replace('[download] Destination:', '').trim();
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[ThumbnailsConvertor]')) {
          mainWindow?.webContents.send('download-progress', {
            status: 'processing',
            percent: 100,
            message: 'Đang xử lý file...',
          });
        }
      }
    });

    activeProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        console.error('[yt-dlp stderr]', text);
      }
    });

    activeProcess.on('close', (code) => {
      activeProcess = null;
      if (code === 0) {
        mainWindow?.webContents.send('download-progress', {
          status: 'done',
          percent: 100,
          file: lastFile,
          outputDir: outputDir,
        });
        resolve({ success: true, file: lastFile, outputDir });
      } else {
        mainWindow?.webContents.send('download-progress', {
          status: 'error',
          message: `yt-dlp thoát với mã ${code}`,
        });
        resolve({ success: false, error: `yt-dlp exited with code ${code}` });
      }
    });

    activeProcess.on('error', (err) => {
      activeProcess = null;
      mainWindow?.webContents.send('download-progress', {
        status: 'error',
        message: err.message,
      });
      resolve({ success: false, error: err.message });
    });
  });
});

// ─── Cancel Download ────────────────────────────────────────

ipcMain.handle('cancel-download', () => {
  if (activeProcess) {
    activeProcess.kill('SIGTERM');
    activeProcess = null;
    mainWindow?.webContents.send('download-progress', {
      status: 'cancelled',
      message: 'Đã hủy tải.',
    });
    return true;
  }
  return false;
});

// ─── Get Playlist Info ──────────────────────────────────────

ipcMain.handle('get-playlist-info', async (_event, url) => {
  return new Promise((resolve, reject) => {
    const ytdlpPath = setup.getYtdlpPath();
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      url
    ];

    let stdout = '';
    let stderr = '';

    const proc = spawn(ytdlpPath, args, { windowsHide: true });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && stdout) {
        try {
          const info = JSON.parse(stdout);
          const entries = (info.entries || []).map(e => ({
            id: e.id,
            title: e.title || 'Untitled',
            url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
            duration: e.duration || 0,
            uploader: e.uploader || e.channel || '',
          }));

          resolve({
            id: info.id,
            title: info.title || 'YouTube Playlist',
            videoCount: entries.length,
            entries: entries,
          });
        } catch (e) {
          reject(new Error('Lỗi parse thông tin Playlist: ' + e.message));
        }
      } else {
        reject(new Error(stderr || `yt-dlp thoát với mã ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error('Không thể chạy yt-dlp: ' + err.message));
    });
  });
});

// ─── Save Metadata JSON ─────────────────────────────────────

ipcMain.handle('save-metadata-json', async (_event, { data, title, outputDir }) => {
  try {
    const targetDir = outputDir || downloadPath;
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const cleanTitle = (title || 'video').replace(/[\\/:*?"<>|]/g, '_').trim();
    const filePath = path.join(targetDir, `${cleanTitle}_metadata.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
