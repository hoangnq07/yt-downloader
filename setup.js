/**
 * Download, install, and validate the yt-dlp/FFmpeg runtime tools.
 */

'use strict';

const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const fsp = fs.promises;

// app.asar is read-only. Packaged builds keep downloaded tools in userData.
const BIN_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'bin')
  : path.join(__dirname, 'bin');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_IDLE_TIMEOUT_MS = 30 * 1000;
const MAX_REDIRECTS = 10;
const MAX_BINARY_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 20 * 1000;

let validatedFingerprint = '';

function getYtdlpPath() {
  return path.join(BIN_DIR, 'yt-dlp.exe');
}

function getFfmpegPath() {
  return path.join(BIN_DIR, 'ffmpeg.exe');
}

function getFfprobePath() {
  return path.join(BIN_DIR, 'ffprobe.exe');
}

async function ensureBinDir() {
  await fsp.mkdir(BIN_DIR, { recursive: true });
}

function binaryFingerprint() {
  try {
    return [getYtdlpPath(), getFfmpegPath(), getFfprobePath()]
      .map((filePath) => {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.size}:${stat.mtimeMs}`;
      })
      .join('|');
  } catch (_error) {
    return '';
  }
}

async function areBinariesReady() {
  const currentFingerprint = binaryFingerprint();
  if (!currentFingerprint) {
    return false;
  }
  if (currentFingerprint === validatedFingerprint) {
    return true;
  }

  const validation = await validateAllBinaries();
  if (!validation.ytdlp || !validation.ffmpeg || !validation.ffprobe) {
    return false;
  }
  const validatedCurrentFingerprint = binaryFingerprint();
  if (!validatedCurrentFingerprint || validatedCurrentFingerprint !== currentFingerprint) {
    return false;
  }
  validatedFingerprint = validatedCurrentFingerprint;
  return true;
}

function createCombinedAbortSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;
  const forwardAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal.reason || new Error('Đã hủy tải file.'));
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  if (!controller.signal.aborted && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`Quá thời gian tải file (${Math.round(timeoutMs / 1000)} giây).`));
    }, timeoutMs);
    timeoutId.unref?.();
  }

  return {
    signal: controller.signal,
    dispose() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      externalSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

function openDownloadResponse(rawUrl, signal, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_error) {
      reject(new Error(`URL tải xuống không hợp lệ: ${rawUrl}`));
      return;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error(`Giao thức tải xuống không được hỗ trợ: ${parsed.protocol}`));
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, {
      headers: {
        'User-Agent': 'YT-Downloader-Pro/1.0',
        Accept: '*/*',
      },
      signal,
    }, (response) => {
      const statusCode = response.statusCode || 0;
      if (
        statusCode >= 300
        && statusCode < 400
        && response.headers.location
      ) {
        response.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error('Quá nhiều lần chuyển hướng khi tải file.'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, parsed).toString();
        resolve(openDownloadResponse(redirectUrl, signal, redirectCount + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${statusCode} khi tải ${parsed.origin}.`));
        return;
      }
      resolve(response);
    });

    request.setTimeout(REQUEST_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error('Kết nối tải xuống không phản hồi.'));
    });
    request.once('error', reject);
  });
}

async function atomicReplace(sourcePath, targetPath) {
  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) {
      throw error;
    }
    await fsp.rm(targetPath, { force: true });
    await fsp.rename(sourcePath, targetPath);
  }
}

/**
 * Stream a URL to `${destinationPath}.part`, then atomically promote it.
 * Callers can pass an AbortSignal and a maximum accepted payload size.
 */
async function downloadFileAtomic(
  url,
  destinationPath,
  onProgress,
  {
    signal: externalSignal,
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxBytes = MAX_BINARY_DOWNLOAD_BYTES,
  } = {},
) {
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  const partPath = `${destinationPath}.part`;
  await fsp.rm(partPath, { force: true });

  const combined = createCombinedAbortSignal(externalSignal, timeoutMs);
  try {
    const response = await openDownloadResponse(url, combined.signal);
    const declaredLength = Number(response.headers['content-length']) || 0;
    if (declaredLength > maxBytes) {
      response.destroy();
      throw new Error(`File tải xuống vượt giới hạn ${maxBytes} byte.`);
    }

    let receivedBytes = 0;
    const progressStream = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBytes) {
          callback(new Error(`File tải xuống vượt giới hạn ${maxBytes} byte.`));
          return;
        }
        if (typeof onProgress === 'function') {
          const percent = declaredLength > 0
            ? Math.min(100, Math.round((receivedBytes / declaredLength) * 100))
            : 0;
          onProgress({
            received: receivedBytes,
            total: declaredLength,
            percent,
          });
        }
        callback(null, chunk);
      },
    });

    const destination = fs.createWriteStream(partPath, {
      flags: 'wx',
      mode: 0o755,
    });
    await pipeline(response, progressStream, destination, {
      signal: combined.signal,
    });

    if (receivedBytes <= 0) {
      throw new Error('File tải xuống rỗng.');
    }
    await atomicReplace(partPath, destinationPath);
    return destinationPath;
  } catch (error) {
    if (combined.signal.aborted && combined.signal.reason instanceof Error) {
      throw combined.signal.reason;
    }
    throw error;
  } finally {
    combined.dispose();
    await fsp.rm(partPath, { force: true }).catch(() => {});
  }
}

async function commandVersion(executable, args) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return `${stdout || ''}\n${stderr || ''}`.trim();
  } catch (_error) {
    return '';
  }
}

async function validateYtdlp(executable = getYtdlpPath()) {
  try {
    const stat = await fsp.stat(executable);
    if (!stat.isFile() || stat.size < 100 * 1024) {
      return false;
    }
  } catch (_error) {
    return false;
  }
  const version = await commandVersion(executable, ['--ignore-config', '--version']);
  return /^\d{4}\.\d{2}\.\d{2}/m.test(version);
}

async function validateFfmpeg(executable = getFfmpegPath()) {
  try {
    const stat = await fsp.stat(executable);
    if (!stat.isFile() || stat.size < 500 * 1024) {
      return false;
    }
  } catch (_error) {
    return false;
  }
  const version = await commandVersion(executable, ['-version']);
  return /ffmpeg version/i.test(version);
}

async function validateFfprobe(executable = getFfprobePath()) {
  try {
    const stat = await fsp.stat(executable);
    if (!stat.isFile() || stat.size < 500 * 1024) {
      return false;
    }
  } catch (_error) {
    return false;
  }
  const version = await commandVersion(executable, ['-version']);
  return /ffprobe version/i.test(version);
}

async function validateAllBinaries() {
  const [ytdlp, ffmpeg, ffprobe] = await Promise.all([
    validateYtdlp(),
    validateFfmpeg(),
    validateFfprobe(),
  ]);
  return { ytdlp, ffmpeg, ffprobe };
}

async function copyFileAtomic(sourcePath, targetPath) {
  const partPath = `${targetPath}.part`;
  await fsp.rm(partPath, { force: true });
  try {
    await fsp.copyFile(sourcePath, partPath);
    await atomicReplace(partPath, targetPath);
  } finally {
    await fsp.rm(partPath, { force: true }).catch(() => {});
  }
}

async function findFfmpegExecutables(rootDirectory) {
  const found = {
    ffmpeg: '',
    ffprobe: '',
  };
  const pending = [rootDirectory];

  while (pending.length && (!found.ffmpeg || !found.ffprobe)) {
    const directory = pending.pop();
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        const name = entry.name.toLowerCase();
        if (name === 'ffmpeg.exe') {
          found.ffmpeg = entryPath;
        } else if (name === 'ffprobe.exe') {
          found.ffprobe = entryPath;
        }
      }
    }
  }
  return found;
}

async function extractFfmpegFromZip(zipPath) {
  const extractDirectory = await fsp.mkdtemp(path.join(BIN_DIR, '.ffmpeg-extract-'));
  try {
    if (process.platform === 'win32') {
      // Paths are passed as environment data, never interpolated into the command.
      await execFileAsync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $env:YTDP_ARCHIVE -DestinationPath $env:YTDP_DESTINATION -Force',
      ], {
        windowsHide: true,
        timeout: 3 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          YTDP_ARCHIVE: zipPath,
          YTDP_DESTINATION: extractDirectory,
        },
      });
    } else {
      await execFileAsync('unzip', ['-q', zipPath, '-d', extractDirectory], {
        timeout: 3 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
    }

    const extracted = await findFfmpegExecutables(extractDirectory);
    if (!extracted.ffmpeg || !extracted.ffprobe) {
      throw new Error('Gói FFmpeg không chứa đủ ffmpeg.exe và ffprobe.exe.');
    }

    const [ffmpegValid, ffprobeValid] = await Promise.all([
      validateFfmpeg(extracted.ffmpeg),
      validateFfprobe(extracted.ffprobe),
    ]);
    if (!ffmpegValid || !ffprobeValid) {
      throw new Error('ffmpeg.exe hoặc ffprobe.exe trong gói tải xuống không hợp lệ.');
    }

    const token = `${process.pid}-${Date.now()}`;
    const ffmpegCandidate = path.join(BIN_DIR, `.ffmpeg-${token}.exe`);
    const ffprobeCandidate = path.join(BIN_DIR, `.ffprobe-${token}.exe`);
    try {
      await Promise.all([
        copyFileAtomic(extracted.ffmpeg, ffmpegCandidate),
        copyFileAtomic(extracted.ffprobe, ffprobeCandidate),
      ]);

      const [candidateFfmpegValid, candidateFfprobeValid] = await Promise.all([
        validateFfmpeg(ffmpegCandidate),
        validateFfprobe(ffprobeCandidate),
      ]);
      if (!candidateFfmpegValid || !candidateFfprobeValid) {
        throw new Error('Không thể xác thực FFmpeg trước khi cài đặt.');
      }

      await atomicReplace(ffmpegCandidate, getFfmpegPath());
      await atomicReplace(ffprobeCandidate, getFfprobePath());
    } finally {
      await Promise.all([
        fsp.rm(ffmpegCandidate, { force: true }).catch(() => {}),
        fsp.rm(ffprobeCandidate, { force: true }).catch(() => {}),
        fsp.rm(`${ffmpegCandidate}.part`, { force: true }).catch(() => {}),
        fsp.rm(`${ffprobeCandidate}.part`, { force: true }).catch(() => {}),
      ]);
    }
  } finally {
    await fsp.rm(extractDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function report(onStatus, value) {
  if (typeof onStatus === 'function') {
    onStatus(value);
  }
}

async function installYtdlp(onStatus) {
  const token = `${process.pid}-${Date.now()}`;
  const candidatePath = path.join(BIN_DIR, `.yt-dlp-${token}.exe`);
  try {
    report(onStatus, {
      step: 'ytdlp',
      status: 'downloading',
      message: 'Đang tải yt-dlp...',
    });
    await downloadFileAtomic(YTDLP_URL, candidatePath, (progress) => {
      report(onStatus, { step: 'ytdlp', status: 'progress', ...progress });
    });
    if (!await validateYtdlp(candidatePath)) {
      throw new Error('yt-dlp tải xuống không hợp lệ.');
    }
    await atomicReplace(candidatePath, getYtdlpPath());
    if (!await validateYtdlp()) {
      await fsp.rm(getYtdlpPath(), { force: true });
      throw new Error('Không thể xác thực yt-dlp sau khi cài đặt.');
    }
    report(onStatus, {
      step: 'ytdlp',
      status: 'done',
      message: 'yt-dlp đã sẵn sàng!',
    });
  } finally {
    await fsp.rm(candidatePath, { force: true }).catch(() => {});
    await fsp.rm(`${candidatePath}.part`, { force: true }).catch(() => {});
  }
}

async function installFfmpeg(onStatus) {
  const archivePath = path.join(BIN_DIR, `.ffmpeg-${process.pid}-${Date.now()}.zip`);
  try {
    report(onStatus, {
      step: 'ffmpeg',
      status: 'downloading',
      message: 'Đang tải ffmpeg (có thể mất vài phút)...',
    });
    await downloadFileAtomic(FFMPEG_URL, archivePath, (progress) => {
      report(onStatus, { step: 'ffmpeg', status: 'progress', ...progress });
    });
    report(onStatus, {
      step: 'ffmpeg',
      status: 'extracting',
      message: 'Đang giải nén và kiểm tra ffmpeg...',
    });
    await extractFfmpegFromZip(archivePath);

    const [ffmpegValid, ffprobeValid] = await Promise.all([
      validateFfmpeg(),
      validateFfprobe(),
    ]);
    if (!ffmpegValid || !ffprobeValid) {
      throw new Error('Không thể xác thực ffmpeg/ffprobe sau khi cài đặt.');
    }
    report(onStatus, {
      step: 'ffmpeg',
      status: 'done',
      message: 'ffmpeg và ffprobe đã sẵn sàng!',
    });
  } finally {
    await fsp.rm(archivePath, { force: true }).catch(() => {});
    await fsp.rm(`${archivePath}.part`, { force: true }).catch(() => {});
  }
}

async function ensureBinaries(onStatus) {
  await ensureBinDir();
  validatedFingerprint = '';
  const result = {
    ytdlp: false,
    ffmpeg: false,
    ffprobe: false,
  };

  try {
    if (await validateYtdlp()) {
      report(onStatus, {
        step: 'ytdlp',
        status: 'exists',
        message: 'yt-dlp đã có sẵn và hợp lệ.',
      });
    } else {
      await installYtdlp(onStatus);
      result.ytdlp = true;
    }

    const [ffmpegValid, ffprobeValid] = await Promise.all([
      validateFfmpeg(),
      validateFfprobe(),
    ]);
    if (ffmpegValid && ffprobeValid) {
      report(onStatus, {
        step: 'ffmpeg',
        status: 'exists',
        message: 'ffmpeg và ffprobe đã có sẵn và hợp lệ.',
      });
    } else {
      await installFfmpeg(onStatus);
      result.ffmpeg = true;
      result.ffprobe = true;
    }

    const validation = await validateAllBinaries();
    if (!validation.ytdlp || !validation.ffmpeg || !validation.ffprobe) {
      throw new Error('Bộ công cụ tải xuống chưa đầy đủ hoặc không hợp lệ.');
    }
    validatedFingerprint = binaryFingerprint();
    return result;
  } catch (error) {
    validatedFingerprint = '';
    report(onStatus, {
      step: 'setup',
      status: 'error',
      message: `Lỗi thiết lập công cụ: ${error.message}`,
    });
    throw error;
  }
}

module.exports = {
  ensureBinaries,
  areBinariesReady,
  downloadFileAtomic,
  getYtdlpPath,
  getFfmpegPath,
  getFfprobePath,
  BIN_DIR,
};
