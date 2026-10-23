const HOST = 'com.notakillite.bridge';
const VERSION = chrome.runtime.getManifest().version;
let port, connecting, profileIdentity, ready = false, pairingNonce, nativeMessage = 'Open Notakillite to connect.', targetId, tabCreation;
const inflight = new Map();
const allowed = new Set(['state', 'load', 'startCapture', 'captureStatus', 'readChunk', 'forgetCaptureTask', 'release']);

async function profileId() {
  if (!profileIdentity) profileIdentity = (async () => { const saved = await chrome.storage.local.get('profileId'); if (saved.profileId) return saved.profileId; const value = crypto.randomUUID(); await chrome.storage.local.set({ profileId: value }); return value; })();
  return profileIdentity;
}
async function hello() { port?.postMessage({ type: 'hello', protocol: 1, extensionId: chrome.runtime.id, version: VERSION, profileId: await profileId(), pairingNonce }); }
async function keepOneConnectionTab(currentId) {
  if (!Number.isInteger(currentId)) return;
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('connect.html') + '*' });
  const duplicates = tabs.filter(tab => tab.id !== currentId).map(tab => tab.id);
  if (duplicates.length) await chrome.tabs.remove(duplicates).catch(() => {});
}
async function connect() {
  if (port) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const saved = await chrome.storage.session.get('pairingNonce'); pairingNonce ||= saved.pairingNonce;
    const channel = chrome.runtime.connectNative(HOST); port = channel;
    channel.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port === channel) { port = undefined; ready = false; nativeMessage = 'Open Notakillite, then reconnect. Your Brave sign-in is retained.'; }
      void chrome.alarms.create('notakillite-reconnect', { delayInMinutes: 0.5 });
    });
    channel.onMessage.addListener(message => {
      if (message.type === 'helloAck') {
        ready = !!message.accepted; nativeMessage = message.message || (ready ? 'Connected to Notakillite. Your sign-in stays in this Brave profile.' : 'Pair this Brave profile from Notakillite.');
        if (ready) { pairingNonce = undefined; void chrome.storage.session.remove('pairingNonce'); }
        return;
      }
      if (message.type !== 'request' || typeof message.id !== 'string' || message.id.length > 100 || !Array.isArray(message.args)) return;
      if (inflight.has(message.id)) return;
      const task = execute(message.operation, message.args).then(result => sendResponse(channel, { type: 'response', id: message.id, result }), error => sendResponse(channel, { type: 'response', id: message.id, error: { code: error.code || 'SITE_UNAVAILABLE', message: error.message || 'Notability could not complete this action.' } })).finally(() => inflight.delete(message.id));
      inflight.set(message.id, task);
    });
    await hello();
  })();
  try { await connecting; } finally { connecting = undefined; }
}
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function isApp(url) { try { const u = new URL(url); return u.origin === 'https://notability.com' && (u.pathname === '/app' || u.pathname.startsWith('/app/')); } catch { return false; } }
async function target({ show = false, create = false } = {}) {
  let tab;
  if (targetId) { try { tab = await chrome.tabs.get(targetId); if (!isApp(tab.url)) tab = undefined; } catch {} }
  if (!tab) tab = (await chrome.tabs.query({ url: 'https://notability.com/app*' })).find(tab => isApp(tab.url));
  if (!tab && create) {
    if (!tabCreation) tabCreation = chrome.tabs.create({ url: 'https://notability.com/app', active: true }).finally(() => { tabCreation = undefined; });
    tab = await tabCreation;
  }
  if (!tab) {
    const login = (await chrome.tabs.query({ url: 'https://notability.com/*' })).find(tab => /\/login|\/sign.?in/i.test(tab.url || ''));
    throw failure(login ? 'SIGN_IN_REQUIRED' : 'TAB_UNAVAILABLE', login ? 'Sign in on Notability in your regular Brave window. The app will reconnect automatically.' : 'Open Notability in your paired Brave profile to load the library.');
  }
  targetId = tab.id;
  if (show) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
  return tab;
}
async function execute(operation, args) {
  if (operation === 'show') { await target({ show: true, create: true }); return {}; }
  if (!allowed.has(operation)) throw failure('INVALID_OPERATION', 'Unsupported connector action.');
  if (operation === 'state') await target({ create: true });
  const tab = await target();
  if (tab.status !== 'complete') throw failure('LIBRARY_LOADING', 'Notability is loading. Keep its tab open; the app will reconnect automatically.');
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['adapter.js'] });
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: async (operation, args) => {
      try {
        const adapter = globalThis.__notakilliteAdapter;
        if (!adapter || typeof adapter[operation] !== 'function') return { error: { code: 'INTEGRATION_INCOMPATIBLE', message: 'The Notability integration needs an update.' } };
        return { result: await adapter[operation](...args) };
      } catch (error) { return { error: { code: error.code || 'SITE_UNAVAILABLE', message: error.message || 'Notability could not complete this action.' } }; }
    }, args: [operation, args] });
    const response = results[0]?.result;
    if (!response) throw failure('INTEGRATION_INCOMPATIBLE', 'The Notability page did not return a connector response. Reload its tab and retry.');
    if (response.error) throw failure(response.error.code, response.error.message);
    return response.result;
  } catch (error) { if (error.code) throw error; throw failure('SITE_UNAVAILABLE', 'The Notability tab changed or became unavailable. Reopen it and retry; your sign-in is retained.'); }
}
function sendResponse(channel, packet) {
  if (port !== channel) return;
  const bytes = new TextEncoder().encode(JSON.stringify(packet));
  try {
    if (bytes.length <= 512 * 1024) { channel.postMessage(packet); return; }
    if (bytes.length > 32 * 1024 ** 2) { channel.postMessage({ type: 'response', id: packet.id, error: { code: 'LIBRARY_TOO_LARGE', message: 'This library exceeds the connector transfer limit.' } }); return; }
    const chunkSize = 128 * 1024, total = Math.ceil(bytes.length / chunkSize);
    for (let index = 0; index < total; index++) {
      const chunk = bytes.subarray(index * chunkSize, (index + 1) * chunkSize); let text = '';
      for (let offset = 0; offset < chunk.length; offset += 8192) text += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
      channel.postMessage({ type: 'responseChunk', id: packet.id, index, total, data: btoa(text) });
    }
  } catch { /* A browser disconnect is recovered by the native core's owned request timeout. */ }
}
chrome.runtime.onMessage.addListener((message, sender, send) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split('#')[0].split('?')[0] !== chrome.runtime.getURL('connect.html')) return;
  if (message.type === 'connect') {
    (async () => {
      await keepOneConnectionTab(sender.tab?.id);
      if (typeof message.pairingNonce === 'string' && /^[\da-f]{48}$/i.test(message.pairingNonce)) { pairingNonce = message.pairingNonce; await chrome.storage.session.set({ pairingNonce }); }
      await connect(); if (port) await hello();
      if (message.openNotability) await target({ create: true, show: true });
      return { ready, message: nativeMessage };
    })().then(send, error => send({ ready: false, message: error.message }));
    return true;
  }
  if (message.type === 'status') { send({ ready, message: nativeMessage }); return; }
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'notakillite-reconnect') void connect(); });
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (isApp(tab.url) && (change.status === 'complete' || change.url)) void connect(); });
void connect();
