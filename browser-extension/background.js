const NATIVE_HOST = 'com.ytdownloaderpro.browser_bridge';
const MEDIA_CHUNK_BYTES = 256 * 1024;

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

      try {
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
            appendBridgeLog('warn', 'Task status idle quá lâu');
            break;
          }
        }
      } catch (pollErr) {
        if (abortSignal.aborted) break;
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
    stopKeepAlive();
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
  currentAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const abortSignal = currentAbortController ? currentAbortController.signal : null;

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
      const CHUNK_FETCH_SIZE = 2 * 1024 * 1024; // 2MB range chunk giúp giảm số lượng request và tránh rate-limit HTTP 403
      const cpn = Array.from({ length: 16 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(Math.random() * 64)]).join('');

      while (!abortSignal?.aborted) {
        let rangeEnd = offset + CHUNK_FETCH_SIZE - 1;
        if (streamTotal > 0 && rangeEnd >= streamTotal) {
          rangeEnd = streamTotal - 1;
        }

        let chunkUrl = stream.url;
        if (!chunkUrl.includes('cpn=')) {
          chunkUrl += (chunkUrl.includes('?') ? '&' : '?') + `cpn=${cpn}`;
        }
        if (/[?&]range=\d+-\d*/.test(chunkUrl)) {
          chunkUrl = chunkUrl.replace(/([?&]range=)\d+-\d*/, `$1${offset}-${rangeEnd}`);
        } else {
          chunkUrl += (chunkUrl.includes('?') ? '&' : '?') + `range=${offset}-${rangeEnd}`;
        }

        const fetchOpts = {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          headers: {
            'accept': '*/*',
            'origin': 'https://www.youtube.com',
            'referer': 'https://www.youtube.com/',
            'DNT': '1'
          }
        };
        if (abortSignal) fetchOpts.signal = abortSignal;

        let response = null;
        let lastStatus = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (abortSignal?.aborted) break;
          try {
            response = await fetch(chunkUrl, fetchOpts);
            lastStatus = response.status;
            if (response.status === 416 || response.ok) {
              break;
            }
            if (attempt < 2 && (response.status === 403 || response.status === 429 || response.status >= 500)) {
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
          } catch (fetchErr) {
            if (abortSignal?.aborted) break;
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            } else {
              throw fetchErr;
            }
          }
        }

        if (abortSignal?.aborted) return;
        if (!response) {
          throw new Error(`Không thể kết nối đến máy chủ YouTube cho luồng ${streamLabel}.`);
        }
        if (response.status === 416) {
          // Range reached end of stream
          break;
        }

        if (!response.ok) {
          throw new Error(`Không thể tải luồng ${streamLabel} itag ${stream.itag || '?'} (HTTP ${lastStatus || response.status}) tại vị trí ${(offset / (1024 * 1024)).toFixed(1)}MB.`);
        }

        if (!streamTotal) {
          const cr = response.headers.get('content-range') || '';
          const match = cr.match(/\/(\d+)$/);
          if (match) {
            streamTotal = Number(match[1]);
            streamStats[streamIndex].total = streamTotal;
          }
        }

        const arrayBuffer = await response.arrayBuffer();
        const chunkBytes = new Uint8Array(arrayBuffer);
        if (chunkBytes.length === 0) {
          break;
        }

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
          streamStats[streamIndex].received += slice.length;
          streamReceived += slice.length;
          updateProgress();
        }

        offset += chunkBytes.length;

        if (streamTotal > 0 && offset >= streamTotal) {
          break;
        }
        if (chunkBytes.length < (rangeEnd - (offset - chunkBytes.length) + 1)) {
          break;
        }
      }

      if (abortSignal?.aborted) return;

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
    currentAbortController = null;
    if (currentBridge === bridge) {
      currentBridge = null;
    }
    bridge.disconnect();
    stopKeepAlive();
  }
}
