/**
 * setup.js — Auto-download yt-dlp.exe and ffmpeg.exe into bin/ folder
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const BIN_DIR = path.join(__dirname, 'bin');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

function ensureBinDir() {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }
}

function getYtdlpPath() {
  return path.join(BIN_DIR, 'yt-dlp.exe');
}

function getFfmpegPath() {
  return path.join(BIN_DIR, 'ffmpeg.exe');
}

function getFfprobePath() {
  return path.join(BIN_DIR, 'ffprobe.exe');
}

/**
 * Follow redirects and download a file with progress callback
 */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let totalBytes = 0;
    let receivedBytes = 0;

    function doRequest(requestUrl) {
      const proto = requestUrl.startsWith('https') ? https : http;
      proto.get(requestUrl, { headers: { 'User-Agent': 'YT-Downloader-Pro/1.0' } }, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume(); // consume response to free socket
          doRequest(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${response.statusCode} when downloading ${requestUrl}`));
          return;
        }

        totalBytes = parseInt(response.headers['content-length'] || '0', 10);

        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (onProgress && totalBytes > 0) {
            onProgress({
              received: receivedBytes,
              total: totalBytes,
              percent: Math.round((receivedBytes / totalBytes) * 100)
            });
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close(() => resolve(destPath));
        });

        file.on('error', (err) => {
          fs.unlinkSync(destPath);
          reject(err);
        });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(err);
      });
    }

    doRequest(url);
  });
}

/**
 * Extract ffmpeg.exe and ffprobe.exe from the downloaded zip
 */
async function extractFfmpegFromZip(zipPath) {
  // Use Node.js built-in zlib + manual zip parsing
  // The zip from BtbN has structure: ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe
  const { execSync } = require('child_process');

  // Use PowerShell to extract specific files
  const extractDir = path.join(BIN_DIR, '_ffmpeg_extract');

  try {
    // Extract the entire zip
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, {
      timeout: 120000
    });

    // Find and copy ffmpeg.exe and ffprobe.exe
    const entries = fs.readdirSync(extractDir);
    for (const entry of entries) {
      const binDir = path.join(extractDir, entry, 'bin');
      if (fs.existsSync(binDir)) {
        const ffmpegSrc = path.join(binDir, 'ffmpeg.exe');
        const ffprobeSrc = path.join(binDir, 'ffprobe.exe');

        if (fs.existsSync(ffmpegSrc)) {
          fs.copyFileSync(ffmpegSrc, getFfmpegPath());
        }
        if (fs.existsSync(ffprobeSrc)) {
          fs.copyFileSync(ffprobeSrc, getFfprobePath());
        }
        break;
      }
    }
  } finally {
    // Cleanup
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

/**
 * Check and download all required binaries
 * Returns { ytdlp: boolean, ffmpeg: boolean } indicating what was downloaded
 */
async function ensureBinaries(onStatus) {
  ensureBinDir();
  const result = { ytdlp: false, ffmpeg: false };

  // Check yt-dlp
  if (!fs.existsSync(getYtdlpPath())) {
    if (onStatus) onStatus({ step: 'ytdlp', status: 'downloading', message: 'Đang tải yt-dlp...' });
    try {
      await downloadFile(YTDLP_URL, getYtdlpPath(), (progress) => {
        if (onStatus) onStatus({ step: 'ytdlp', status: 'progress', ...progress });
      });
      result.ytdlp = true;
      if (onStatus) onStatus({ step: 'ytdlp', status: 'done', message: 'yt-dlp đã sẵn sàng!' });
    } catch (err) {
      if (onStatus) onStatus({ step: 'ytdlp', status: 'error', message: `Lỗi tải yt-dlp: ${err.message}` });
      throw err;
    }
  } else {
    if (onStatus) onStatus({ step: 'ytdlp', status: 'exists', message: 'yt-dlp đã có sẵn.' });
  }

  // Check ffmpeg
  if (!fs.existsSync(getFfmpegPath())) {
    if (onStatus) onStatus({ step: 'ffmpeg', status: 'downloading', message: 'Đang tải ffmpeg (có thể mất vài phút)...' });
    const zipPath = path.join(BIN_DIR, 'ffmpeg.zip');
    try {
      await downloadFile(FFMPEG_URL, zipPath, (progress) => {
        if (onStatus) onStatus({ step: 'ffmpeg', status: 'progress', ...progress });
      });
      if (onStatus) onStatus({ step: 'ffmpeg', status: 'extracting', message: 'Đang giải nén ffmpeg...' });
      await extractFfmpegFromZip(zipPath);
      result.ffmpeg = true;
      if (onStatus) onStatus({ step: 'ffmpeg', status: 'done', message: 'ffmpeg đã sẵn sàng!' });
    } catch (err) {
      if (onStatus) onStatus({ step: 'ffmpeg', status: 'error', message: `Lỗi tải ffmpeg: ${err.message}` });
      throw err;
    }
  } else {
    if (onStatus) onStatus({ step: 'ffmpeg', status: 'exists', message: 'ffmpeg đã có sẵn.' });
  }

  return result;
}

function areBinariesReady() {
  return fs.existsSync(getYtdlpPath()) && fs.existsSync(getFfmpegPath());
}

module.exports = {
  ensureBinaries,
  areBinariesReady,
  getYtdlpPath,
  getFfmpegPath,
  getFfprobePath,
  BIN_DIR
};
