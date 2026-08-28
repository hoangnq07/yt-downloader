import { ClientType, Innertube, Platform } from 'youtubei.js/web';

const titleElement = document.getElementById('videoTitle');
const channelElement = document.getElementById('videoChannel');
const thumbElement = document.getElementById('videoThumb');
const statusElement = document.getElementById('status');
const thumbnailQuality = document.getElementById('thumbnailQuality');
const thumbnailButton = document.getElementById('downloadThumbnail');
const metadataTxtButton = document.getElementById('downloadMetadataTxt');
const subtitleTrack = document.getElementById('subtitleTrack');
const subtitleFormat = document.getElementById('subtitleFormat');
const subtitleButton = document.getElementById('downloadSubtitle');
const subtitleCount = document.getElementById('subtitleCount');
const mediaQuality = document.getElementById('mediaQuality');
const mediaButton = document.getElementById('sendMediaToApp');
const mediaStreamCount = document.getElementById('mediaStreamCount');
const transferProgress = document.getElementById('transferProgress');
const transferProgressBar = document.getElementById('transferProgressBar');
const mediaType = document.getElementById('mediaType');
const directVideoQuality = document.getElementById('directVideoQuality');
const btnDirectVideo = document.getElementById('btnDirectVideo');
const directAudioFormat = document.getElementById('directAudioFormat');
const btnDirectAudio = document.getElementById('btnDirectAudio');
const sandboxFrame = document.getElementById('youtubeJsSandbox');

let pageData = null;
let innertubePromise = null;
let transferPollTimer = null;

const sandboxPending = new Map();
let sandboxSequence = 0;
const sandboxReady = new Promise(resolve => {
  if (!sandboxFrame) {
    resolve();
    return;
  }
  sandboxFrame.addEventListener('load', resolve, { once: true });
  setTimeout(resolve, 500);
});

window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== sandboxFrame?.contentWindow || message?.type !== 'yt-downloader-evaluate-result') return;
  const pending = sandboxPending.get(message.id);
  if (!pending) return;
  sandboxPending.delete(message.id);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.result);
});

Platform.shim.eval = async (data, env) => {
  await sandboxReady;
  const id = `eval-${Date.now()}-${sandboxSequence += 1}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sandboxPending.delete(id);
      reject(new Error('Bộ giải mã YouTube.js phản hồi quá lâu.'));
    }, 15000);
    sandboxPending.set(id, {
      resolve: value => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      }
    });
    sandboxFrame?.contentWindow?.postMessage({ type: 'yt-downloader-evaluate', id, data, env }, '*');
  });
};

function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0] || null));
  });
}

function executeInMainWorld(tabId, func) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func }, results => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(results?.[0]?.result || null);
    });
  });
}

function extractYouTubePageData() {
  function textFromRuns(value) {
    if (value?.simpleText) return value.simpleText;
    return Array.isArray(value?.runs) ? value.runs.map(run => run.text || '').join('') : '';
  }

  function readMeta(selector, attribute = 'content') {
    return document.querySelector(selector)?.getAttribute(attribute) || '';
  }

  const currentURL = new URL(location.href);
  const currentVideoId = currentURL.searchParams.get('v') || '';

  function getPlayerResponse() {
    // 1. YouTube official Movie Player API (always returns active video in SPA)
    try {
      const moviePlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (moviePlayer && typeof moviePlayer.getPlayerResponse === 'function') {
        const pr = moviePlayer.getPlayerResponse();
        if (pr?.videoDetails?.videoId && (!currentVideoId || pr.videoDetails.videoId === currentVideoId)) {
          return pr;
        }
      }
    } catch (_) {}

    // 2. Polymer / Web Component watch-flexy element
    try {
      const watchFlexy = document.querySelector('ytd-watch-flexy');
      const flexyPr = watchFlexy?.playerData || watchFlexy?.data?.playerResponse;
      if (flexyPr?.videoDetails?.videoId && (!currentVideoId || flexyPr.videoDetails.videoId === currentVideoId)) {
        return flexyPr;
      }
    } catch (_) {}

    // 3. Page Manager element data
    try {
      const pageManager = document.querySelector('ytd-page-manager');
      if (pageManager && typeof pageManager.getCurrentData === 'function') {
        const pmPr = pageManager.getCurrentData()?.playerResponse;
        if (pmPr?.videoDetails?.videoId && (!currentVideoId || pmPr.videoDetails.videoId === currentVideoId)) {
          return pmPr;
        }
      }
    } catch (_) {}

    // 4. Initial Player Response (only if videoId matches current URL to prevent SPA stale data)
    if (window.ytInitialPlayerResponse?.videoDetails?.videoId) {
      if (!currentVideoId || window.ytInitialPlayerResponse.videoDetails.videoId === currentVideoId) {
        return window.ytInitialPlayerResponse;
      }
    }

    // 5. Config args
    try {
      const raw = window.ytplayer?.config?.args?.player_response;
      let parsed = null;
      if (typeof raw === 'string') parsed = JSON.parse(raw);
      else if (raw && typeof raw === 'object') parsed = raw;
      if (parsed?.videoDetails?.videoId && (!currentVideoId || parsed.videoDetails.videoId === currentVideoId)) {
        return parsed;
      }
    } catch (_) {}

    return null;
  }

  const playerResponse = getPlayerResponse();
  const videoDetails = playerResponse?.videoDetails || {};
  const microformat = playerResponse?.microformat?.playerMicroformatRenderer || {};
  const captionRenderer = playerResponse?.captions?.playerCaptionsTracklistRenderer || {};
  const streamingData = playerResponse?.streamingData || {};
  const videoId = currentVideoId || videoDetails.videoId || '';

  const domTitle = document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim()
    || document.querySelector('h1.title')?.textContent?.trim()
    || readMeta('meta[property="og:title"]')
    || document.title.replace(/\s+-\s+YouTube$/, '');

  const domAuthor = document.querySelector('#owner #channel-name a')?.textContent?.trim()
    || document.querySelector('ytd-channel-name a')?.textContent?.trim()
    || readMeta('link[itemprop="name"]', 'content')
    || readMeta('meta[itemprop="author"]');

  const title = videoDetails.title || domTitle || 'YouTube Video';
  const author = videoDetails.author || domAuthor || 'YouTube';
  const metaKeywords = readMeta('meta[name="keywords"]')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  let thumbnails = Array.isArray(videoDetails.thumbnail?.thumbnails)
    ? videoDetails.thumbnail.thumbnails.map(item => ({
      url: item.url || '',
      width: Number(item.width) || 0,
      height: Number(item.height) || 0
    })).filter(item => item.url)
    : [];

  if (thumbnails.length === 0 && videoId) {
    thumbnails = [
      { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, width: 1280, height: 720 },
      { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 }
    ];
  }

  const captionTracks = Array.isArray(captionRenderer.captionTracks)
    ? captionRenderer.captionTracks.map((track, index) => ({
      id: String(index),
      baseUrl: track.baseUrl || '',
      languageCode: track.languageCode || '',
      name: textFromRuns(track.name) || track.languageCode || `Track ${index + 1}`,
      kind: track.kind || '',
      isAutoGenerated: track.kind === 'asr',
      isTranslatable: Boolean(track.isTranslatable),
      vssId: track.vssId || ''
    })).filter(track => track.baseUrl)
    : [];

  const mediaStreams = [
    ...(Array.isArray(streamingData.formats) ? streamingData.formats : []),
    ...(Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : [])
  ].map(format => {
    const mimeType = String(format.mimeType || '');
    const baseMimeType = mimeType.split(';')[0].trim().toLowerCase();
    let container = '';
    if (baseMimeType.endsWith('/mp4')) container = baseMimeType.startsWith('audio/') ? 'm4a' : 'mp4';
    else if (baseMimeType.endsWith('/webm')) container = 'webm';
    else if (baseMimeType.endsWith('/opus')) container = 'opus';
    return {
      url: typeof format.url === 'string' ? format.url : '',
      itag: Number(format.itag) || 0,
      mimeType,
      container,
      hasVideo: baseMimeType.startsWith('video/') || Boolean(format.qualityLabel),
      hasAudio: baseMimeType.startsWith('audio/') || Boolean(format.audioQuality),
      height: Number(format.height) || 0,
      bitrate: Number(format.bitrate || format.averageBitrate) || 0,
      contentLength: Number(format.contentLength) || 0,
      duration: (Number(format.approxDurationMs) || Number(videoDetails.lengthSeconds) * 1000 || 0) / 1000
    };
  }).filter(stream => {
    if (!stream.url || (!stream.hasVideo && !stream.hasAudio)) return false;
    try {
      const hostname = new URL(stream.url).hostname.toLowerCase();
      return hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com');
    } catch (_) {
      return false;
    }
  });

  return {
    pageUrl: location.href,
    videoId,
    title,
    author,
    channelId: videoDetails.channelId || microformat.externalChannelId || '',
    description: videoDetails.shortDescription || readMeta('meta[name="description"]') || '',
    durationSeconds: Number(videoDetails.lengthSeconds) || 0,
    viewCount: Number(videoDetails.viewCount) || 0,
    keywords: Array.isArray(videoDetails.keywords) && videoDetails.keywords.length ? videoDetails.keywords : metaKeywords,
    category: microformat.category || '',
    publishDate: microformat.publishDate || '',
    uploadDate: microformat.uploadDate || '',
    isLive: Boolean(videoDetails.isLiveContent),
    isFamilySafe: microformat.isFamilySafe ?? null,
    isUnlisted: Boolean(microformat.isUnlisted),
    ownerProfileUrl: microformat.ownerProfileUrl || '',
    canonicalUrl: microformat.canonicalUrl || location.href,
    availableCountries: Array.isArray(microformat.availableCountries) ? microformat.availableCountries : [],
    thumbnails,
    captionTracks,
    mediaStreams,
    playabilityStatus: playerResponse?.playabilityStatus?.status || '',
    playabilityReason: playerResponse?.playabilityStatus?.reason || '',
    extractedAt: new Date().toISOString()
  };
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function streamKey(stream) {
  return `${stream.itag || 0}|${stream.url || ''}`;
}

function uniqueStreams(streams) {
  const seen = new Set();
  return streams.filter(stream => {
    const key = streamKey(stream);
    if (!stream.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectMediaStreams(streams, requestedQuality, requestedType = 'video') {
  const audios = streams.filter(stream => stream.hasAudio && !stream.hasVideo).sort((left, right) => {
    const leftM4a = left.container === 'm4a' ? 1 : 0;
    const rightM4a = right.container === 'm4a' ? 1 : 0;
    if (rightM4a !== leftM4a) return rightM4a - leftM4a;
    return (right.bitrate || 0) - (left.bitrate || 0);
  });
  if (requestedType === 'audio') {
    if (audios[0]) return [audios[0]];
    const progressiveAudio = streams.filter(stream => stream.hasAudio).sort((left, right) => (right.bitrate || 0) - (left.bitrate || 0));
    // A progressive MP4 is still a valid audio source for FFmpeg. Mark the
    // transfer as audio-only so the app opens its MP3 conversion tab instead
    // of treating this fallback as a video capture.
    return progressiveAudio[0] ? [{ ...progressiveAudio[0], hasVideo: false }] : [];
  }

  const desiredHeight = requestedQuality === 'best' ? 0 : Number(requestedQuality) || 0;
  let videos = streams.filter(stream => stream.hasVideo && (!desiredHeight || !stream.height || stream.height <= desiredHeight));
  if (!videos.length && desiredHeight) videos = streams.filter(stream => stream.hasVideo);
  videos.sort((left, right) => {
    if ((right.height || 0) !== (left.height || 0)) return (right.height || 0) - (left.height || 0);
    const leftMp4 = left.container === 'mp4' ? 1 : 0;
    const rightMp4 = right.container === 'mp4' ? 1 : 0;
    if (rightMp4 !== leftMp4) return rightMp4 - leftMp4;
    return (right.bitrate || 0) - (left.bitrate || 0);
  });

  const video = videos[0] || null;
  if (video?.hasAudio) return [video];

  if (video && audios[0]) return [video, audios[0]];
  if (video) return [video];
  if (audios[0]) return [audios[0]];
  return [];
}

function normalizeYouTubeJsFormat(format, url) {
  const mimeType = String(format.mime_type || '');
  const baseMimeType = mimeType.split(';')[0].trim().toLowerCase();
  let container = '';
  if (baseMimeType.endsWith('/mp4')) container = baseMimeType.startsWith('audio/') ? 'm4a' : 'mp4';
  else if (baseMimeType.endsWith('/webm')) container = 'webm';
  else if (baseMimeType.endsWith('/opus')) container = 'opus';
  return {
    url,
    itag: Number(format.itag) || 0,
    mimeType,
    container,
    hasVideo: Boolean(format.has_video),
    hasAudio: Boolean(format.has_audio),
    height: Number(format.height) || 0,
    bitrate: Number(format.bitrate || format.average_bitrate) || 0,
    contentLength: Number(format.content_length) || 0,
    duration: (Number(format.approx_duration_ms) || 0) / 1000
  };
}

async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({
      lang: 'vi',
      client_type: ClientType.WEB,
      generate_session_locally: true,
      enable_session_cache: true,
      fetch: (input, init = {}) => fetch(input, { ...init, credentials: 'include' })
    }).catch(error => {
      innertubePromise = null;
      throw error;
    });
  }
  return innertubePromise;
}

async function getYouTubeJsStreams(videoId, requestedQuality, requestedType) {
  setStatus('Đang dùng YouTube.js để giải mã luồng dự phòng…', 'running');
  const youtube = await getInnertube();
  let lastError = null;

  for (const client of ['TV', 'ANDROID', 'WEB']) {
    try {
      const info = await youtube.getBasicInfo(videoId, { client });
      const formats = [
        ...(info.streaming_data?.formats || []),
        ...(info.streaming_data?.adaptive_formats || [])
      ];
      const candidates = formats.map(format => normalizeYouTubeJsFormat(format, format.url || format.signature_cipher || format.cipher || ''));
      const selectedCandidates = selectMediaStreams(candidates, requestedQuality, requestedType);
      const selected = [];
      for (const candidate of selectedCandidates) {
        const format = formats.find(item => Number(item.itag) === candidate.itag && (item.url || item.signature_cipher || item.cipher));
        if (!format) continue;
        const url = await format.decipher(youtube.session.player);
        const normalized = normalizeYouTubeJsFormat(format, url);
        const hostname = new URL(normalized.url).hostname.toLowerCase();
        if (hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com')) selected.push(normalized);
      }
      if (selected.length) return selected;
      lastError = new Error(info.playability_status?.reason || `Client ${client} không trả về luồng tải.`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('YouTube.js không tìm được luồng tải phù hợp.');
}

function renderTransferStatus(transfer) {
  if (!transfer || transfer.state === 'idle') return;
  transferProgress.hidden = transfer.state !== 'running';
  transferProgressBar.style.width = `${Math.max(0, Math.min(100, Number(transfer.percent) || 0))}%`;
  if (transfer.state === 'running') {
    mediaButton.disabled = true;
    mediaButton.textContent = transfer.percent > 0 ? `${Math.round(transfer.percent)}%` : 'Đang gửi…';
    setStatus(transfer.message || 'Đang gửi media sang app…', 'running');
  } else if (transfer.state === 'completed') {
    mediaButton.disabled = false;
    mediaButton.textContent = 'Gửi lại';
    setStatus(transfer.message, 'success');
  } else if (transfer.state === 'error') {
    mediaButton.disabled = false;
    mediaButton.textContent = 'Thử lại';
    setStatus(transfer.message, 'error');
  }
}

async function refreshTransferStatus() {
  try {
    const transfer = await sendRuntimeMessage({ action: 'get-transfer-status' });
    renderTransferStatus(transfer);
    if (transfer?.state !== 'running' && transferPollTimer) {
      clearInterval(transferPollTimer);
      transferPollTimer = null;
    }
  } catch (_) {}
}

function startTransferPolling() {
  if (!transferPollTimer) transferPollTimer = setInterval(refreshTransferStatus, 500);
  void refreshTransferStatus();
}

function updateMediaModeUI() {
  const audioMode = mediaType.value === 'audio';
  mediaQuality.disabled = audioMode;
  mediaButton.textContent = audioMode ? 'Gửi audio' : 'Gửi video';
  if (!pageData) return;
  const videoCount = pageData.mediaStreams.filter(stream => stream.hasVideo).length;
  const audioCount = pageData.mediaStreams.filter(stream => stream.hasAudio).length;
  mediaStreamCount.textContent = audioMode
    ? (audioCount ? `${audioCount} luồng audio` : 'Sẽ dùng YouTube.js dự phòng')
    : (videoCount ? `${videoCount} video · ${audioCount} audio` : 'Sẽ dùng YouTube.js dự phòng');
}

function setStatus(message, type = '') {
  statusElement.className = `status ${type}`.trim();
  statusElement.textContent = message;
}

function safeFilename(value) {
  const cleaned = String(value || 'YouTube Video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || 'YouTube Video').slice(0, 150);
}

function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, downloadId => {
      const error = chrome.runtime.lastError;
      if (error || !Number.isInteger(downloadId)) {
        reject(new Error(error?.message || 'Không thể bắt đầu tải file.'));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function downloadText(filename, content, mimeType) {
  const objectURL = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  try {
    await startDownload({ url: objectURL, filename, saveAs: false, conflictAction: 'uniquify' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectURL), 30000);
  }
}

function normalizeChapterLine(line) {
  const match = String(line || '').trim().match(/^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*(?:[-\u2013\u2014]\s*)?(.*)$/);
  if (!match) return '';

  const timestampParts = match[1].split(':');
  if (timestampParts.length === 3 && Number(timestampParts[0]) === 0) {
    timestampParts.shift();
  }
  const timestamp = timestampParts
    .map((part, index) => index === 0 && timestampParts.length === 3
      ? String(Number(part))
      : part.padStart(2, '0'))
    .join(':');
  const title = match[2].replace(/^\d+[.)]\s+/, '').trim();

  return title ? `${timestamp} - ${title}` : '';
}

function metadataAsText(data) {
  const titleText = data.title || '';
  const normalizedDescription = String(data.description || '')
    .split(/\r?\n/)
    .map(line => normalizeChapterLine(line) || line)
    .join('\n');
  const hashtags = [...new Set(`${titleText}\n${normalizedDescription}`.match(/#[\p{L}\p{N}_-]+/gu) || [])];
  const keywords = [...new Set((data.keywords || []).map(value => String(value).trim()).filter(Boolean))];
  const chapters = normalizedDescription.split(/\r?\n/)
    .map(normalizeChapterLine)
    .filter(Boolean);
  const titleWords = titleText.trim().split(/\s+/).filter(Boolean);
  const descriptionWords = normalizedDescription.trim().split(/\s+/).filter(Boolean);
  const duration = Math.max(0, Number(data.durationSeconds) || 0);
  const durationText = [
    Math.floor(duration / 3600),
    Math.floor((duration % 3600) / 60),
    duration % 60
  ].map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0')).join(':');
  const channelURL = data.ownerProfileUrl || (data.channelId ? `https://www.youtube.com/channel/${data.channelId}` : '');
  const bestThumbnail = [...(data.thumbnails || [])]
    .sort((left, right) => right.width * right.height - left.width * left.height)[0];

  const checks = [
    { label: 'Độ dài tiêu đề 30–70 ký tự', pass: titleText.length >= 30 && titleText.length <= 70 },
    { label: 'Mô tả có ít nhất 200 ký tự', pass: normalizedDescription.length >= 200 },
    { label: 'Có keyword/tag', pass: keywords.length > 0 },
    { label: 'Có hashtag', pass: hashtags.length > 0 },
    { label: 'Có mốc thời gian/chapter', pass: chapters.length > 0 }
  ];
  const score = Math.round(checks.filter(check => check.pass).length / checks.length * 100);
  const line = '======================================================================';
  const shortLine = '----------------------------------------------------------------------';

  return [
    line,
    '                      YOUTUBE SEO METADATA REPORT',
    line,
    '',
    'THÔNG TIN VIDEO',
    shortLine,
    `Tiêu đề             : ${titleText}`,
    `Video ID            : ${data.videoId || ''}`,
    `URL video           : ${data.canonicalUrl || data.pageUrl || ''}`,
    `Kênh                : ${data.author || ''}`,
    `Channel ID          : ${data.channelId || ''}`,
    `URL kênh            : ${channelURL}`,
    `Ngày đăng           : ${data.publishDate || data.uploadDate || ''}`,
    `Ngày upload         : ${data.uploadDate || ''}`,
    `Thời lượng          : ${durationText} (${duration} giây)`,
    `Lượt xem            : ${Number(data.viewCount || 0).toLocaleString('vi-VN')}`,
    `Danh mục            : ${data.category || ''}`,
    `Livestream          : ${data.isLive ? 'Có' : 'Không'}`,
    `Không công khai     : ${data.isUnlisted ? 'Có' : 'Không'}`,
    `An toàn gia đình    : ${data.isFamilySafe === null ? 'Không rõ' : data.isFamilySafe ? 'Có' : 'Không'}`,
    `Số quốc gia khả dụng: ${(data.availableCountries || []).length}`,
    `Số track phụ đề     : ${(data.captionTracks || []).length}`,
    `Thumbnail tốt nhất  : ${bestThumbnail ? `${bestThumbnail.width}x${bestThumbnail.height} - ${bestThumbnail.url}` : ''}`,
    '',
    'TAGS / KEYWORDS',
    shortLine,
    keywords.length ? keywords.join(', ') : 'Không có tags/keywords công khai',
    '',
    'HASHTAGS',
    shortLine,
    hashtags.length ? hashtags.join(' ') : 'Không có hashtag trong tiêu đề hoặc mô tả',
    '',
    'CHAPTERS / TIMESTAMPS',
    shortLine,
    chapters.length ? chapters.join('\r\n') : 'Không phát hiện chapter trong mô tả',
    '',
    line,
    'MÔ TẢ VIDEO',
    line,
    normalizedDescription || 'Không có mô tả',
    ''
  ].join('\r\n');
}

function subtitleTimestamp(milliseconds, separator) {
  const safeValue = Math.max(0, Math.round(milliseconds || 0));
  const hours = Math.floor(safeValue / 3600000);
  const minutes = Math.floor((safeValue % 3600000) / 60000);
  const seconds = Math.floor((safeValue % 60000) / 1000);
  const millis = safeValue % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function captionCues(json) {
  const cues = [];
  for (const event of json?.events || []) {
    if (!Array.isArray(event.segs)) continue;
    const text = event.segs.map(segment => segment.utf8 || '').join('').replace(/\u200b/g, '').trim();
    if (!text) continue;
    cues.push({
      start: Number(event.tStartMs) || 0,
      duration: Number(event.dDurationMs) || 0,
      text
    });
  }
  return cues.map((cue, index) => ({
    ...cue,
    end: cue.start + (cue.duration > 0
      ? cue.duration
      : Math.max(1000, (cues[index + 1]?.start || cue.start + 3000) - cue.start))
  }));
}

function captionsAsSRT(cues) {
  return cues.map((cue, index) => [
    String(index + 1),
    `${subtitleTimestamp(cue.start, ',')} --> ${subtitleTimestamp(cue.end, ',')}`,
    cue.text,
    ''
  ].join('\r\n')).join('\r\n');
}

function captionsAsVTT(cues) {
  const body = cues.map((cue, index) => [
    String(index + 1),
    `${subtitleTimestamp(cue.start, '.')} --> ${subtitleTimestamp(cue.end, '.')}`,
    cue.text,
    ''
  ].join('\n')).join('\n');
  return `WEBVTT\n\n${body}`;
}

async function withBusy(button, label, task) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await task();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

thumbnailButton.addEventListener('click', () => withBusy(thumbnailButton, 'Đang tải…', async () => {
  const quality = thumbnailQuality.value;
  let thumbnailURL = '';
  if (quality === 'best') {
    thumbnailURL = [...pageData.thumbnails].sort((left, right) => right.width * right.height - left.width * left.height)[0]?.url || '';
  } else if (pageData.videoId) {
    thumbnailURL = `https://i.ytimg.com/vi/${pageData.videoId}/${quality}.jpg`;
  }
  if (!thumbnailURL) throw new Error('Không tìm thấy thumbnail cho video này.');
  await startDownload({
    url: thumbnailURL,
    filename: `${safeFilename(pageData.title)} - thumbnail.jpg`,
    saveAs: false,
    conflictAction: 'uniquify'
  });
  setStatus('Đã gửi thumbnail tới trình quản lý tải xuống.', 'success');
}).catch(error => setStatus(error.message || String(error), 'error')));

metadataTxtButton.addEventListener('click', () => withBusy(metadataTxtButton, 'Đang tạo…', async () => {
  await downloadText(
    `${safeFilename(pageData.title)} - metadata.txt`,
    metadataAsText(pageData),
    'text/plain'
  );
  setStatus('Đã tạo file metadata TXT.', 'success');
}).catch(error => setStatus(error.message || String(error), 'error')));

subtitleButton.addEventListener('click', () => withBusy(subtitleButton, 'Đang tải…', async () => {
  const track = pageData.captionTracks.find(item => item.id === subtitleTrack.value);
  if (!track) throw new Error('Hãy chọn một track phụ đề.');
  const captionURL = new URL(track.baseUrl);
  captionURL.searchParams.set('fmt', 'json3');
  const response = await fetch(captionURL.toString(), { credentials: 'include' });
  if (!response.ok) throw new Error(`Không thể tải phụ đề (HTTP ${response.status}).`);
  const json = await response.json();
  const cues = captionCues(json);
  if (!cues.length) throw new Error('Track phụ đề không chứa nội dung.');

  const format = subtitleFormat.value;
  let content;
  let mimeType;
  if (format === 'json') {
    content = JSON.stringify(json, null, 2);
    mimeType = 'application/json';
  } else if (format === 'vtt') {
    content = captionsAsVTT(cues);
    mimeType = 'text/vtt';
  } else {
    content = captionsAsSRT(cues);
    mimeType = 'application/x-subrip';
  }
  const autoSuffix = track.isAutoGenerated ? '.auto' : '';
  await downloadText(
    `${safeFilename(pageData.title)}.${track.languageCode || 'sub'}${autoSuffix}.${format}`,
    content,
    mimeType
  );
  setStatus(`Đã tạo phụ đề ${format.toUpperCase()}.`, 'success');
}).catch(error => setStatus(error.message || String(error), 'error')));

async function downloadDirectAudio(requestedFormat = 'm4a') {
  setStatus('Đang lấy và giải mã audio qua YouTube.js…', 'running');
  const youtube = await getInnertube();
  let lastError = null;

  for (const client of ['ANDROID', 'TV', 'WEB']) {
    try {
      const info = await youtube.getBasicInfo(pageData.videoId, { client });
      const formats = [
        ...(info.streaming_data?.formats || []),
        ...(info.streaming_data?.adaptive_formats || [])
      ];
      let audioFormats = formats.filter(f => Boolean(f.has_audio) && !f.has_video);
      if (requestedFormat === 'm4a') {
        const m4aFormats = audioFormats.filter(f => String(f.mime_type || '').includes('audio/mp4'));
        if (m4aFormats.length) audioFormats = m4aFormats;
      } else if (requestedFormat === 'opus') {
        const opusFormats = audioFormats.filter(f => String(f.mime_type || '').includes('webm') || String(f.mime_type || '').includes('opus'));
        if (opusFormats.length) audioFormats = opusFormats;
      }
      if (!audioFormats.length) {
        audioFormats = formats.filter(f => Boolean(f.has_audio));
      }
      audioFormats.sort((a, b) => (Number(b.bitrate || b.average_bitrate) || 0) - (Number(a.bitrate || a.average_bitrate) || 0));

      const targetFormat = audioFormats[0];
      if (!targetFormat) {
        lastError = new Error(`Client ${client} không có luồng audio.`);
        continue;
      }

      let directUrl = targetFormat.url;
      if (!directUrl && typeof targetFormat.decipher === 'function') {
        directUrl = await targetFormat.decipher(youtube.session.player);
      }
      if (!directUrl) {
        lastError = new Error('Không giải mã được URL audio.');
        continue;
      }

      const mime = String(targetFormat.mime_type || '').toLowerCase();
      let ext = 'm4a';
      if (mime.includes('webm') || mime.includes('opus')) ext = 'opus';
      else if (mime.includes('mp4')) ext = 'm4a';

      const filename = `${safeFilename(pageData.title)}.${ext}`;
      await startDownload({
        url: directUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      setStatus(`Đang tải audio ${ext.toUpperCase()} qua trình duyệt!`, 'success');
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Không thể tải audio qua YouTube.js.');
}

async function downloadDirectVideo(requestedQuality = 'best') {
  setStatus('Đang lấy và giải mã video qua YouTube.js…', 'running');
  const youtube = await getInnertube();
  let lastError = null;

  for (const client of ['ANDROID', 'TV', 'WEB']) {
    try {
      const info = await youtube.getBasicInfo(pageData.videoId, { client });
      const formats = [
        ...(info.streaming_data?.formats || []),
        ...(info.streaming_data?.adaptive_formats || [])
      ];

      let progressiveFormats = formats.filter(f => Boolean(f.has_video) && Boolean(f.has_audio));

      if (requestedQuality !== 'best') {
        const targetHeight = Number(requestedQuality) || 0;
        const matching = progressiveFormats.filter(f => Number(f.height) <= targetHeight);
        if (matching.length) progressiveFormats = matching;
      }

      progressiveFormats.sort((a, b) => {
        if ((Number(b.height) || 0) !== (Number(a.height) || 0)) {
          return (Number(b.height) || 0) - (Number(a.height) || 0);
        }
        return (Number(b.bitrate || b.average_bitrate) || 0) - (Number(a.bitrate || a.average_bitrate) || 0);
      });

      let targetFormat = progressiveFormats[0];
      if (!targetFormat) {
        const videoOnly = formats.filter(f => Boolean(f.has_video)).sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
        if (videoOnly.length) {
          throw new Error('Video này YouTube chỉ cung cấp luồng rời (1080p+). Hãy dùng nút "Gửi sang App" bên dưới để ghép đầy đủ tiếng!');
        }
        lastError = new Error(`Client ${client} không có luồng video.`);
        continue;
      }

      let directUrl = targetFormat.url;
      if (!directUrl && typeof targetFormat.decipher === 'function') {
        directUrl = await targetFormat.decipher(youtube.session.player);
      }
      if (!directUrl) {
        lastError = new Error('Không giải mã được URL video.');
        continue;
      }

      const filename = `${safeFilename(pageData.title)}.mp4`;
      await startDownload({
        url: directUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      setStatus(`Đang tải video MP4 (${targetFormat.height || ''}p) qua trình duyệt!`, 'success');
      return;
    } catch (err) {
      lastError = err;
      if (err.message && err.message.includes('Gửi sang App')) {
        throw err;
      }
    }
  }
  throw lastError || new Error('Không thể tải video qua YouTube.js.');
}

btnDirectVideo?.addEventListener('click', () => withBusy(btnDirectVideo, 'Đang giải mã…', async () => {
  await downloadDirectVideo(directVideoQuality.value);
}).catch(error => setStatus(error.message || String(error), 'error')));

btnDirectAudio?.addEventListener('click', () => withBusy(btnDirectAudio, 'Đang giải mã…', async () => {
  await downloadDirectAudio(directAudioFormat.value);
}).catch(error => setStatus(error.message || String(error), 'error')));

mediaButton.addEventListener('click', async () => {
  mediaButton.disabled = true;
  mediaButton.textContent = 'Đang chuẩn bị…';
  transferProgress.hidden = false;
  transferProgressBar.style.width = '0%';
  try {
    const requestedType = mediaType.value === 'audio' ? 'audio' : 'video';
    let streams = uniqueStreams(pageData.mediaStreams || []);
    const directSelection = selectMediaStreams(streams, mediaQuality.value, requestedType);
    const hasVideo = directSelection.some(stream => stream.hasVideo);
    const hasAudio = directSelection.some(stream => stream.hasAudio);
    const needsFallback = requestedType === 'audio' ? !hasAudio : (!hasVideo || !hasAudio);
    if (needsFallback) {
      streams = uniqueStreams([...streams, ...await getYouTubeJsStreams(pageData.videoId, mediaQuality.value, requestedType)]);
    }
    const selected = selectMediaStreams(streams, mediaQuality.value, requestedType);
    if (!selected.length || !selected.some(stream => stream.hasAudio || stream.hasVideo)) {
      throw new Error(pageData.playabilityReason || 'Không tìm được luồng video/audio có thể tải.');
    }

    const response = await sendRuntimeMessage({
      action: 'start-media-transfer',
      capture: {
        pageUrl: pageData.pageUrl,
        title: pageData.title,
        streams: selected
      }
    });
    if (!response?.ok) throw new Error(response?.error || 'Không thể bắt đầu gửi media.');
    mediaButton.textContent = 'Đang gửi…';
    setStatus(`${requestedType === 'audio' ? 'Audio' : 'Video'} đang được tải bằng kết nối của trình duyệt. Bạn có thể đóng popup.`, 'running');
    startTransferPolling();
  } catch (error) {
    mediaButton.disabled = false;
    mediaButton.textContent = 'Thử lại';
    transferProgress.hidden = true;
    setStatus(error?.message || String(error), 'error');
  }
});

mediaType.addEventListener('change', updateMediaModeUI);

async function initialise() {
  const tab = await getActiveTab();
  if (!tab?.id || !/^https:\/\/(?:www\.|m\.|music\.)?youtube\.com\//i.test(tab.url || '')) {
    throw new Error('Hãy mở một video YouTube trước khi dùng extension.');
  }
  pageData = await executeInMainWorld(tab.id, extractYouTubePageData);
  if (!pageData?.videoId) {
    throw new Error('Không đọc được dữ liệu video. Hãy tải lại tab YouTube rồi thử lại.');
  }

  titleElement.textContent = pageData.title || tab.title || 'YouTube Video';
  channelElement.textContent = pageData.author || pageData.channelId || '';
  const preview = [...pageData.thumbnails].sort((left, right) => right.width * right.height - left.width * left.height)[0]?.url;
  if (preview) {
    thumbElement.src = preview;
    thumbElement.hidden = false;
  }

  if (btnDirectVideo) btnDirectVideo.disabled = false;
  if (btnDirectAudio) btnDirectAudio.disabled = false;
  thumbnailButton.disabled = false;
  metadataTxtButton.disabled = false;
  mediaButton.disabled = false;
  updateMediaModeUI();
  subtitleTrack.innerHTML = '';
  for (const track of pageData.captionTracks) {
    const option = document.createElement('option');
    option.value = track.id;
    option.textContent = `${track.name}${track.isAutoGenerated ? ' (tự động)' : ''}`;
    subtitleTrack.appendChild(option);
  }
  if (pageData.captionTracks.length) {
    subtitleTrack.disabled = false;
    subtitleButton.disabled = false;
    subtitleCount.textContent = `${pageData.captionTracks.length} track có sẵn`;
  } else {
    const option = document.createElement('option');
    option.textContent = 'Video không có phụ đề';
    subtitleTrack.appendChild(option);
    subtitleCount.textContent = 'Không có track';
  }
  setStatus('Sẵn sàng tải asset.', 'success');
  const existingTransfer = await sendRuntimeMessage({ action: 'get-transfer-status' }).catch(() => null);
  if (existingTransfer?.state === 'running') startTransferPolling();
  else renderTransferStatus(existingTransfer);
}

initialise().catch(error => {
  titleElement.textContent = 'Không đọc được video';
  setStatus(error.message || String(error), 'error');
});
