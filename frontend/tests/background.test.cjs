const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('background service worker transfers media in bounded native chunks', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'browser-extension', 'background.js'), 'utf8');
  const runtimeListeners = [];
  const nativeMessages = [];

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      },
      connectNative(host) {
        assert.equal(host, 'com.ytdownloaderpro.browser_bridge');
        const responseListeners = [];
        const disconnectListeners = [];
        return {
          onMessage: { addListener(listener) { responseListeners.push(listener); } },
          onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
          postMessage(message) {
            nativeMessages.push(message);
            const response = { ok: true, captureId: 'capture-test' };
            queueMicrotask(() => responseListeners.forEach(listener => listener(response)));
          },
          disconnect() {
            disconnectListeners.forEach(listener => listener());
          }
        };
      }
    }
  };

  const media = new Uint8Array(600000).fill(7);
  const context = vm.createContext({
    chrome,
    fetch: async () => new Response(media, {
      status: 200,
      headers: { 'content-length': String(media.length) }
    }),
    Response,
    Uint8Array,
    String,
    Math,
    Number,
    Date,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    btoa
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  assert.equal(runtimeListeners.length, 1);

  let startResponse;
  runtimeListeners[0]({
    action: 'start-media-transfer',
    capture: {
      pageUrl: 'https://www.youtube.com/watch?v=oLuhZHUEIKE',
      title: 'Transfer Test',
      streams: [{
        url: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=18',
        itag: 18,
        container: 'mp4',
        hasVideo: true,
        hasAudio: true,
        contentLength: media.length
      }]
    }
  }, null, response => { startResponse = response; });
  assert.equal(startResponse?.ok, true);

  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    runtimeListeners[0]({ action: 'get-transfer-status' }, null, response => { status = response; });
    if (status?.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(status?.state, 'completed');
  assert.equal(status?.percent, 100);
  assert.deepEqual(nativeMessages.map(message => message.action), [
    'transfer-start',
    'transfer-chunk',
    'transfer-chunk',
    'transfer-chunk',
    'transfer-stream-end',
    'transfer-finish'
  ]);
  const chunks = nativeMessages.filter(message => message.action === 'transfer-chunk');
  assert.ok(chunks.every(message => message.data.length < 768 * 1024));
});
