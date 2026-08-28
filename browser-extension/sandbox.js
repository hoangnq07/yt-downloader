window.addEventListener('message', async event => {
  const message = event.data;
  if (!message || message.type !== 'yt-downloader-evaluate' || !message.id) return;

  try {
    const env = message.env || {};
    const properties = [];
    if (typeof env.n === 'string') {
      properties.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
    }
    if (typeof env.sig === 'string') {
      properties.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
    }
    const code = `${message.data?.output || ''}\nreturn { ${properties.join(', ')} };`;
    const result = new Function(code)();
    event.source.postMessage({
      type: 'yt-downloader-evaluate-result',
      id: message.id,
      result
    }, '*');
  } catch (error) {
    event.source.postMessage({
      type: 'yt-downloader-evaluate-result',
      id: message.id,
      error: error?.message || String(error)
    }, '*');
  }
});
