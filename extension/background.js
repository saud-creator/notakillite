const BRIDGE = 'http://127.0.0.1:43188';
let bridgeToken;
let statusMessage = '';
let statusError = '';
let exporting = false;
const uploadOwners = new Map();
const originalDownloads = new Map();
const uiPorts = new Set();
let stateRequest;
let operation;
let heartbeat;
let exportProgress;

function persistExport() { return chrome.storage.session.set({ exportRuntime: { operation, message: statusMessage, error: statusError } }); }
function notify() {
  for (const port of uiPorts) { try { port.postMessage({ type: 'STATE_UPDATED' }); } catch { uiPorts.delete(port); } }
}
function progress(message, detail) { statusMessage = message; statusError = ''; exportProgress = detail || { phase: message }; void persistExport().catch(() => {}); notify(); }
function keepExportAlive() {
  if (!heartbeat) heartbeat = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 15000);
}
function readableError(error) {
  const message = error?.message || 'Export failed. Please try again.';
  return /message channel|port closed|receiving end|context invalidated|frame.*removed/i.test(message)
    ? 'The browser connection changed during the export. Keep Notability open and try exporting again.' : message;
}
async function finishExport(error) {
  exporting = false;
  exportProgress = undefined;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  if (operation) operation = { id: operation.id, active: false, outcome: error ? 'error' : 'done' };
  if (error) { statusError = readableError(error); statusMessage = ''; }
  try { await persistExport(); } finally { notify(); }
}
function ownExport(task) { keepExportAlive(); void task.then(() => finishExport(), error => finishExport(error)).catch(() => {}); }
function name(value) {
  const cleaned = String(value || 'Lecture').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 100) || 'Lecture';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

async function findTab() {
  const tabs = await chrome.tabs.query({ url: 'https://notability.com/app*' });
  return tabs.filter(tab => tab.id && new URL(tab.url).pathname.startsWith('/app')).sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function callPage(tabId, operation, ...args) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['adapter.js'] });
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', args: [operation, args],
    func: async (operation, args) => {
      try {
        const adapter = globalThis.__notakilliteAdapter;
        if (!adapter || typeof adapter[operation] !== 'function') throw new Error('Reload Notability and try again.');
        return { ok: true, value: await adapter[operation](...args) };
      } catch (error) { return { ok: false, error: error.message || 'Notability could not complete this operation.' }; }
    },
  });
  const result = results[0]?.result;
  if (!result?.ok) throw new Error(result?.error || 'Could not reach the Notability tab.');
  return result.value;
}

async function health() {
  try {
    const response = await fetch(`${BRIDGE}/health`, { method: 'POST', signal: AbortSignal.timeout(1500), cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.ready || !result.token) throw new Error('Processor unavailable.');
    bridgeToken = result.token;
    return { ready: true, engines: result.engines || { classic: true }, version: result.version };
  } catch { bridgeToken = undefined; return { ready: false }; }
}

async function processor(path, { method = 'GET', body, headers = {} } = {}) {
  if (!bridgeToken && !(await health()).ready) throw new Error('Start “Start Notakillite.cmd” to clean or split audio.');
  const response = await fetch(`${BRIDGE}${path}`, { method, body, headers: { 'X-Notakillite-Token': bridgeToken, ...headers }, signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The audio processor returned an error.');
  return data;
}

async function getState() {
  if (stateRequest) return stateRequest;
  stateRequest = readState().finally(() => { stateRequest = undefined; });
  return stateRequest;
}

async function readState() {
  const [tab, bridge] = await Promise.all([findTab(), health()]);
  if (!tab) return { connected: false, notes: [], bridge, busy: exporting, progress: exportProgress, message: statusMessage, error: statusError };
  try {
    const state = await callPage(tab.id, 'state');
    return { ...state, bridge, busy: exporting, progress: exportProgress, message: statusMessage, error: statusError };
  } catch (error) { return { connected: false, notes: [], bridge, busy: exporting, message: statusMessage, error: error.message }; }
}

async function exportAudio(message) {
  if (typeof message.noteId !== 'string' || typeof message.clean !== 'boolean' || ![0, 10, 20, 30].includes(message.splitMinutes)) throw new Error('Invalid export settings.');
  if (message.engine && !['classic', 'rnnoise', 'deepfilter', 'hybrid'].includes(message.engine)) throw new Error('Choose a supported noise reduction engine.');
  if (message.strength && !['balanced', 'strong'].includes(message.strength)) throw new Error('Choose a supported noise reduction strength.');
  const operationId = typeof message.operationId === 'string' && message.operationId.length < 200 ? message.operationId : crypto.randomUUID();
  if (operation?.id === operationId) {
    if (operation.outcome === 'error') throw new Error(statusError || 'The export was interrupted. Try exporting again.');
    return { ok: true, operationId, message: exporting ? 'Your export is already running.' : statusMessage };
  }
  if (exporting) throw new Error('An export is already running. Wait for it to finish.');
  exporting = true;
  operation = { id: operationId, active: true };
  statusError = '';
  statusMessage = 'Preparing your recording export…';
  try { await persistExport(); }
  catch (error) { exporting = false; operation.active = false; throw error; }
  notify();
  ownExport(prepareExport(message));
  return { ok: true, operationId, message: 'Export started. Keep Notability open; you can close this panel.' };
}

async function prepareExport(message) {
  const tab = await findTab();
  if (!tab) throw new Error('Open Notability and sign in first.');
  const state = await callPage(tab.id, 'state');
  const note = state.notes.find(item => item.id === message.noteId);
  if (!note) throw new Error('This note is no longer in the current account.');
  const recordings = await callPage(tab.id, 'load', note.id);
  const requested = message.recordingIds;
  const selected = recordings.filter(recording => !Array.isArray(requested) || requested.includes(recording.id));
  if (!selected.length) throw new Error('Select at least one recording.');
  if (message.clean || message.splitMinutes) {
    if (!(await health()).ready) throw new Error('Start the local companion for cleanup and splitting, or choose original audio.');
  }
  progress(`Preparing ${selected.length} recording${selected.length === 1 ? '' : 's'} from “${note.title}”…`);
  operation.plan = { tabId: tab.id, note, recordings: selected, options: { clean: message.clean, splitMinutes: message.splitMinutes, engine: message.engine || 'classic', strength: message.strength || 'balanced' } };
  await persistExport();
  await runExport(tab.id, note, selected, message);
}

async function awaitProcessed(jobId, recordingName) {
  let result;
  do {
    result = await processor(`/jobs/${jobId}`);
    if (result.status === 'error') throw new Error(result.error || 'Audio processing failed.');
    if (result.status === 'uploading') throw new Error('The browser interrupted the audio transfer. Please export this recording again.');
    if (result.status === 'done') break;
    const minutes = Math.floor((result.processedSeconds || 0) / 60);
    progress(`${result.status === 'queued' ? 'Queued' : result.phase || 'Cleaning and encoding'} · ${recordingName}${minutes && !result.phase ? ` · ${minutes} min processed` : ''}`, { phase: result.phase || 'Processing audio', fraction: result.fraction });
    await new Promise(resolve => setTimeout(resolve, 1500));
  } while (true);
  return result;
}

async function captureAudio(tabId, noteId, recordingId) {
  const task = await callPage(tabId, 'startCapture', noteId, recordingId);
  try {
    for (;;) {
      const result = await callPage(tabId, 'captureStatus', task.id);
      if (result.status === 'done') return result.capture;
      if (result.status === 'error') throw new Error(result.error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { await callPage(tabId, 'forgetCaptureTask', task.id).catch(() => {}); }
}

async function runExport(tabId, note, recordings, options, startIndex = 0) {
  for (let index = startIndex; index < recordings.length; index++) {
    const recording = recordings[index];
    progress(`Loading original audio · ${index + 1} of ${recordings.length} · ${recording.name}`);
    const capture = await captureAudio(tabId, note.id, recording.id);
    let jobId;
    let retainBlob = false;
    try {
      if (!options.clean && !options.splitMinutes) {
        const extensions = { 'audio/mp4': 'm4a', 'video/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/x-aac': 'aac', 'audio/alac': 'm4a', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/x-caf': 'caf', 'audio/caf': 'caf', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/amr': 'amr' };
        const extension = extensions[capture.mimeType.split(';')[0]] || 'audio';
        const downloadId = await chrome.downloads.download({ url: capture.url, filename: `Notakillite/${name(note.title)}/${String(index + 1).padStart(2, '0')} - ${name(recording.name)}.${extension}`, conflictAction: 'uniquify' });
        originalDownloads.set(downloadId, { tabId, url: capture.url });
        // Retain release ownership across service-worker restarts.
        await chrome.storage.session.set({ [`download:${downloadId}`]: { tabId, url: capture.url } });
        retainBlob = true;
        continue;
      }
      const job = await processor('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: note.title, recordingName: recording.name, clean: options.clean, splitMinutes: options.splitMinutes, engine: options.engine || 'classic', strength: options.strength || 'balanced' }) });
      jobId = job.id;
      operation.jobId = job.id;
      operation.jobIndex = index;
      operation.capture = { tabId, url: capture.url };
      await persistExport();
      uploadOwners.set(job.id, { tabId, expectedBytes: capture.size });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['rpc.js', 'transfer.js'] });
      progress(`Transferring audio locally · ${recording.name}`);
      const transfer = await chrome.tabs.sendMessage(tabId, { type: 'TRANSFER_AUDIO', url: capture.url, size: capture.size, jobId: job.id });
      uploadOwners.delete(job.id);
      if (!transfer?.ok) throw new Error(transfer?.error || 'The audio transfer was interrupted.');
      await processor(`/jobs/${job.id}/process`, { method: 'POST' });
      const result = await awaitProcessed(job.id, recording.name);
      progress(`Saved ${result.files.length} MP3 file${result.files.length === 1 ? '' : 's'} · ${recording.name}`);
    } catch (error) {
      if (jobId) await processor(`/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
      throw error;
    } finally {
      if (jobId) uploadOwners.delete(jobId);
      if (!retainBlob) await callPage(tabId, 'release', capture.url).catch(() => {});
      operation.jobId = undefined;
      operation.capture = undefined;
      await persistExport();
    }
  }
  progress(options.clean || options.splitMinutes ? 'Export complete. Your MP3 files are in the export folder. You can upload them to an AI that accepts audio.' : 'Original audio downloads started. Find them in your browser’s Downloads under Notakillite.');
}

async function handle(message, sender) {
  await ready;
  if (message?.type === 'UPLOAD_CHUNK') {
    const owner = uploadOwners.get(message.jobId);
    if (!owner || sender.tab?.id !== owner.tabId || sender.id !== chrome.runtime.id) throw new Error('This audio transfer is not authorized.');
    if (typeof message.data !== 'string' || message.data.length > 360000 || !Number.isSafeInteger(message.offset) || message.offset < 0) throw new Error('Invalid audio chunk.');
    const bytes = Uint8Array.from(atob(message.data), character => character.charCodeAt(0));
    if (message.offset + bytes.length > owner.expectedBytes) throw new Error('Audio transfer exceeds the recording size.');
    const result = await processor(`/jobs/${message.jobId}/audio`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Offset': String(message.offset) }, body: bytes });
    return { ok: true, ...result };
  }
  // Commands originate only in this extension's own popup, never a content script.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('Open the Notakillite extension to use this action.');
  switch (message?.type) {
    case 'PING': return { ok: true };
    case 'GET_STATE': return getState();
    case 'REFRESH': statusError = ''; notify(); return { ok: true };
    case 'OPEN_NOTABILITY': {
      const tab = await findTab();
      if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
      else await chrome.windows.create({ url: 'https://notability.com/app', type: 'normal' });
      return { ok: true };
    }
    case 'LOAD_RECORDINGS': {
      const tab = await findTab();
      if (!tab || typeof message.noteId !== 'string') throw new Error('Open Notability first.');
      await callPage(tab.id, 'load', message.noteId);
      notify();
      return { ok: true };
    }
    case 'EXPORT_AUDIO': return exportAudio(message);
    case 'OPEN_OUTPUT': await processor('/open-output', { method: 'POST' }); return { ok: true };
    case 'CLEAR_SESSION': {
      const tab = await findTab();
      if (tab) await callPage(tab.id, 'clear');
      statusMessage = ''; statusError = ''; notify();
      return { ok: true };
    }
    default: throw new Error('Unknown extension action.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['GET_STATE', 'REFRESH', 'LOAD_RECORDINGS', 'EXPORT_AUDIO', 'OPEN_OUTPUT', 'OPEN_NOTABILITY', 'CLEAR_SESSION', 'UPLOAD_CHUNK'].includes(message?.type)) return;
  handle(message, sender).then(respond, error => respond({ ok: false, error: error.message || 'Operation failed.' }));
  return true;
});
chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  const ui = port.name === 'notakillite-ui' && sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  const upload = port.name === 'notakillite-upload' && sender?.id === chrome.runtime.id && sender.tab && sender.url?.startsWith('https://notability.com/app');
  if (!ui && !upload) { port.disconnect(); return; }
  if (ui) uiPorts.add(port);
  port.onDisconnect.addListener(() => { uiPorts.delete(port); void chrome.runtime.lastError; });
  port.onMessage.addListener(packet => {
    if (!packet || typeof packet.id !== 'string' || packet.id.length > 200) return;
    if (upload && packet.message?.type !== 'UPLOAD_CHUNK') return;
    handle(packet.message, sender).then(
      result => { try { port.postMessage({ id: packet.id, result }); } catch {} },
      error => { try { port.postMessage({ id: packet.id, result: { ok: false, error: readableError(error) } }); } catch {} },
    );
  });
});

const ready = chrome.storage.session.get('exportRuntime').then(async saved => {
  const previous = saved.exportRuntime;
  if (!previous) return;
  operation = previous.operation;
  statusMessage = previous.message || '';
  statusError = previous.error || '';
  if (!operation?.active) return;
  if (!operation.jobId || !operation.plan) {
    await finishExport(new Error('The browser restarted during the recording download. Please export the recording again.'));
    return;
  }
  exporting = true;
  const savedOperation = operation;
  ownExport((async () => {
    const plan = savedOperation.plan;
    try { await awaitProcessed(savedOperation.jobId, plan.recordings[savedOperation.jobIndex]?.name || 'Lecture recording'); }
    catch (error) { await processor(`/jobs/${savedOperation.jobId}`, { method: 'DELETE' }).catch(() => {}); throw error; }
    finally { if (savedOperation.capture) await callPage(savedOperation.capture.tabId, 'release', savedOperation.capture.url).catch(() => {}); }
    operation.jobId = undefined;
    operation.capture = undefined;
    await persistExport();
    await runExport(plan.tabId, plan.note, plan.recordings, plan.options, savedOperation.jobIndex + 1);
  })());
}).catch(() => {});
chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
  const key = `download:${delta.id}`;
  const record = originalDownloads.get(delta.id) || (await chrome.storage.session.get(key))[key];
  if (!record) return;
  await callPage(record.tabId, 'release', record.url).catch(() => {});
  originalDownloads.delete(delta.id);
  await chrome.storage.session.remove(key);
});

// On the first install, Edge must finish registering the extension before its
// app URL can be opened. The launcher opens the official sign-in page first;
// this event then creates the app window from the registered extension itself.
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason !== 'install') return;
  void chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 560, height: 900 }).catch(() => {});
});
