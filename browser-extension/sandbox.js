window.addEventListener('message', async event => {
  const message = event.data;
  if (!message || message.type !== 'yt-downloader-evaluate' || !message.id) return;

  const target = event.source || window.parent;
  if (!target) return;

  try {
    const env = message.env || {};
    const code = message.code || message.data?.output || message.data || '';
    const fn = new Function(...Object.keys(env), code);
    const result = fn(...Object.values(env));
    target.postMessage({
      type: 'yt-downloader-evaluate-result',
      id: message.id,
      result
    }, '*');
  } catch (error) {
    target.postMessage({
      type: 'yt-downloader-evaluate-result',
      id: message.id,
      error: error?.message || String(error)
    }, '*');
  }
});
