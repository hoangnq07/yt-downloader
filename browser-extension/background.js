const NATIVE_HOST = 'com.ytdownloaderpro.browser_bridge';
const MEDIA_CHUNK_BYTES = 256 * 1024;

let transferStatus = {
  state: 'idle',
  message: '',
  percent: 0,
  captureId: ''
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'get-transfer-status') {
    sendResponse(transferStatus);
    return;
  }
  if (message?.action !== 'start-media-transfer') return;

  if (transferStatus.state === 'running') {
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

function openNativeBridge() {
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
    disconnectedError = new Error(chrome.runtime.lastError?.message || 'Mất kết nối với YT Downloader Pro.');
    while (pending.length) pending.shift().reject(disconnectedError);
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

async function transferMedia(capture) {
  const bridge = openNativeBridge();
  let captureId = '';
  let receivedTotal = 0;
  const expectedTotal = capture.streams.reduce((sum, stream) => sum + Math.max(0, Number(stream.contentLength) || 0), 0);

  try {
    const started = await bridge.send({
      action: 'transfer-start',
      pageUrl: capture.pageUrl,
      title: capture.title,
      capturedAt: new Date().toISOString(),
      streams: capture.streams
    });
    captureId = started.captureId;
    transferStatus.captureId = captureId;

    for (let streamIndex = 0; streamIndex < capture.streams.length; streamIndex += 1) {
      const stream = capture.streams[streamIndex];
      transferStatus.message = `Đang tải luồng ${streamIndex + 1}/${capture.streams.length} qua trình duyệt…`;
      const response = await fetch(stream.url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit'
      });
      if (!response.ok || !response.body) {
        throw new Error(`Không thể tải luồng itag ${stream.itag || '?'} (HTTP ${response.status}).`);
      }

      const reader = response.body.getReader();
      let buffered = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;

        const combined = new Uint8Array(buffered.length + value.length);
        combined.set(buffered);
        combined.set(value, buffered.length);
        let offset = 0;
        while (combined.length - offset >= MEDIA_CHUNK_BYTES) {
          const chunk = combined.subarray(offset, offset + MEDIA_CHUNK_BYTES);
          await bridge.send({
            action: 'transfer-chunk',
            captureId,
            streamIndex,
            data: bytesToBase64(chunk)
          });
          receivedTotal += chunk.length;
          transferStatus.percent = expectedTotal > 0 ? Math.min(99, receivedTotal / expectedTotal * 100) : 0;
          offset += MEDIA_CHUNK_BYTES;
        }
        buffered = combined.slice(offset);
      }
      if (buffered.length) {
        await bridge.send({
          action: 'transfer-chunk',
          captureId,
          streamIndex,
          data: bytesToBase64(buffered)
        });
        receivedTotal += buffered.length;
      }
      await bridge.send({ action: 'transfer-stream-end', captureId, streamIndex });
    }

    await bridge.send({ action: 'transfer-finish', captureId });
    transferStatus = {
      state: 'completed',
      message: 'Đã gửi media sang app. Quay lại app và bấm Nhận media.',
      percent: 100,
      captureId
    };
  } catch (error) {
    if (captureId) {
      try { await bridge.send({ action: 'transfer-abort', captureId }); } catch (_) {}
    }
    const rawMessage = error?.message || String(error);
    const friendlyMessage = /native messaging host|host.*not found|not permitted|forbidden/i.test(rawMessage)
      ? 'Chưa kết nối được app. Mở app → Cài đặt → Chuẩn bị Bridge Extension, sau đó Reload extension.'
      : rawMessage;
    transferStatus = {
      state: 'error',
      message: friendlyMessage,
      percent: 0,
      captureId: ''
    };
  } finally {
    bridge.disconnect();
  }
}
