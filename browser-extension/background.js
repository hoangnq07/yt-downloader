const NATIVE_HOST = 'com.ytdownloaderpro.browser_bridge';
const MEDIA_CHUNK_BYTES = 256 * 1024;
const CHUNK_FETCH_SIZE = 2 * 1024 * 1024;

// Runs in the source tab, including after the popup has closed. Only return
// URLs for the active video; never switch media representations while resuming.
async function readPlaybackURLs(videoId, refresh) {
  const player = document.getElementById('movie_player');
  const current = player?.getPlayerResponse?.();
  if (current?.videoDetails?.videoId !== videoId) return [];
  const formats = data => [...(data?.streamingData?.formats || []), ...(data?.streamingData?.adaptiveFormats || [])];
  const observed = performance.getEntriesByType('resource').map(entry => entry.name).reverse();
  let fresh = [];
  if (refresh) {
    const context = window.ytcfg?.get('INNERTUBE_CONTEXT');
    if (context) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/youtubei/v1/player', {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ context, videoId })
        });
        if (response.ok) {
          const data = await response.json();
          if (data?.videoDetails?.videoId === videoId) fresh = formats(data);
        }
      } catch (_) {
        // The current player may still have a usable authenticated media URL.
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  return [...observed, ...fresh.map(f => f.url), ...formats(current).map(f => f.url)]
    .filter(value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com') &&
          url.pathname === '/videoplayback' && url.searchParams.has('itag');
      } catch (_) { return false; }
    });
}

function compatiblePlaybackURL(original, candidate, contentLength) {
  const left = new URL(original);
  const right = new URL(candidate);
  if (right.protocol !== 'https:' || !right.hostname.endsWith('.googlevideo.com') || right.pathname !== '/videoplayback') return false;
  // itag alone does not identify a file (different videos/audio tracks can share it).
  for (const key of ['id', 'itag', 'lmt']) {
    if (!left.searchParams.get(key) || left.searchParams.get(key) !== right.searchParams.get(key)) return false;
  }
  if (left.searchParams.get('xtags') !== right.searchParams.get('xtags')) return false;
  const expected = Number(contentLength) || Number(left.searchParams.get('clen'));
  return expected > 0 && (!right.searchParams.has('clen') || Number(right.searchParams.get('clen')) === expected);
}

async function refreshPlaybackURL(capture, stream, refresh = true) {
  if (!Number.isInteger(capture.tabId) || !chrome.scripting?.executeScript) return false;
  try {
    const videoId = new URL(capture.pageUrl).searchParams.get('v');
    if (!videoId) return false;
    const results = await chrome.scripting.executeScript({
      target: { tabId: capture.tabId }, world: 'MAIN',
      func: readPlaybackURLs, args: [videoId, refresh]
    });
    for (const candidate of results?.[0]?.result || []) {
      if (!compatiblePlaybackURL(stream.url, candidate, stream.contentLength)) continue;
      const url = new URL(candidate);
      for (const key of ['range', 'rn', 'rbuf']) url.searchParams.delete(key);
      if (url.href === stream.url || stream.failedPlaybackURLs?.has(url.href)) continue;
      stream.url = url.href;
      return true;
    }
  } catch (_) {}
  return false;
}

function mediaRequestURL(streamURL, offset, end, useRangeHeader) {
  const url = new URL(streamURL);
  url.searchParams.delete('range');
  if (!useRangeHeader) url.searchParams.set('range', `${offset}-${end}`);
  // Preserve the playback nonce/token supplied by the player. Inventing a new
  // cpn detaches the request from that playback session.
  return url.href;
}

function retryDelay(milliseconds, signal) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

function positiveMediaLength(value) {
  const length = Number(value);
  return Number.isSafeInteger(length) && length > 0 ? length : 0;
}

async function discoverMediaLength(stream, signal) {
  const known = positiveMediaLength(stream.contentLength) || positiveMediaLength(new URL(stream.url).searchParams.get('clen'));
  if (known) return known;
  // Progressive ANDROID streams (itag 18) omit clen/contentLength. Asking for
  // the full resource size avoids a range request beyond EOF, which returns 400.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 10000);
  try {
    const url = mediaRequestURL(stream.url, 0, 0, true);
    for (const options of [{ method: 'HEAD' }, { method: 'GET', headers: { Range: 'bytes=0-0' } }]) {
      if (controller.signal.aborted) return 0;
      try {
        const response = await fetch(url, { ...options, cache: 'no-store', credentials: 'omit', signal: controller.signal });
        const range = response.headers.get('content-range') || '';
        const mime = response.headers.get('content-type') || '';
        const total = response.status === 206 && /^bytes 0-0\/\d+$/.test(range)
          ? positiveMediaLength(range.split('/')[1])
          : response.status === 200 && !range && /^(video\/|audio\/|application\/octet-stream)/i.test(mime)
            ? positiveMediaLength(response.headers.get('content-length')) : 0;
        await response.body?.cancel();
        if (total) return total;
      } catch (_) {}
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
  return 0;
}

async function fetchMediaRange(capture, stream, offset, end, signal) {
  let useRangeHeader = Boolean(stream.useRangeHeader);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) throw new Error('Đã hủy tải.');
    let response;
    try {
      response = await fetch(mediaRequestURL(stream.url, offset, end, useRangeHeader), {
        method: 'GET', cache: 'no-store', credentials: 'omit', signal,
        headers: useRangeHeader ? { accept: '*/*', Range: `bytes=${offset}-${end}` } : { accept: '*/*' }
      });
    } catch (error) {
      lastError = error;
      await retryDelay(1000 * (attempt + 1), signal);
      continue;
    }
    const range = response.headers.get('content-range') || '';
    const totalMatch = range.match(/\/(\d+)$/);
    let total = totalMatch ? Number(totalMatch[1]) : positiveMediaLength(stream.contentLength);
    if (response.status === 416) {
      await response.body?.cancel();
      if (offset > 0 && total === offset && (!stream.contentLength || Number(stream.contentLength) === offset)) {
        return { bytes: new Uint8Array(), total, eof: true };
      }
      throw new Error(`YouTube trả về cuối luồng trước khi tải đủ dữ liệu (vị trí ${offset}, tổng ${total}).`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      lastError = new Error(`Không thể tải luồng ${stream.hasVideo ? 'Video' : 'Audio'} itag ${stream.itag || '?'} (HTTP ${response.status}) tại vị trí ${(offset / (1024 * 1024)).toFixed(1)}MB.`);
      if (![403, 429].includes(response.status) && response.status < 500) throw lastError;
      if (response.status === 403) {
        if (!useRangeHeader) {
          useRangeHeader = true;
        } else if (attempt < 4) {
          stream.failedPlaybackURLs ||= new Set();
          stream.failedPlaybackURLs.add(mediaRequestURL(stream.url, 0, 0, true));
          const refreshed = await refreshPlaybackURL(capture, stream);
          if (refreshed) {
            appendBridgeLog('info', `Đã lấy lại URL itag ${stream.itag}; tiếp tục tại ${(offset / (1024 * 1024)).toFixed(1)}MB`);
            useRangeHeader = false;
          }
        }
      }
      if (attempt < 4) await retryDelay(1000 * (attempt + 1), signal);
      continue;
    }
    const match = range.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
    if ((range && !match) || (match && (Number(match[1]) !== offset || Number(match[2]) > end || Number(match[2]) < offset)) ||
        (useRangeHeader && offset > 0 && !match) ||
        (total > 0 && stream.contentLength > 0 && total !== Number(stream.contentLength))) {
      await response.body?.cancel();
      throw new Error('Máy chủ trả về sai khoảng byte hoặc kích thước luồng; đã dừng để tránh ghép file hỏng.');
    }
    // Bound memory even if a server ignores the requested range and returns the whole file.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Luồng media không có dữ liệu.');
    const buffer = new Uint8Array(end - offset + 1);
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.length > buffer.length) {
          await reader.cancel();
          throw new Error('Máy chủ bỏ qua giới hạn byte của yêu cầu tải.');
        }
        buffer.set(value, length);
        length += value.length;
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      lastError = error;
      if (attempt < 4) await retryDelay(1000 * (attempt + 1), signal);
      continue;
    } finally {
      reader.releaseLock();
    }
    const declaredLength = positiveMediaLength(response.headers.get('content-length'));
    if (!length || (match && length !== Number(match[2]) - offset + 1) || (declaredLength && declaredLength !== length)) {
      lastError = new Error('Luồng media bị ngắt trước khi nhận đủ khoảng byte yêu cầu.');
      if (attempt < 4) await retryDelay(1000 * (attempt + 1), signal);
      continue;
    }
    // A complete, explicitly sized short response is the final query-range
    // chunk when the server supplies no total size. Never infer EOF for a
    // known-size stream or a body that ended before its Content-Length.
    if (!total && !range && !useRangeHeader && response.status === 200 && length < buffer.length &&
        positiveMediaLength(response.headers.get('content-length')) === length &&
        /^(video\/|audio\/|application\/octet-stream)/i.test(response.headers.get('content-type') || '')) {
      total = offset + length;
    }
    stream.useRangeHeader = useRangeHeader;
    return { bytes: buffer.subarray(0, length), total, eof: false };
  }
  throw lastError || new Error('Không thể tải luồng media.');
}

let transferStatus = {
  state: 'idle',
  message: '',
  percent: 0,
  captureId: ''
};

let keepAliveTimer = null;
let currentAbortController = null;
let currentBridge = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  if (typeof setInterval !== 'function') return;
  keepAliveTimer = setInterval(() => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
        chrome.runtime.getPlatformInfo(() => {});
      }
    } catch (_) {}
  }, 15000);
}

function stopKeepAlive() {
  if (keepAliveTimer && typeof clearInterval === 'function') {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function appendBridgeLog(level, message, data = null) {
  const timestamp = new Date().toISOString();
  if (typeof console !== 'undefined' && typeof console.log === 'function') {
    console.log(`[Bridge ${level.toUpperCase()}] ${message}`, data || '');
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(['bridgeLogs']);
      const logs = Array.isArray(res?.bridgeLogs) ? res.bridgeLogs : [];
      logs.push({ timestamp, level, message, data });
      if (logs.length > 200) {
        logs.splice(0, logs.length - 200);
      }
      await chrome.storage.local.set({ bridgeLogs: logs });
    }
  } catch (err) {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('Không thể lưu bridge log vào storage:', err);
    }
  }
}

// Giữ service worker sống khi popup mở port keepalive
if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect?.addListener) {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name === 'popup-keepalive') {
      port.onDisconnect.addListener(() => {});
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'get-transfer-status') {
    sendResponse(transferStatus);
    return;
  }
  if (message?.action === 'get-bridge-logs') {
    chrome.storage.local.get(['bridgeLogs']).then(res => sendResponse({ logs: res.bridgeLogs || [] }));
    return true;
  }
  if (message?.action === 'clear-bridge-logs') {
    chrome.storage.local.remove(['bridgeLogs']).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === 'check-native-bridge') {
    void checkNativeBridge()
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: friendlyNativeError(error) }));
    return true;
  }
  if (message?.action === 'abort-media-transfer') {
    appendBridgeLog('info', 'Nhận yêu cầu hủy tải từ người dùng');
    if (currentAbortController) {
      currentAbortController.abort();
    }
    const capId = transferStatus.captureId;
    if (capId && currentBridge) {
      try {
        currentBridge.send({
          action: 'transfer-abort',
          captureId: capId,
          data: 'Người dùng bấm hủy tải'
        }).catch(() => {});
      } catch (_) {}
    }
    transferStatus = {
      state: 'idle',
      message: 'Đã hủy tải video.',
      percent: 0,
      captureId: ''
    };
    if (currentBridge) {
      currentBridge.disconnect();
      currentBridge = null;
    }
    stopKeepAlive();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.action === 'start-native-download') {
    if (transferStatus.state === 'running' && currentAbortController && !currentAbortController.signal.aborted) {
      sendResponse({ ok: false, error: 'Đang có một video khác đang được tải.' });
      return true;
    }
    const { pageUrl, title, quality, exportFormat } = message;
    if (!pageUrl) {
      sendResponse({ ok: false, error: 'URL video không hợp lệ.' });
      return true;
    }
    transferStatus = { state: 'running', message: 'Đang chuẩn bị tải chất lượng cao…', percent: 1, captureId: '' };
    sendResponse({ ok: true });
    void runNativeDownloadFlow({ pageUrl, title, quality, exportFormat });
    return true;
  }
  if (message?.action !== 'start-media-transfer') return;

  if (transferStatus.state === 'running' && currentAbortController && !currentAbortController.signal.aborted) {
    sendResponse({ ok: false, error: 'Đang có một video khác được gửi sang app.' });
    return;
  }
  if (!message.capture?.pageUrl || !Array.isArray(message.capture?.streams) || !message.capture.streams.length) {
    sendResponse({ ok: false, error: 'Dữ liệu media không hợp lệ.' });
    return;
  }

  transferStatus = { state: 'running', message: 'Đang kết nối ứng dụng…', percent: 0, captureId: '' };
  sendResponse({ ok: true });
  void transferMedia(message.capture);
});

async function runNativeDownloadFlow({ pageUrl, title, quality, exportFormat = 'mp4' }) {
  startKeepAlive();
  const abortController = typeof AbortController !== 'undefined' ? new AbortController() : { signal: { aborted: false } };
  const abortSignal = abortController.signal;
  currentAbortController = abortController;

  let bridge = null;
  try {
    bridge = openNativeBridge();
    currentBridge = bridge;

    appendBridgeLog('info', `Bắt đầu tải video chất lượng cao ${quality}p`, { pageUrl, title, quality, exportFormat });

    const started = await bridge.send({
      action: 'start-native-download',
      pageUrl,
      title,
      quality: String(quality || '1080'),
      exportFormat
    });
    if (!started?.ok) {
      throw new Error(started?.error || 'Không thể khởi động tải xuống.');
    }
    const captureId = started.captureId;
    transferStatus = {
      state: 'running',
      percent: 1,
      message: `Đang kết nối YouTube tải ${quality}p…`,
      captureId
    };
    appendBridgeLog('info', `Đã khởi tạo task tải video (ID: ${captureId})`);

    // Poll Native Host for live progress
    let idleCount = 0;
    while (!abortSignal.aborted) {
      await new Promise(r => setTimeout(r, 600));
      if (abortSignal.aborted) break;

        const task = await bridge.send({ action: 'get-task-status', captureId });
        if (!task?.ok) continue;

        if (task.status === 'running') {
          idleCount = 0;
          const pct = Math.max(1, Math.min(99, Number(task.percent) || 1));
          transferStatus.percent = pct;
          const spd = task.speed ? ` • ${task.speed}` : '';
          const eta = task.eta ? ` • ${task.eta}` : '';
          transferStatus.message = `Đang tải ${quality}p: ${pct.toFixed(0)}%${spd}${eta}`;
        } else if (task.status === 'completed') {
          transferStatus = {
            state: 'completed',
            percent: 100,
            message: task.filePath ? `Đã lưu Video: ${task.filePath}` : 'Tải video hoàn tất thành công.',
            captureId
          };
          appendBridgeLog('info', 'Hoàn tất tải video thành công', { filePath: task.filePath });
          break;
        } else if (task.status === 'error') {
          throw new Error(task.error || 'Lỗi khi tải video');
        } else if (task.status === 'cancelled') {
          appendBridgeLog('info', 'Tiến trình đã bị hủy');
          transferStatus = { state: 'idle', percent: 0, message: 'Đã hủy tải video.', captureId: '' };
          break;
        } else if (task.status === 'idle') {
          idleCount++;
          if (idleCount > 10) {
            throw new Error('App không còn tìm thấy tác vụ tải. Hãy mở lại app rồi thử lại.');
          }
        }
    }
  } catch (error) {
    if (abortSignal.aborted) return;
    const errorMsg = error?.message || String(error);
    appendBridgeLog('error', 'Lỗi khi tải video: ' + errorMsg);
    transferStatus = {
      state: 'error',
      message: friendlyNativeError(error),
      percent: 0,
      captureId: ''
    };
  } finally {
    if (currentAbortController === abortController) {
      currentAbortController = null;
    }
    if (currentBridge === bridge) {
      currentBridge = null;
    }
    if (bridge) {
      bridge.disconnect();
    }
    // Giữ service worker sống thêm 5 giây sau khi hoàn tất để popup
    // kịp nhận trạng thái cuối trước khi Chrome suspend worker.
    setTimeout(stopKeepAlive, 5000);
  }
}

function openNativeBridge(options = {}) {
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  const pending = [];
  let disconnectedError = null;

  port.onMessage.addListener(response => {
    const item = pending.shift();
    if (!item) return;
    if (!response?.ok) item.reject(new Error(response?.error || 'Native host từ chối yêu cầu.'));
    else item.resolve(response);
  });
  port.onDisconnect.addListener(() => {
    const lastErrMsg = chrome.runtime.lastError?.message || 'Mất kết nối với YT Downloader Pro.';
    disconnectedError = new Error(lastErrMsg);
    appendBridgeLog('warn', 'Native bridge port đã ngắt kết nối', { error: lastErrMsg });
    while (pending.length) pending.shift().reject(disconnectedError);
    if (typeof options.onDisconnect === 'function') {
      options.onDisconnect(disconnectedError);
    }
  });

  return {
    send(message) {
      if (disconnectedError) return Promise.reject(disconnectedError);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        try {
          port.postMessage(message);
        } catch (error) {
          pending.pop();
          reject(error);
        }
      });
    },
    disconnect() {
      try { port.disconnect(); } catch (_) {}
    }
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function friendlyNativeError(error) {
  const rawMessage = error?.message || String(error);
  return /native messaging host|host.*not found|not permitted/i.test(rawMessage)
    ? 'Chưa kết nối được app. Hãy mở YT Downloader Pro một lần để app đăng ký Bridge, sau đó Reload extension.'
    : rawMessage;
}

async function checkNativeBridge() {
  const bridge = openNativeBridge();
  try {
    await bridge.send({ action: 'ping' });
  } finally {
    bridge.disconnect();
  }
}

async function transferMedia(capture) {
  startKeepAlive();
  const bridge = openNativeBridge();
  currentBridge = bridge;
  const abortController = new AbortController();
  currentAbortController = abortController;
  const abortSignal = abortController.signal;

  let captureId = '';
  const streamStats = capture.streams.map(s => ({
    received: 0,
    total: Math.max(0, Number(s.contentLength) || 0)
  }));

  const updateProgress = () => {
    const receivedTotal = streamStats.reduce((sum, s) => sum + s.received, 0);
    let expectedTotal = streamStats.reduce((sum, s) => sum + s.total, 0);
    if (expectedTotal === 0) {
      expectedTotal = capture.streams.reduce((sum, s) => sum + Math.max(0, Number(s.contentLength) || 0), 0);
    }
    const percentNum = expectedTotal > 0 ? Math.min(98, Math.round(receivedTotal / expectedTotal * 100)) : 0;
    const receivedMB = (receivedTotal / (1024 * 1024)).toFixed(1);
    const expectedMB = expectedTotal > 0 ? (expectedTotal / (1024 * 1024)).toFixed(1) : '?';
    transferStatus.percent = percentNum;
    transferStatus.message = `Đang tải song song ${capture.streams.length} luồng: ${receivedMB}MB${expectedTotal > 0 ? ' / ' + expectedMB + 'MB' : ''} (${percentNum}%)`;
  };

  appendBridgeLog('info', 'Bắt đầu gửi media sang app (tải song song đa luồng)', {
    pageUrl: capture.pageUrl,
    title: capture.title,
    exportFormat: capture.exportFormat || 'mp4',
    streamsCount: capture.streams.length
  });

  try {
    for (const [index, stream] of capture.streams.entries()) {
      await refreshPlaybackURL(capture, stream, false);
      stream.contentLength = await discoverMediaLength(stream, abortSignal);
      streamStats[index].total = stream.contentLength;
    }
    if (abortSignal.aborted) return;
    const started = await bridge.send({
      action: 'transfer-start',
      pageUrl: capture.pageUrl,
      title: capture.title,
      capturedAt: new Date().toISOString(),
      streams: capture.streams,
      exportFormat: capture.exportFormat || 'mp4'
    });
    captureId = started.captureId;
    transferStatus.captureId = captureId;
    appendBridgeLog('info', `Khởi tạo transfer thành công trên app (ID: ${captureId})`);

    if (started.resolvedUrls && typeof started.resolvedUrls === 'object') {
      capture.streams.forEach((stream, idx) => {
        const resolved = started.resolvedUrls[String(idx)] || started.resolvedUrls[idx];
        if (resolved) {
          const streamLabel = stream.hasVideo ? 'Video' : 'Audio';
          appendBridgeLog('info', `Cập nhật URL luồng ${idx + 1} [${streamLabel}] sang URL xác thực không giới hạn (itag: ${stream.itag || '?'})`);
          stream.url = resolved;
        }
      });
    }

    // Tải song song tất cả các luồng (Video + Audio) đồng thời
    await Promise.all(capture.streams.map(async (stream, streamIndex) => {
      const streamLabel = stream.hasVideo ? 'Video' : 'Audio';
      let streamReceived = 0;
      let streamTotal = Math.max(0, Number(stream.contentLength) || 0);

      appendBridgeLog('info', `Bắt đầu tải luồng ${streamIndex + 1}/${capture.streams.length} [${streamLabel}] (itag: ${stream.itag || '?'}, size: ${streamTotal ? (streamTotal / (1024 * 1024)).toFixed(1) + 'MB' : 'chưa rõ'})`);

      let offset = 0;
      while (!abortSignal?.aborted) {
        let rangeEnd = offset + CHUNK_FETCH_SIZE - 1;
        if (streamTotal > 0 && rangeEnd >= streamTotal) {
          rangeEnd = streamTotal - 1;
        }

        const chunk = await fetchMediaRange(capture, stream, offset, rangeEnd, abortSignal);
        if (abortSignal.aborted) return;
        if (chunk.total > 0) {
          streamTotal = chunk.total;
          stream.contentLength = streamTotal;
          streamStats[streamIndex].total = streamTotal;
        }
        if (chunk.eof) break;
        const chunkBytes = chunk.bytes;

        // Gửi sang native bridge theo từng slice nhỏ (256KB)
        for (let sliceOffset = 0; sliceOffset < chunkBytes.length; sliceOffset += MEDIA_CHUNK_BYTES) {
          if (abortSignal?.aborted) return;
          const slice = chunkBytes.subarray(sliceOffset, Math.min(sliceOffset + MEDIA_CHUNK_BYTES, chunkBytes.length));
          await bridge.send({
            action: 'transfer-chunk',
            captureId,
            streamIndex,
            data: bytesToBase64(slice)
          });
          if (abortSignal.aborted) return;
          streamStats[streamIndex].received += slice.length;
          streamReceived += slice.length;
          updateProgress();
        }

        offset += chunkBytes.length;

        if (streamTotal > 0 && offset >= streamTotal) {
          break;
        }
      }

      if (abortSignal?.aborted) return;

      if (streamTotal > 0 && streamReceived !== streamTotal) {
        throw new Error(`Luồng ${streamLabel} chưa đủ dữ liệu: ${streamReceived}/${streamTotal} bytes.`);
      }
      await bridge.send({ action: 'transfer-stream-end', captureId, streamIndex });
      appendBridgeLog('info', `Đã tải xong luồng ${streamIndex + 1}/${capture.streams.length} [${streamLabel}] (${(streamReceived / (1024 * 1024)).toFixed(1)}MB)`);
    }));

    if (abortSignal?.aborted) {
      appendBridgeLog('info', 'Tiến trình tải đã bị hủy bởi người dùng');
      return;
    }

    transferStatus.message = 'App đang ghép video bằng FFmpeg…';
    transferStatus.percent = 99;
    appendBridgeLog('info', 'Đã tải xong tất cả luồng song song, yêu cầu App ghép Video...');

    const finished = await bridge.send({ action: 'transfer-finish', captureId });
    appendBridgeLog('info', 'Hoàn tất ghép video thành công', { filePath: finished.filePath });

    transferStatus = {
      state: 'completed',
      message: finished.filePath
        ? `Đã lưu Video: ${finished.filePath}`
        : 'Đã hoàn tất ghép video thành công.',
      percent: 100,
      captureId
    };
  } catch (error) {
    if (abortSignal?.aborted) {
      appendBridgeLog('info', 'Tiến trình tải đã dừng do lệnh hủy');
      return;
    }
    abortController.abort(); // Stop sibling streams before closing the native transfer.
    const errorMsg = error?.message || String(error);
    appendBridgeLog('error', 'Lỗi trong quá trình gửi media: ' + errorMsg);
    if (captureId) {
      try { await bridge.send({ action: 'transfer-abort', captureId, data: errorMsg }); } catch (_) {}
    }
    transferStatus = {
      state: 'error',
      message: friendlyNativeError(error),
      percent: 0,
      captureId: ''
    };
  } finally {
    if (currentAbortController === abortController) currentAbortController = null;
    if (currentBridge === bridge) {
      currentBridge = null;
      stopKeepAlive();
    }
    bridge.disconnect();
  }
}
