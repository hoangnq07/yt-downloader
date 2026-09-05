const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createWorker(fetch, scripting, nativeReply = () => ({})) {
  const messages = [];
  const context = vm.createContext({
    URL, Response, Uint8Array, AbortController, btoa, fetch,
    setTimeout: callback => setTimeout(callback, 0), clearTimeout,
    console: { log() {}, warn() {} },
    chrome: {
      scripting,
      runtime: {
        onMessage: { addListener() {} },
        connectNative() {
          let respond;
          return {
            onMessage: { addListener(fn) { respond = fn; } },
            onDisconnect: { addListener() {} },
            postMessage(message) {
              messages.push(message.action === 'transfer-chunk'
                ? { ...message, data: undefined, bytes: Buffer.from(message.data, 'base64') }
                : message);
              queueMicrotask(() => respond({ ok: true, captureId: 'capture-test', ...nativeReply(message) }));
            },
            disconnect() {}
          };
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../browser-extension/background.js'), 'utf8'), context);
  return { context, messages };
}

const MB = 1024 * 1024;
const mediaURL = total => `https://test.googlevideo.com/videoplayback?id=video&itag=401&lmt=123&clen=${total}&cpn=player-session&pot=old`;
const streamFor = total => ({ url: mediaURL(total), itag: 401, hasVideo: true, contentLength: total });

test('high-quality native flow preserves quality and reports the saved video', async () => {
  const { context, messages } = createWorker(() => { throw new Error('Must use native download'); }, undefined,
    message => message.action === 'get-task-status' ? { status: 'completed', filePath: 'D:/Downloads/video.mp4' } : {});
  await context.runNativeDownloadFlow({ pageUrl: 'https://www.youtube.com/watch?v=Id4mjy6viLA', quality: '2160', exportFormat: 'mp4' });
  assert.equal(messages[0].action, 'start-native-download');
  assert.equal(messages[0].quality, '2160');
  assert.equal(messages[0].exportFormat, 'mp4');
  assert.equal(vm.runInContext('transferStatus.state', context), 'completed');
  assert.match(vm.runInContext('transferStatus.message', context), /video\.mp4/);
});

test('native download error exits polling instead of leaving progress stuck forever', async () => {
  const { context, messages } = createWorker(undefined, undefined,
    message => message.action === 'get-task-status' ? { status: 'error', error: 'HTTP 403 from media server' } : {});
  await context.runNativeDownloadFlow({ pageUrl: 'https://www.youtube.com/watch?v=Id4mjy6viLA', quality: '2160' });
  assert.equal(messages.filter(m => m.action === 'get-task-status').length, 1);
  assert.equal(vm.runInContext('transferStatus.state', context), 'error');
  assert.match(vm.runInContext('transferStatus.message', context), /HTTP 403/);
});

test('itag 18 without a declared total stops at the real 6072278-byte EOF, before HTTP 400', async () => {
  const total = 6072278; // Observed from Id4mjy6viLA ANDROID itag 18.
  const requests = [];
  const { context, messages } = createWorker(async (input, options) => {
    const url = new URL(input);
    requests.push({ method: options.method, range: url.searchParams.get('range') });
    if (options.method === 'HEAD') {
      assert.equal(url.searchParams.get('range'), null);
      return new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': String(total) } });
    }
    const [start, end] = url.searchParams.get('range').split('-').map(Number);
    if (start >= total) return new Response(null, { status: 400 });
    const length = Math.min(end + 1, total) - start;
    return new Response(new Uint8Array(length), { headers: { 'content-type': 'video/mp4', 'content-length': String(length) } });
  });
  await context.transferMedia({ pageUrl: 'https://www.youtube.com/watch?v=Id4mjy6viLA', streams: [{
    url: 'https://test.googlevideo.com/videoplayback?itag=18', itag: 18, hasAudio: true, contentLength: 0
  }] });
  assert.equal(vm.runInContext('transferStatus.state', context), 'completed');
  assert.deepEqual(requests, [
    { method: 'HEAD', range: null },
    { method: 'GET', range: '0-2097151' },
    { method: 'GET', range: '2097152-4194303' },
    { method: 'GET', range: '4194304-6072277' }
  ]);
  assert.equal(messages[0].streams[0].contentLength, total);
  assert.equal(messages.filter(m => m.action === 'transfer-chunk').reduce((sum, m) => sum + m.bytes.length, 0), total);
  assert.equal(messages.at(-1).action, 'transfer-finish');
});

test('unknown size falls back to a one-byte HTTP Range probe when HEAD is unavailable', async () => {
  const calls = [];
  const { context } = createWorker(async (url, options) => {
    calls.push(options.method);
    if (options.method === 'HEAD') return new Response(null, { status: 405 });
    assert.equal(options.headers.Range, 'bytes=0-0');
    return new Response(new Uint8Array(1), { status: 206, headers: { 'content-length': '1', 'content-range': 'bytes 0-0/6072278' } });
  });
  assert.equal(await context.discoverMediaLength({ url: 'https://test.googlevideo.com/videoplayback?itag=18' }, new AbortController().signal), 6072278);
  assert.deepEqual(calls, ['HEAD', 'GET']);
});

test('unknown-size final short media response establishes EOF only after its full body is read', async () => {
  const { context } = createWorker(async () => new Response(new Uint8Array(7), { headers: { 'content-length': '7', 'content-type': 'video/mp4' } }));
  const result = await context.fetchMediaRange({}, { url: 'https://test.googlevideo.com/videoplayback?itag=18' }, 100, 199, new AbortController().signal);
  assert.equal(result.total, 107);
  assert.equal(result.bytes.length, 7);
});

test('HTTP 400 and truncated short responses are errors, not proof of EOF', async () => {
  for (const response of [
    () => new Response(null, { status: 400 }),
    () => new Response(new Uint8Array(7), { headers: { 'content-length': '8', 'content-type': 'video/mp4' } })
  ]) {
    const { context } = createWorker(response);
    await assert.rejects(context.fetchMediaRange({}, { url: 'https://test.googlevideo.com/videoplayback?itag=18' }, 100, 199, new AbortController().signal));
  }
});

test('4K transfer passes 90 MB after a 403 and sends each byte exactly once', async () => {
  const total = 94 * MB + 31;
  const requests = [];
  const { context, messages } = createWorker(async (input, options) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('cpn'), 'player-session');
    assert.equal(url.searchParams.get('pot'), 'old');
    const range = options.headers.Range?.replace('bytes=', '') || url.searchParams.get('range');
    const [start, end] = range.split('-').map(Number);
    requests.push({ start, end, header: Boolean(options.headers.Range) });
    if (start === 90 * MB && !options.headers.Range) return new Response(null, { status: 403 });
    const data = new Uint8Array(end - start + 1).fill(Math.floor(start / (2 * MB)));
    return new Response(data, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${total}` } });
  });
  await context.transferMedia({ pageUrl: 'https://www.youtube.com/watch?v=oLuhZHUEIKE', streams: [streamFor(total)] });
  assert.equal(vm.runInContext('transferStatus.state', context), 'completed');
  const received = messages.filter(m => m.action === 'transfer-chunk');
  let offset = 0;
  for (const chunk of received) {
    assert.ok(chunk.bytes.every(byte => byte === Math.floor(offset / (2 * MB))));
    offset += chunk.bytes.length;
  }
  assert.equal(offset, total);
  assert.deepEqual(requests.filter(r => r.start === 90 * MB).map(r => r.header), [false, true]);
  assert.equal(messages.at(-1).action, 'transfer-finish');
});

test('403 refresh resumes the same representation and offset using the source tab', async () => {
  const total = 100 * MB;
  const stream = streamFor(total);
  const starts = [];
  let refreshes = 0;
  const { context } = createWorker(async (input, options) => {
    const url = new URL(input);
    const range = options.headers.Range?.replace('bytes=', '') || url.searchParams.get('range');
    starts.push(Number(range.split('-')[0]));
    if (url.searchParams.get('pot') === 'old') return new Response(null, { status: 403 });
    return new Response(new Uint8Array(2 * MB).fill(42), {
      status: 206, headers: { 'content-range': `bytes ${90 * MB}-${92 * MB - 1}/${total}` }
    });
  }, { async executeScript(options) {
    refreshes++;
    assert.equal(options.target.tabId, 12);
    assert.deepEqual(Array.from(options.args), ['oLuhZHUEIKE', true]);
    return [{ result: [stream.url.replace('id=video', 'id=wrong-video'), stream.url.replace('pot=old', 'pot=renewed')] }];
  } });
  const chunk = await context.fetchMediaRange({ tabId: 12, pageUrl: 'https://www.youtube.com/watch?v=oLuhZHUEIKE' }, stream, 90 * MB, 92 * MB - 1, new AbortController().signal);
  assert.equal(chunk.bytes.length, 2 * MB);
  assert.equal(refreshes, 1);
  assert.deepEqual(starts, [90 * MB, 90 * MB, 90 * MB]);
  assert.equal(new URL(stream.url).searchParams.get('pot'), 'renewed');
});

test('rejects a changed video, encoding, length or audio track during URL renewal', () => {
  const { context } = createWorker();
  const original = mediaURL(1000);
  for (const candidate of [original.replace('id=video', 'id=other'), original.replace('itag=401', 'itag=399'), original.replace('lmt=123', 'lmt=456'), original.replace('clen=1000', 'clen=900'), original + '&xtags=lang%3Den']) {
    assert.equal(context.compatiblePlaybackURL(original, candidate, 1000), false);
  }
  assert.equal(context.compatiblePlaybackURL(original, original.replace('pot=old', 'pot=new'), 1000), true);
});

test('URL refresh skips previously rejected URLs instead of cycling back to them', async () => {
  const stream = streamFor(1000);
  const oldURL = stream.url;
  stream.url = oldURL.replace('pot=old', 'pot=current');
  stream.failedPlaybackURLs = new Set([oldURL]);
  const { context } = createWorker(undefined, { async executeScript() {
    return [{ result: [oldURL, oldURL.replace('pot=old', 'pot=fresh')] }];
  } });
  assert.equal(await context.refreshPlaybackURL({ tabId: 12, pageUrl: 'https://www.youtube.com/watch?v=oLuhZHUEIKE' }, stream), true);
  assert.equal(new URL(stream.url).searchParams.get('pot'), 'fresh');
});

test('source-tab URL reader refreshes player data and ignores a navigated tab', async () => {
  const { context } = createWorker(async () => new Response(JSON.stringify({
    videoDetails: { videoId: 'oLuhZHUEIKE' },
    streamingData: { adaptiveFormats: [{ url: mediaURL(1000).replace('pot=old', 'pot=fresh') }] }
  })));
  context.document = { getElementById() { return { getPlayerResponse() { return {
    videoDetails: { videoId: 'oLuhZHUEIKE' }, streamingData: { formats: [{ url: mediaURL(1000) }] }
  }; } }; } };
  context.window = { ytcfg: { get() { return { client: { clientName: 'WEB' } }; } } };
  context.performance = { getEntriesByType() { return [{ name: mediaURL(1000) + '&range=0-999' }, { name: 'https://unrelated.example/private' }]; } };
  const urls = await context.readPlaybackURLs('oLuhZHUEIKE', true);
  assert.ok(urls.some(url => url.includes('pot=fresh')));
  assert.ok(urls.every(url => new URL(url).hostname.endsWith('.googlevideo.com')));
  assert.equal((await context.readPlaybackURLs('different-video', true)).length, 0);
});

test('short ranges continue until the declared stream length is reached', async () => {
  const offsets = [];
  const { context, messages } = createWorker(async input => {
    const start = Number(new URL(input).searchParams.get('range').split('-')[0]);
    offsets.push(start);
    return new Response(new Uint8Array(4), { headers: { 'content-range': `bytes ${start}-${start + 3}/12` } });
  });
  await context.transferMedia({ pageUrl: 'https://www.youtube.com/watch?v=oLuhZHUEIKE', streams: [streamFor(12)] });
  assert.deepEqual(offsets, [0, 4, 8]);
  assert.equal(messages.at(-1).action, 'transfer-finish');
});

test('premature 416, empty body and wrong byte ranges cannot be marked complete', async () => {
  for (const response of [
    () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */12' } }),
    () => new Response(new Uint8Array()),
    () => new Response(new Uint8Array(4), { status: 206, headers: { 'content-range': 'bytes 4-7/12' } })
  ]) {
    const { context, messages } = createWorker(response);
    await context.transferMedia({ pageUrl: 'https://www.youtube.com/watch?v=oLuhZHUEIKE', streams: [streamFor(12)] });
    assert.equal(vm.runInContext('transferStatus.state', context), 'error');
    assert.ok(!messages.some(m => ['transfer-stream-end', 'transfer-finish'].includes(m.action)));
    assert.equal(messages.at(-1).action, 'transfer-abort');
  }
});

test('network failure while reading a body retries without emitting partial bytes', async () => {
  let calls = 0;
  const { context, messages } = createWorker(async () => {
    if (++calls === 1) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([9, 9]));
      controller.error(new Error('connection reset'));
    } }));
    return new Response(new Uint8Array([1, 2, 3, 4]));
  });
  await context.transferMedia({ pageUrl: 'https://www.youtube.com/watch?v=oLuhZHUEIKE', streams: [streamFor(4)] });
  assert.equal(calls, 2);
  assert.deepEqual([...messages.find(m => m.action === 'transfer-chunk').bytes], [1, 2, 3, 4]);
  assert.equal(messages.at(-1).action, 'transfer-finish');
});

test('one stream failure cancels other in-flight streams before transfer cleanup', async () => {
  let siblingAborted = false;
  const { context, messages } = createWorker(async (input, options) => {
    if (new URL(input).searchParams.get('itag') === '401') return new Response(null, { status: 404 });
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      siblingAborted = true;
      reject(new Error('aborted'));
    }, { once: true }));
  });
  await context.transferMedia({ pageUrl: 'https://www.youtube.com/watch?v=oLuhZHUEIKE', streams: [streamFor(12), { ...streamFor(12), url: mediaURL(12).replace('itag=401', 'itag=140'), itag: 140, hasVideo: false, hasAudio: true }] });
  assert.ok(siblingAborted);
  assert.equal(messages.at(-1).action, 'transfer-abort');
});

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
    URL,
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
