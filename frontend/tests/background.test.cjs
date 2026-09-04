const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('background service worker transfers media in bounded native chunks', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'browser-extension', 'background.js'), 'utf8');
  const runtimeListeners = [];
  const nativeMessages = [];

  let storageState = {};
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const result = {};
          for (const key of keys) {
            if (key in storageState) result[key] = storageState[key];
          }
          return result;
        },
        async set(items) {
          Object.assign(storageState, items);
        },
        async remove(keys) {
          for (const key of (Array.isArray(keys) ? keys : [keys])) {
            delete storageState[key];
          }
        }
      }
    },
    runtime: {
      lastError: null,
      getPlatformInfo(cb) { if (cb) cb({ os: 'win' }); },
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
    setInterval,
    clearInterval,
    queueMicrotask,
    btoa,
    console,
    AbortController
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  assert.equal(runtimeListeners.length, 1);

  let bridgeResponse;
  const bridgeListenerResult = runtimeListeners[0]({ action: 'check-native-bridge' }, null, response => { bridgeResponse = response; });
  assert.equal(bridgeListenerResult, true);
  for (let attempt = 0; attempt < 20 && !bridgeResponse; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(bridgeResponse?.ok, true);
  assert.equal(nativeMessages.shift()?.action, 'ping');

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
      }],
      exportFormat: 'mp3'
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
  assert.equal(nativeMessages[0].exportFormat, 'mp3');
  const chunks = nativeMessages.filter(message => message.action === 'transfer-chunk');
  assert.ok(chunks.every(message => message.data.length < 768 * 1024));
});
