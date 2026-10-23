/* Isolated extension world: move audio in bounded chunks rather than one huge IPC message. */
if (!globalThis.__notakilliteTransferInstalled) {
globalThis.__notakilliteTransferInstalled = true;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'TRANSFER_AUDIO' || sender.id !== chrome.runtime.id) return;
  (async () => {
    const connection = new NotakilliteWorkerClient({ name: 'notakillite-upload' });
    try {
    if (typeof message.url !== 'string' || !message.url.startsWith('blob:https://notability.com/')) throw new Error('Invalid recording URL.');
    const response = await fetch(message.url);
    if (!response.ok || !response.body) throw new Error('Could not read the recording. Keep the Notability tab open.');
    const reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (let start = 0; start < value.length; start += 256 * 1024) {
          const chunk = value.subarray(start, start + 256 * 1024);
          let binary = '';
          for (let index = 0; index < chunk.length; index += 8192) binary += String.fromCharCode(...chunk.subarray(index, index + 8192));
          const result = await connection.request({ type: 'UPLOAD_CHUNK', jobId: message.jobId, offset, data: btoa(binary) });
          if (!result?.ok) throw new Error(result?.error || 'Audio transfer failed.');
          offset += chunk.byteLength;
        }
      }
    } finally { reader.releaseLock(); }
    if (offset !== message.size) throw new Error('The recording transfer was incomplete. Please retry.');
    return { ok: true, bytes: offset };
    } finally { connection.dispose(); }
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
}
