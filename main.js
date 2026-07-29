/**
 * Electron main process for YT Downloader Pro.
 *
 * The IPC surface mirrors the Wails backend while keeping all filesystem and
 * child-process access in the trusted main process.
 */

'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const setup = require('./setup');

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const TASK_EVENT = 'task-updated';
const SETUP_EVENT = 'setup-status';
const PROGRESS_PREFIX = '__YTDLP_PROGRESS__|';
const FILE_PREFIX = '__YTDLP_FILE__|';
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_TEXT = 8 * 1024;

const DOWNLOAD_TYPES = new Set([
  'video',
  'audio',
  'subtitle',
  'thumbnail',
  'metadata',
  'bundle',
]);
const VIDEO_FORMATS = new Set(['mp4', 'mkv', 'webm']);
const AUDIO_FORMATS = new Set(['mp3', 'm4a', 'opus', 'flac', 'wav']);
const SUBTITLE_FORMATS = new Set(['srt', 'vtt', 'ass']);
const THUMBNAIL_FORMATS = new Set(['jpg', 'png', 'webp']);
const THUMBNAIL_RESOLUTIONS = new Set(['maxresdefault', 'sddefault', 'hqdefault']);
const THEMES = new Set(['red', 'indigo', 'green', 'amber']);
const LANGUAGES = new Set(['vi', 'en']);

let mainWindow = null;
let ensureBinariesPromise = null;
let isQuitting = false;

// Only running tasks live in activeTasks. A terminal update is emitted before a
// task is removed, and completed tasks are persisted in history.json.
const activeTasks = new Map();
const taskProcesses = new Map();
const taskAbortControllers = new Map();
const activeDestinationKeys = new Map();
const cancelledTaskIds = new Set();

class TaskCancelledError extends Error {
  constructor() {
    super('Đã hủy tiến trình tải xuống.');
    this.name = 'TaskCancelledError';
  }
}

function safeString(value, maxLength = 2048) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\0/g, '').trim().slice(0, maxLength);
}

function cloneForIpc(value) {
  return JSON.parse(JSON.stringify(value));
}

function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    thumbnail: task.thumbnail,
    channel: task.channel,
    type: task.type,
    format: task.format,
    quality: task.quality,
    status: task.status,
    percent: task.percent,
    speed: task.speed,
    eta: task.eta,
    filePath: task.filePath,
    folderPath: task.folderPath,
    date: task.date,
    ...(task.error ? { error: task.error } : {}),
  };
}

function isTerminalStatus(status) {
  return status === 'completed' || status === 'error' || status === 'cancelled';
}

function broadcast(channel, payload) {
  const data = cloneForIpc(payload);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send(channel, data);
      } catch (error) {
        console.warn(`Could not emit ${channel}:`, error.message);
      }
    }
  }
}

function emitTaskUpdate(task) {
  const terminal = isTerminalStatus(task.status);
  if (terminal && task._terminalEmitted) {
    return false;
  }
  if (!terminal && task.status !== 'running') {
    return false;
  }
  if (terminal) {
    task._terminalEmitted = true;
  }

  const data = publicTask(task);
  broadcast(TASK_EVENT, data);

  // Keep the legacy progress event useful for the original renderer.
  broadcast('download-progress', {
    ...data,
    taskId: data.id,
    status: data.status === 'running' ? 'downloading' : data.status,
    message: data.error || '',
    outputDir: data.folderPath,
    file: data.filePath,
  });
  return true;
}

function getStoragePaths() {
  const configDir = app.getPath('userData');
  return {
    configDir,
    historyFile: path.join(configDir, 'history.json'),
    settingsFile: path.join(configDir, 'settings.json'),
  };
}

function defaultDownloadPath() {
  try {
    return path.join(app.getPath('downloads'), 'YT-Downloader');
  } catch (_error) {
    return path.join(os.homedir(), 'Downloads', 'YT-Downloader');
  }
}

function defaultSettings() {
  return {
    language: 'vi',
    theme: 'red',
    downloadPath: defaultDownloadPath(),
    autoOpenFolder: false,
  };
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function absolutePathOr(value, fallback) {
  const candidate = safeString(value, 32768);
  return candidate && path.isAbsolute(candidate) ? path.normalize(candidate) : fallback;
}

function normalizeSettings(value) {
  const defaults = defaultSettings();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  return {
    language: LANGUAGES.has(source.language) ? source.language : defaults.language,
    theme: THEMES.has(source.theme) ? source.theme : defaults.theme,
    downloadPath: absolutePathOr(source.downloadPath, defaults.downloadPath),
    autoOpenFolder: source.autoOpenFolder === true,
  };
}

function loadSettings() {
  const { settingsFile } = getStoragePaths();
  return normalizeSettings(readJsonFile(settingsFile, defaultSettings()));
}

function saveSettings(value) {
  try {
    const settings = normalizeSettings(value);
    writeJsonFile(getStoragePaths().settingsFile, settings);
    return true;
  } catch (error) {
    console.error('Could not save settings:', error);
    return false;
  }
}

function normalizeHistoryItem(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const filePath = absolutePathOr(source.filePath, '');

  return {
    id: safeString(source.id, 200),
    title: safeString(source.title, 1000),
    channel: safeString(source.channel, 500),
    thumbnail: normalizeOptionalHttpUrl(source.thumbnail),
    type: safeString(source.type, 20),
    filePath,
    folderPath: absolutePathOr(
      source.folderPath,
      filePath ? path.dirname(filePath) : '',
    ),
    fileName: safeString(source.fileName, 1000) || (filePath ? path.basename(filePath) : ''),
    format: safeString(source.format, 20),
    quality: safeString(source.quality, 30),
    date: safeString(source.date, 100),
    duration: safeString(source.duration, 100),
  };
}

function loadHistory() {
  const value = readJsonFile(getStoragePaths().historyFile, []);
  return Array.isArray(value) ? value.slice(0, 5000).map(normalizeHistoryItem) : [];
}

function saveHistory(value) {
  if (!Array.isArray(value)) {
    return false;
  }

  try {
    const items = value.slice(0, 5000).map(normalizeHistoryItem);
    writeJsonFile(getStoragePaths().historyFile, items);
    return true;
  } catch (error) {
    console.error('Could not save history:', error);
    return false;
  }
}

function removeHistoryItem(value) {
  const itemId = safeString(value, 200);
  if (!itemId) {
    return false;
  }
  const history = loadHistory();
  const nextHistory = history.filter((item) => item.id !== itemId);
  if (nextHistory.length === history.length) {
    return false;
  }
  return saveHistory(nextHistory);
}

function normalizeHttpUrl(value) {
  const raw = safeString(value, 8192);
  if (!raw) {
    throw new Error('URL không được để trống.');
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw new Error('URL không hợp lệ.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Chỉ hỗ trợ URL HTTP hoặc HTTPS.');
  }
  return parsed.toString();
}

function normalizeOptionalHttpUrl(value) {
  try {
    return value ? normalizeHttpUrl(value) : '';
  } catch (_error) {
    return '';
  }
}

function normalizeVideoQuality(value) {
  const quality = safeString(value, 10).toLowerCase();
  if (quality === 'best') {
    return 'best';
  }
  if (/^\d{3,4}$/.test(quality)) {
    const height = Number(quality);
    if (height >= 144 && height <= 8640) {
      return String(height);
    }
  }
  return 'best';
}

function normalizeAudioQuality(value) {
  const quality = safeString(value, 10).toLowerCase();
  if (quality === 'best') {
    return '0';
  }
  if (/^(?:10|[0-9])(?:\.\d+)?$/.test(quality)) {
    return quality;
  }
  return '0';
}

function normalizeSubLanguage(value) {
  const language = safeString(value, 100);
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:,[A-Za-z0-9][A-Za-z0-9_.-]*)*$/.test(language)
    ? language
    : 'vi';
}

function normalizeThumbnailResolution(value) {
  const resolution = safeString(value, 30).toLowerCase();
  return THUMBNAIL_RESOLUTIONS.has(resolution)
    ? resolution
    : 'maxresdefault';
}

function allowedFormat(value, allowed, fallback) {
  const format = safeString(value, 20).toLowerCase();
  return allowed.has(format) ? format : fallback;
}

function normalizeDownloadOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tùy chọn tải xuống không hợp lệ.');
  }

  const type = safeString(value.type, 20).toLowerCase();
  if (!DOWNLOAD_TYPES.has(type)) {
    throw new Error(`Kiểu tải xuống không được hỗ trợ: ${type || '(trống)'}`);
  }

  let format;
  let quality;
  switch (type) {
    case 'video':
      format = allowedFormat(value.format, VIDEO_FORMATS, 'mp4');
      quality = normalizeVideoQuality(value.quality);
      break;
    case 'audio':
      format = allowedFormat(value.format, AUDIO_FORMATS, 'mp3');
      quality = normalizeAudioQuality(value.quality);
      break;
    case 'subtitle':
      format = allowedFormat(value.format || value.subtitleFormat, SUBTITLE_FORMATS, 'srt');
      quality = '';
      break;
    case 'thumbnail':
      format = allowedFormat(value.format, THUMBNAIL_FORMATS, 'jpg');
      quality = normalizeThumbnailResolution(value.thumbRes || value.quality);
      break;
    case 'metadata':
      format = 'txt';
      quality = '';
      break;
    default:
      format = allowedFormat(value.format, VIDEO_FORMATS, 'mp4');
      quality = normalizeVideoQuality(value.quality);
      break;
  }

  const rawBundle = value.bundleOpts && typeof value.bundleOpts === 'object'
    ? value.bundleOpts
    : {};

  const settings = loadSettings();
  return {
    url: normalizeHttpUrl(value.url),
    type,
    quality,
    format,
    subLang: normalizeSubLanguage(value.subLang || value.subtitleLang),
    thumbRes: normalizeThumbnailResolution(value.thumbRes || value.quality),
    outputPath: absolutePathOr(value.outputPath || value.outputDir, settings.downloadPath),
    title: safeString(value.title, 1000) || 'Video YouTube',
    thumbnail: normalizeOptionalHttpUrl(value.thumbnail || value.thumbnailUrl),
    thumbnailUrl: normalizeOptionalHttpUrl(value.thumbnailUrl),
    channel: safeString(value.channel, 500) || 'YouTube',
    bundleOpts: {
      video: rawBundle.video === true,
      videoQual: normalizeVideoQuality(rawBundle.videoQual),
      audio: rawBundle.audio === true,
      audioQual: normalizeAudioQuality(rawBundle.audioQual),
      sub: rawBundle.sub === true,
      thumb: rawBundle.thumb === true,
      metadata: rawBundle.metadata === true,
    },
  };
}

function appendFfmpegLocation(args) {
  const ffmpegPath = setup.getFfmpegPath();
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    const separatorIndex = args.indexOf('--');
    const locationArgs = ['--ffmpeg-location', path.dirname(ffmpegPath)];
    if (separatorIndex >= 0) {
      args.splice(separatorIndex, 0, ...locationArgs);
    } else {
      args.push(...locationArgs);
    }
  }
  return args;
}

async function ensureBinaries() {
  if (await setup.areBinariesReady()) {
    return true;
  }

  if (!ensureBinariesPromise) {
    ensureBinariesPromise = setup.ensureBinaries((status) => {
      broadcast(SETUP_EVENT, status);
    }).finally(() => {
      ensureBinariesPromise = null;
    });
  }

  await ensureBinariesPromise;
  if (!await setup.areBinariesReady()) {
    throw new Error('Không tìm thấy yt-dlp hoặc ffmpeg sau khi thiết lập.');
  }
  return true;
}

function processErrorMessage(stderr, code) {
  const text = typeof stderr === 'string'
    ? stderr.replace(/\0/g, '').trim().slice(-MAX_ERROR_TEXT)
    : '';
  if (text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-8).join('\n');
  }
  return `yt-dlp thoát với mã lỗi ${code}.`;
}

function runYtdlpCapture(args, taskId = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(setup.getYtdlpPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (taskId) {
      taskProcesses.set(taskId, child);
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const cleanUp = () => {
      if (taskId && taskProcesses.get(taskId) === child) {
        taskProcesses.delete(taskId);
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanUp();
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CAPTURE_BYTES) {
        terminateChildProcess(child);
        fail(new Error('Dữ liệu trả về từ yt-dlp quá lớn.'));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_CAPTURE_BYTES) {
        stderrChunks.push(chunk);
      }
    });

    child.once('error', (error) => {
      fail(new Error(`Không thể chạy yt-dlp: ${error.message}`));
    });

    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanUp();

      if (taskId && cancelledTaskIds.has(taskId)) {
        reject(new TaskCancelledError());
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(processErrorMessage(stderr, code)));
      }
    });
  });
}

function parseSingleJson(text, label) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`yt-dlp không trả về ${label}.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch (_ignored) {
        // Continue looking for the final JSON line.
      }
    }
    throw new Error(`Không thể đọc JSON ${label} từ yt-dlp.`);
  }
}

function parsePlaylistJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizePlaylistEntry);
    }
    if (parsed && Array.isArray(parsed.entries)) {
      return parsed.entries.map(normalizePlaylistEntry);
    }
    return parsed && typeof parsed === 'object' ? [normalizePlaylistEntry(parsed)] : [];
  } catch (_error) {
    const items = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item && typeof item === 'object') {
          items.push(item);
        }
      } catch (_ignored) {
        // yt-dlp can occasionally print a non-JSON informational line.
      }
    }
    return items.map(normalizePlaylistEntry);
  }
}

function normalizePlaylistEntry(value) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = safeString(item.id, 200);
  let url = '';

  for (const candidate of [item.webpage_url, item.original_url, item.url]) {
    try {
      url = normalizeHttpUrl(candidate);
      break;
    } catch (_error) {
      // Flat playlist data sometimes uses the video ID as its `url`.
    }
  }

  if (!url && /^[A-Za-z0-9_-]{3,200}$/.test(id)) {
    url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  }

  const uploader = safeString(item.uploader || item.channel, 500);
  const channel = safeString(item.channel || item.uploader, 500);
  return {
    ...item,
    id,
    title: safeString(item.title, 1000) || 'Untitled',
    url,
    webpage_url: normalizeOptionalHttpUrl(item.webpage_url) || url,
    uploader,
    channel,
  };
}

async function fetchVideoInfo(url, taskId = '') {
  const args = appendFfmpegLocation([
    '--ignore-config',
    '--dump-single-json',
    '--all-subs',
    '--no-warnings',
    '--no-playlist',
    '--',
    normalizeHttpUrl(url),
  ]);
  const { stdout } = await runYtdlpCapture(args, taskId);
  return parseSingleJson(stdout, 'thông tin video');
}

async function getVideoInfo(url) {
  await ensureBinaries();
  return fetchVideoInfo(url);
}

async function getPlaylistInfo(url) {
  await ensureBinaries();
  const args = appendFfmpegLocation([
    '--ignore-config',
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--skip-download',
    '--',
    normalizeHttpUrl(url),
  ]);
  const { stdout } = await runYtdlpCapture(args);
  return parsePlaylistJson(stdout);
}

function formatTaskTime(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function extractMediaId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let candidate = '';
    if (host === 'youtu.be') {
      candidate = parsed.pathname.split('/').filter(Boolean)[0] || '';
    } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      candidate = parsed.searchParams.get('v') || '';
      if (!candidate) {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (['shorts', 'embed', 'live'].includes(parts[0])) {
          candidate = parts[1] || '';
        }
      }
    }
    return /^[A-Za-z0-9_-]{3,200}$/.test(candidate) ? candidate : '';
  } catch (_error) {
    return '';
  }
}

function stableSourceId(value) {
  return extractMediaId(value)
    || crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function destinationKey(options) {
  const folder = process.platform === 'win32'
    ? options.outputPath.toLowerCase()
    : options.outputPath;
  const media = extractMediaId(options.url) || options.url;
  const subtype = options.type === 'subtitle' ? `:${options.subLang}` : '';
  return `${folder}\0${media}\0${options.type}:${options.format}${subtype}`;
}

function createDownloadTask(options) {
  return {
    id: `task_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`,
    title: options.title,
    thumbnail: options.thumbnail,
    channel: options.channel,
    type: options.type,
    format: options.format,
    quality: options.quality,
    status: 'running',
    percent: 0,
    speed: '-- MB/s',
    eta: 'ETA: --',
    filePath: '',
    folderPath: options.outputPath,
    date: formatTaskTime(),
    error: '',
    sourceId: extractMediaId(options.url),
    stableSourceId: stableSourceId(options.url),
    destinationKey: destinationKey(options),
    _terminalEmitted: false,
  };
}

function startDownloadTask(value) {
  const options = normalizeDownloadOptions(value);
  const task = createDownloadTask(options);
  if (activeDestinationKeys.has(task.destinationKey)) {
    throw new Error('Tác vụ này đã có trong hàng đợi tải xuống.');
  }
  activeDestinationKeys.set(task.destinationKey, task.id);
  activeTasks.set(task.id, task);

  // Deliberately do not await setup or yt-dlp. The renderer gets a task ID
  // immediately and every subsequent state change arrives through task-updated.
  setImmediate(() => {
    executeTask(task, options).catch((error) => {
      console.error(`Unexpected task failure (${task.id}):`, error);
    });
  });

  return publicTask(task);
}

function updateTaskFromInfo(task, info) {
  if (task.title === 'Video YouTube' && safeString(info.title, 1000)) {
    task.title = safeString(info.title, 1000);
  }
  if (!task.thumbnail) {
    task.thumbnail = normalizeOptionalHttpUrl(info.thumbnail);
  }
  if (task.channel === 'YouTube') {
    task.channel = safeString(info.channel || info.uploader, 500) || task.channel;
  }
  const infoId = safeString(info.id, 200);
  if (!task.sourceId && /^[A-Za-z0-9_-]{3,200}$/.test(infoId)) {
    task.sourceId = infoId;
    task.stableSourceId = infoId;
  }
}

function assertOutputFile(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error('Tiến trình kết thúc nhưng không trả về đường dẫn output hợp lệ.');
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_error) {
    throw new Error('Tiến trình kết thúc nhưng không tìm thấy file output.');
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error('File output không tồn tại hoặc rỗng.');
  }
}

function youtubeThumbnailUrl(sourceId, resolution) {
  return sourceId
    ? `https://img.youtube.com/vi/${encodeURIComponent(sourceId)}/${resolution}.jpg`
    : '';
}

function selectThumbnailFromInfo(info, resolution) {
  const thumbnails = Array.isArray(info.thumbnails)
    ? info.thumbnails.filter((item) => item && normalizeOptionalHttpUrl(item.url))
    : [];
  const exact = thumbnails.find((item) => {
    const id = safeString(item.id, 100).toLowerCase();
    const url = safeString(item.url, 8192).toLowerCase();
    return id === resolution || url.includes(`/${resolution}.`);
  });
  if (exact) {
    return normalizeOptionalHttpUrl(exact.url);
  }

  const targetWidth = {
    maxresdefault: 1280,
    sddefault: 640,
    hqdefault: 480,
  }[resolution] || 1280;
  thumbnails.sort((left, right) => {
    const leftWidth = Number(left.width) || 0;
    const rightWidth = Number(right.width) || 0;
    return Math.abs(leftWidth - targetWidth) - Math.abs(rightWidth - targetWidth);
  });
  return normalizeOptionalHttpUrl(thumbnails[0]?.url || info.thumbnail);
}

async function runTrackedCommand(task, executable, args, label) {
  return new Promise((resolve, reject) => {
    throwIfCancelled(task.id);
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    taskProcesses.set(task.id, child);
    let stderr = '';
    let settled = false;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_ERROR_TEXT);
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (taskProcesses.get(task.id) === child) {
        taskProcesses.delete(task.id);
      }
      reject(new Error(`Không thể chạy ${label}: ${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (taskProcesses.get(task.id) === child) {
        taskProcesses.delete(task.id);
      }
      if (cancelledTaskIds.has(task.id)) {
        reject(new TaskCancelledError());
      } else if (code === 0) {
        resolve();
      } else {
        const details = typeof stderr === 'string'
          ? stderr.replace(/\0/g, '').trim().slice(-MAX_ERROR_TEXT)
          : '';
        reject(new Error(details || `${label} thoát với mã lỗi ${code}.`));
      }
    });
  });
}

function replaceFileAtomicSync(sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) {
      throw error;
    }
    fs.rmSync(targetPath, { force: true });
    fs.renameSync(sourcePath, targetPath);
  }
}

async function executeThumbnailTask(task, options) {
  const sourcePath = path.join(
    task.folderPath,
    `.${task.stableSourceId}.${task.id}.thumbnail-source`,
  );
  let finalPath = '';
  let temporaryOutput = '';
  const controller = new AbortController();
  taskAbortControllers.set(task.id, controller);

  let info = null;
  const candidates = [
    options.thumbnailUrl,
    youtubeThumbnailUrl(task.sourceId, options.thumbRes),
  ].filter(Boolean);
  let lastError = null;

  try {
    for (const candidate of candidates) {
      try {
        await setup.downloadFileAtomic(candidate, sourcePath, (progress) => {
          if (task.status !== 'running') {
            return;
          }
          task.percent = Math.max(1, Math.min(70, progress.percent * 0.7));
          task.speed = 'Đang tải thumbnail';
          task.eta = '';
          emitTaskUpdate(task);
        }, {
          signal: controller.signal,
          timeoutMs: 120000,
          maxBytes: 50 * 1024 * 1024,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (cancelledTaskIds.has(task.id)) {
          throw new TaskCancelledError();
        }
      }
    }

    if (!fs.existsSync(sourcePath)) {
      info = await fetchVideoInfo(options.url, task.id);
      throwIfCancelled(task.id);
      updateTaskFromInfo(task, info);
      const fallbackUrl = selectThumbnailFromInfo(info, options.thumbRes)
        || options.thumbnail;
      if (!fallbackUrl) {
        throw lastError || new Error('Không tìm thấy thumbnail phù hợp.');
      }
      await setup.downloadFileAtomic(fallbackUrl, sourcePath, null, {
        signal: controller.signal,
        timeoutMs: 120000,
        maxBytes: 50 * 1024 * 1024,
      });
    }

    throwIfCancelled(task.id);
    const cleanTitle = sanitizeFileName(task.title || 'Thumbnail');
    const outputId = sanitizeFileName(task.sourceId || task.stableSourceId);
    finalPath = path.join(
      task.folderPath,
      `${cleanTitle} [${outputId}].${options.format}`,
    );
    temporaryOutput = `${finalPath}.${task.id}.part.${options.format}`;
    task.percent = 80;
    task.speed = 'Đang chuyển đổi thumbnail';
    emitTaskUpdate(task);
    await runTrackedCommand(task, setup.getFfmpegPath(), [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      temporaryOutput,
    ], 'ffmpeg');
    assertOutputFile(temporaryOutput);
    replaceFileAtomicSync(temporaryOutput, finalPath);
    return finalPath;
  } finally {
    if (taskAbortControllers.get(task.id) === controller) {
      taskAbortControllers.delete(task.id);
    }
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(`${sourcePath}.part`, { force: true });
    if (temporaryOutput) {
      fs.rmSync(temporaryOutput, { force: true });
    }
  }
}

async function executeTask(task, options) {
  try {
    await ensureBinaries();
    throwIfCancelled(task.id);
    fs.mkdirSync(task.folderPath, { recursive: true });

    if (options.type === 'metadata') {
      task.percent = 50;
      task.speed = 'Đang xử lý';
      task.eta = '';
      emitTaskUpdate(task);

      const info = await fetchVideoInfo(options.url, task.id);
      throwIfCancelled(task.id);
      updateTaskFromInfo(task, info);
      task.filePath = writeRichMetadataFile(task, info);
    } else if (options.type === 'thumbnail') {
      task.filePath = await executeThumbnailTask(task, options);
    } else if (options.type === 'bundle') {
      task.filePath = await executeBundleTask(task, options);
    } else {
      const args = buildDownloadArgs(options, task);
      task.filePath = await runDownloadProcess(task, args);
    }

    throwIfCancelled(task.id);
    assertOutputFile(task.filePath);
    task.percent = 100;
    task.status = 'completed';
    task.speed = '';
    task.eta = '';
    saveTaskToHistory(task);
    emitTaskUpdate(task);
    activeTasks.delete(task.id);
  } catch (error) {
    if (error instanceof TaskCancelledError || cancelledTaskIds.has(task.id)) {
      if (task.status !== 'cancelled') {
        task.status = 'cancelled';
        task.speed = '';
        task.eta = '';
        emitTaskUpdate(task);
      }
    } else {
      task.status = 'error';
      task.speed = '';
      task.eta = '';
      task.error = safeString(error.message || String(error), MAX_ERROR_TEXT);
      emitTaskUpdate(task);
    }
    activeTasks.delete(task.id);
  } finally {
    taskProcesses.delete(task.id);
    taskAbortControllers.delete(task.id);
    cancelledTaskIds.delete(task.id);
    if (activeDestinationKeys.get(task.destinationKey) === task.id) {
      activeDestinationKeys.delete(task.destinationKey);
    }
  }
}

async function executeBundleTask(task, options) {
  const bundle = options.bundleOpts;
  const needsYtdlp = bundle.video || bundle.audio || bundle.sub || bundle.thumb;
  if (!needsYtdlp && !bundle.metadata) {
    throw new Error('Gói tải xuống chưa chọn nội dung nào.');
  }

  let downloadedFile = '';
  if (needsYtdlp) {
    const args = buildDownloadArgs(options, task);
    downloadedFile = await runDownloadProcess(task, args);
  }

  throwIfCancelled(task.id);
  if (bundle.metadata) {
    task.speed = 'Đang tạo metadata';
    task.eta = '';
    task.percent = Math.max(task.percent, needsYtdlp ? 99 : 50);
    emitTaskUpdate(task);

    const info = await fetchVideoInfo(options.url, task.id);
    throwIfCancelled(task.id);
    updateTaskFromInfo(task, info);
    const metadataFile = writeRichMetadataFile(task, info);
    if (!downloadedFile) {
      downloadedFile = metadataFile;
    }
  }

  return downloadedFile;
}

function buildDownloadArgs(options, task) {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-overwrites',
    '--newline',
    '--no-warnings',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_PREFIX}%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s|%(progress._downloaded_bytes_str)s`,
    '--print',
    `after_move:${FILE_PREFIX}%(filepath)s`,
  ];

  switch (options.type) {
    case 'video':
      appendVideoSelection(args, options.quality, options.format);
      args.push(
        '--merge-output-format',
        options.format,
        '--remux-video',
        options.format,
      );
      break;

    case 'audio':
      args.push(
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        options.format,
        '--audio-quality',
        options.quality,
      );
      break;

    case 'subtitle':
      args.push(
        '--skip-download',
        '--write-subs',
        '--sub-langs',
        options.subLang,
        '--convert-subs',
        options.format,
      );
      break;

    case 'bundle':
      appendBundleArgs(args, options);
      break;

    default:
      throw new Error(`Không thể tạo lệnh cho kiểu tải ${options.type}.`);
  }

  args.push('-o', path.join(task.folderPath, '%(title)s [%(id)s].%(ext)s'));
  appendFfmpegLocation(args);
  args.push('--', options.url);
  return args;
}

function appendVideoSelection(args, quality, format) {
  const heightFilter = quality && quality !== 'best'
    ? `[height<=${quality}]`
    : '';
  let selector;

  if (format === 'mp4') {
    selector = [
      `bestvideo[ext=mp4]${heightFilter}+bestaudio[ext=m4a]`,
      `best[ext=mp4]${heightFilter}`,
      `bestvideo${heightFilter}+bestaudio`,
      `best${heightFilter}`,
    ].join('/');
  } else if (format === 'webm') {
    selector = [
      `bestvideo[ext=webm]${heightFilter}+bestaudio[ext=webm]`,
      `best[ext=webm]${heightFilter}`,
    ].join('/');
  } else {
    selector = `bestvideo${heightFilter}+bestaudio/best${heightFilter}`;
  }

  args.push('-f', selector);
}

function appendBundleArgs(args, options) {
  const bundle = options.bundleOpts;

  if (bundle.video) {
    appendVideoSelection(args, bundle.videoQual, options.format);
    args.push(
      '--merge-output-format',
      options.format,
      '--remux-video',
      options.format,
    );
  } else if (bundle.audio) {
    args.push('-f', 'bestaudio/best');
  } else {
    args.push('--skip-download');
  }

  if (bundle.audio) {
    args.push(
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      bundle.audioQual,
    );
    if (bundle.video) {
      // Produce a separate MP3 and retain the merged video.
      args.push('--keep-video');
    }
  }

  if (bundle.sub) {
    args.push(
      '--write-subs',
      '--sub-langs',
      options.subLang,
      '--convert-subs',
      'srt',
    );
  }

  if (bundle.thumb) {
    args.push('--write-thumbnail');
  }
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function createLineAccumulator(onLine) {
  let remainder = '';
  return {
    push(chunk) {
      remainder += chunk;
      const lines = remainder.split(/\r\n|\n|\r/);
      remainder = lines.pop() || '';
      for (const line of lines) {
        if (line) {
          onLine(line);
        }
      }
    },
    flush() {
      if (remainder) {
        onLine(remainder);
        remainder = '';
      }
    },
  };
}

function parseProgressLine(task, line) {
  if (task.status !== 'running' || task._terminalEmitted) {
    return false;
  }
  const cleanLine = stripAnsi(line).trim();
  const prefixIndex = cleanLine.indexOf(PROGRESS_PREFIX);

  if (prefixIndex >= 0) {
    const fields = cleanLine.slice(prefixIndex + PROGRESS_PREFIX.length).split('|');
    const percent = Number.parseFloat((fields[0] || '').replace(/[^\d.]/g, ''));
    if (Number.isFinite(percent)) {
      task.percent = Math.max(0, Math.min(100, percent));
    }

    const speed = safeString(fields[1], 100);
    const eta = safeString(fields[2], 100);
    if (speed && speed !== 'NA' && speed !== 'N/A') {
      task.speed = speed;
    }
    if (eta && eta !== 'NA' && eta !== 'N/A') {
      task.eta = eta;
    }
    emitTaskUpdate(task);
    return true;
  }

  const percentMatch = cleanLine.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
  if (percentMatch) {
    task.percent = Math.max(0, Math.min(100, Number(percentMatch[1])));
    const speedMatch = cleanLine.match(/\bat\s+(\S+)/i);
    const etaMatch = cleanLine.match(/\bETA\s+(\S+)/i);
    if (speedMatch) {
      task.speed = speedMatch[1];
    }
    if (etaMatch) {
      task.eta = etaMatch[1];
    }
    emitTaskUpdate(task);
    return true;
  }

  if (/\[(?:Merger|ExtractAudio|VideoConvertor|ThumbnailsConvertor|Fixup\w*)\]/i.test(cleanLine)) {
    task.speed = 'Đang xử lý';
    task.eta = '';
    task.percent = Math.max(task.percent, 99);
    emitTaskUpdate(task);
  }
  return false;
}

function outputPathFromLine(line, targetFolder) {
  const cleanLine = stripAnsi(line).trim();
  const markerIndex = cleanLine.indexOf(FILE_PREFIX);
  if (markerIndex >= 0) {
    return normalizeReportedPath(cleanLine.slice(markerIndex + FILE_PREFIX.length), targetFolder);
  }

  const quotedDestination = cleanLine.match(
    /(?:Destination:|Merging formats into|Moving file)\s+["'](.+?)["']\s*$/i,
  );
  if (quotedDestination) {
    return normalizeReportedPath(quotedDestination[1], targetFolder);
  }

  const plainDestination = cleanLine.match(/(?:Destination:|Writing video subtitles to:)\s+(.+?)\s*$/i);
  if (plainDestination) {
    return normalizeReportedPath(plainDestination[1], targetFolder);
  }

  const thumbnailConversion = cleanLine.match(
    /Converting thumbnail ["'](.+?)["'] to (?:["']?)(jpg|png|webp)(?:["']?)\s*$/i,
  );
  if (thumbnailConversion) {
    const sourcePath = normalizeReportedPath(thumbnailConversion[1], targetFolder);
    return sourcePath.replace(/\.[^.\\/]+$/, `.${thumbnailConversion[2].toLowerCase()}`);
  }

  return '';
}

function normalizeReportedPath(value, targetFolder) {
  const candidate = safeString(value, 32768).replace(/^["']|["']$/g, '');
  if (!candidate || /^(?:NA|N\/A|null|undefined)$/i.test(candidate)) {
    return '';
  }
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(targetFolder, candidate);
}

function runDownloadProcess(task, args) {
  return new Promise((resolve, reject) => {
    throwIfCancelled(task.id);
    const child = spawn(setup.getYtdlpPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    taskProcesses.set(task.id, child);

    let lastFile = '';
    const reportedFiles = [];
    let stderrTail = '';
    let settled = false;

    const handleLine = (line, isStderr) => {
      parseProgressLine(task, line);
      const outputPath = outputPathFromLine(line, task.folderPath);
      if (outputPath) {
        lastFile = outputPath;
        reportedFiles.push(outputPath);
        task.filePath = outputPath;
      }
      if (isStderr) {
        stderrTail = `${stderrTail}${line}\n`.slice(-MAX_ERROR_TEXT);
      }
    };

    const stdoutLines = createLineAccumulator((line) => handleLine(line, false));
    const stderrLines = createLineAccumulator((line) => handleLine(line, true));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdoutLines.push(chunk));
    child.stderr.on('data', (chunk) => stderrLines.push(chunk));

    const cleanUp = () => {
      if (taskProcesses.get(task.id) === child) {
        taskProcesses.delete(task.id);
      }
    };

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanUp();
      reject(new Error(`Không thể chạy yt-dlp: ${error.message}`));
    });

    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      stdoutLines.flush();
      stderrLines.flush();
      cleanUp();

      if (cancelledTaskIds.has(task.id)) {
        reject(new TaskCancelledError());
      } else if (code === 0) {
        const existingFile = reportedFiles.filter((filePath) => fs.existsSync(filePath)).pop();
        const outputFile = existingFile || findTaskOutputFile(task);
        if (outputFile) {
          resolve(outputFile);
        } else {
          reject(new Error(
            `yt-dlp đã kết thúc nhưng không tìm thấy file output${lastFile ? `: ${lastFile}` : '.'}`,
          ));
        }
      } else {
        reject(new Error(processErrorMessage(stderrTail, code)));
      }
    });
  });
}

function findTaskOutputFile(task) {
  if (!task.sourceId || !fs.existsSync(task.folderPath)) {
    return '';
  }
  const marker = `[${task.sourceId}]`;
  const expectedExtension = task.type === 'bundle' || !task.format
    ? ''
    : `.${String(task.format).toLowerCase()}`;
  const candidates = [];
  for (const entry of fs.readdirSync(task.folderPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.includes(marker)) {
      continue;
    }
    if (expectedExtension && path.extname(entry.name).toLowerCase() !== expectedExtension) {
      continue;
    }
    if (/\.(?:part|ytdl|tmp)$/i.test(entry.name) || /\.part\./i.test(entry.name)) {
      continue;
    }
    const filePath = path.join(task.folderPath, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        candidates.push({ filePath, mtimeMs: stat.mtimeMs });
      }
    } catch (_error) {
      // A post-processor can move a candidate while the directory is scanned.
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
  return candidates.at(-1)?.filePath || '';
}

function throwIfCancelled(taskId) {
  if (cancelledTaskIds.has(taskId)) {
    throw new TaskCancelledError();
  }
}

function terminateChildProcess(child) {
  if (!child || !child.pid || child.killed) {
    return;
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const fallbackKill = () => {
      try {
        child.kill();
      } catch (_error) {
        // The process may already have exited.
      }
    };
    killer.once('error', fallbackKill);
    killer.once('close', (code) => {
      if (code !== 0) {
        fallbackKill();
      }
    });
  } else {
    try {
      child.kill('SIGTERM');
    } catch (_error) {
      // The process may already have exited.
    }
  }
}

function cancelDownloadTask(value) {
  const taskId = safeString(value, 200);
  const task = activeTasks.get(taskId);
  if (!task || task.status !== 'running') {
    return false;
  }

  cancelledTaskIds.add(taskId);
  task.status = 'cancelled';
  task.speed = '';
  task.eta = '';
  emitTaskUpdate(task);
  activeTasks.delete(taskId);

  const child = taskProcesses.get(taskId);
  if (child) {
    terminateChildProcess(child);
  }
  const controller = taskAbortControllers.get(taskId);
  if (controller && !controller.signal.aborted) {
    controller.abort(new TaskCancelledError());
  }
  return true;
}

function cancelLegacyDownload(value) {
  const taskId = safeString(value, 200);
  if (taskId) {
    return cancelDownloadTask(taskId);
  }
  const latestTaskId = Array.from(activeTasks.keys()).pop();
  return latestTaskId ? cancelDownloadTask(latestTaskId) : false;
}

function getActiveTasks() {
  return Array.from(activeTasks.values())
    .filter((task) => task.status === 'running')
    .map(publicTask);
}

function saveTaskToHistory(task) {
  const history = loadHistory();
  history.unshift(normalizeHistoryItem({
    id: task.id,
    title: task.title,
    channel: task.channel,
    thumbnail: task.thumbnail,
    type: task.type,
    filePath: task.filePath,
    folderPath: task.folderPath,
    fileName: task.filePath ? path.basename(task.filePath) : '',
    format: task.format,
    quality: task.quality,
    date: task.date,
    duration: '',
  }));
  saveHistory(history);
}

function metadataString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function formatUploadDate(value) {
  const raw = metadataString(value);
  return /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;
}

function formatWholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : '0';
}

function sanitizeFileName(value) {
  const cleaned = safeString(value, 180)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (!cleaned) {
    return 'Video Metadata';
  }
  return reserved.test(cleaned) ? `_${cleaned}` : cleaned;
}

function writeRichMetadataFile(task, info) {
  const targetFolder = task.folderPath;
  const title = metadataString(info.title) || 'Video Metadata';
  const channel = metadataString(info.channel || info.uploader);
  const channelUrl = metadataString(info.channel_url || info.uploader_url);
  const webpageUrl = metadataString(info.webpage_url || info.original_url);
  const uploadDate = formatUploadDate(info.upload_date);
  const duration = metadataString(info.duration_string);
  const description = metadataString(info.description);
  const tags = Array.isArray(info.tags)
    ? info.tags.filter((tag) => typeof tag === 'string')
    : [];
  const hashtags = description.match(/#[\p{L}\p{N}_]+/gu) || [];

  const report = [
    '======================================================================',
    '                      YOUTUBE SEO METADATA REPORT                     ',
    '======================================================================',
    '',
    `📌 TIÊU ĐỀ (TITLE)     : ${title}`,
    `👤 KÊNH (CHANNEL)      : ${channel} (${channelUrl})`,
    `📅 NGÀY ĐĂNG           : ${uploadDate}`,
    `🔗 URL VIDEO           : ${webpageUrl}`,
    `⏱ THỜI LƯỢNG          : ${duration}`,
    `👁 LƯỢT XEM (VIEWS)    : ${formatWholeNumber(info.view_count)}`,
    `👍 LƯỢT THÍCH (LIKES)  : ${formatWholeNumber(info.like_count)}`,
    '',
    '----------------------------------------------------------------------',
    '🏷 THẺ TAGS (TAGS):',
    tags.length ? tags.join(', ') : 'Không có tags',
    '',
    '----------------------------------------------------------------------',
    '# HASHTAGS (SEO):',
    hashtags.length ? hashtags.join(' ') : 'Không có hashtags',
    '',
    '======================================================================',
    '📝 MÔ TẢ VIDEO (DESCRIPTION):',
    '======================================================================',
    description,
    '',
    '======================================================================',
    '',
  ].join('\n');

  fs.mkdirSync(targetFolder, { recursive: true });
  const metadataId = safeString(info.id, 200) || task.sourceId || task.stableSourceId;
  const filePath = path.join(
    targetFolder,
    `${sanitizeFileName(title)} [${sanitizeFileName(metadataId)}] - Metadata.txt`,
  );
  const temporaryPath = `${filePath}.${task.id}.part`;
  fs.writeFileSync(temporaryPath, report, 'utf8');
  replaceFileAtomicSync(temporaryPath, filePath);
  return filePath;
}

async function selectFolder() {
  const settings = loadSettings();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn thư mục lưu file',
    defaultPath: settings.downloadPath,
    properties: ['openDirectory', 'createDirectory'],
  });

  if (!result.canceled && result.filePaths[0]) {
    settings.downloadPath = path.normalize(result.filePaths[0]);
    saveSettings(settings);
  }
  return settings.downloadPath;
}

async function openFolder(value) {
  const settings = loadSettings();
  let folderPath = absolutePathOr(value, settings.downloadPath);

  try {
    const stat = fs.statSync(folderPath);
    if (stat.isFile()) {
      folderPath = path.dirname(folderPath);
    }
  } catch (_error) {
    if (!value) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
  }

  return (await shell.openPath(folderPath)) === '';
}

async function openFile(value) {
  const filePath = absolutePathOr(value, '');
  if (!filePath) {
    return false;
  }
  return (await shell.openPath(filePath)) === '';
}

const rendererEntryPath = path.resolve(__dirname, 'renderer', 'index.html');

function normalizedComparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isTrustedRendererUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') {
      return false;
    }
    return normalizedComparablePath(fileURLToPath(parsed))
      === normalizedComparablePath(rendererEntryPath);
  } catch (_error) {
    return false;
  }
}

function isTrustedIpcEvent(event) {
  const frame = event.senderFrame;
  return Boolean(
    frame
    && frame === event.sender.mainFrame
    && isTrustedRendererUrl(frame.url),
  );
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcEvent(event)) {
      throw new Error('IPC request bị từ chối vì không đến từ renderer nội bộ.');
    }
    return handler(event, ...args);
  });
}

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#09090B',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadFile(rendererEntryPath).catch((error) => {
    console.error('Could not load renderer:', error);
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

handleTrusted('window-minimize', (event) => {
  windowFromEvent(event)?.minimize();
});
handleTrusted('window-maximize', (event) => {
  const window = windowFromEvent(event);
  if (!window) {
    return false;
  }
  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }
  return window.isMaximized();
});
handleTrusted('window-close', (event) => {
  windowFromEvent(event)?.close();
});

handleTrusted('check-binaries', () => setup.areBinariesReady());
handleTrusted('setup-binaries', async () => {
  try {
    await ensureBinaries();
    return { success: true };
  } catch (error) {
    return { success: false, error: safeString(error.message || String(error), MAX_ERROR_TEXT) };
  }
});

handleTrusted('get-video-info', (_event, url) => getVideoInfo(url));
handleTrusted('get-playlist-info', (_event, url) => getPlaylistInfo(url));
handleTrusted('start-download-task', (_event, options) => startDownloadTask(options));
handleTrusted('start-download', (_event, options) => startDownloadTask(options));
handleTrusted('cancel-download-task', (_event, taskId) => cancelDownloadTask(taskId));
handleTrusted('cancel-download', (_event, taskId) => cancelLegacyDownload(taskId));
handleTrusted('get-active-tasks', () => getActiveTasks());

handleTrusted('get-history', () => loadHistory());
handleTrusted('save-history', (_event, items) => saveHistory(items));
handleTrusted('remove-history-item', (_event, itemId) => removeHistoryItem(itemId));
handleTrusted('clear-history', () => saveHistory([]));
handleTrusted('get-settings', () => loadSettings());
handleTrusted('save-settings', (_event, settings) => saveSettings(settings));
handleTrusted('get-download-path', () => loadSettings().downloadPath);

handleTrusted('select-folder', () => selectFolder());
handleTrusted('open-folder', (_event, folderPath) => openFolder(folderPath));
handleTrusted('open-file', (_event, filePath) => openFile(filePath));

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  for (const child of taskProcesses.values()) {
    terminateChildProcess(child);
  }
  for (const controller of taskAbortControllers.values()) {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Ứng dụng đang đóng.'));
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isQuitting) {
    app.quit();
  }
});
