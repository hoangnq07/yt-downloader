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

let pageData = null;

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
    extractedAt: new Date().toISOString()
  };
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

function metadataAsText(data) {
  const titleText = data.title || '';
  const normalizedDescription = data.description || '';
  const hashtags = [...new Set(`${titleText}\n${normalizedDescription}`.match(/#[\p{L}\p{N}_-]+/gu) || [])];
  const keywords = [...new Set((data.keywords || []).map(value => String(value).trim()).filter(Boolean))];
  const chapters = normalizedDescription.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^(?:\d{1,2}:)?\d{1,2}:\d{2}\s+\S/.test(line));
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

  thumbnailButton.disabled = false;
  metadataTxtButton.disabled = false;
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
}

initialise().catch(error => {
  titleElement.textContent = 'Không đọc được video';
  setStatus(error.message || String(error), 'error');
});
