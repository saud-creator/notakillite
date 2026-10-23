import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Synthetic app-service fixture: verifies browser wiring, not an authenticated
// Notability account or the continued compatibility of their private interfaces.
const root = process.cwd();
const reconnectQA = process.argv.includes('--reconnect');
const engine = process.argv.find(value => value.startsWith('--engine='))?.split('=')[1] || 'classic';
async function poll(probe, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Synthetic browser export check timed out.');
}
const title = 'Browser smoke fixture - synthetic audio';
const samples = 16000 * 24;
const wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 4000), 44 + i * 2);
const fixtureModule = `
  globalThis.qaEvents = [];
  const recording = {
    id: () => 'fixture-recording', name: () => '24-second generated tone',
    startTime: () => 0, initialDuration: () => 24000, assetHash: () => 'fixture-hash',
    recordingAsset: () => ({metadata: () => ({mimeType: () => 'audio/wav'})})
  };
  const session = {getModel: () => ({getRecordingEntities: () => [recording]})};
  const storage = new Map();
  const manager = {
    _sessionStorage: storage,
    openNote: async id => {qaEvents.push(['open', id]); storage.set(id, session); return session;},
    closeNote: async id => {qaEvents.push(['close', id]); storage.delete(id);}
  };
  export class Services {
    static getPersistenceManager() {return {getLibrary: async () => ({status: 'ready', library: {privateWorkspace: {id: 'fixture-workspace', notes: [{id: 'fixture-note', title: ${JSON.stringify(title)}, hasRecordings: true, updatedAt: '2026-10-20T12:00:00Z'}]}, sharedNotes: [], sharedWorkspaces: []}})}}
    static getNoteManager() {return manager;}
    static getRecordingAssetManager() {return {getAsset: async (hash, noteId) => {
      if (hash !== 'fixture-hash' || noteId !== 'fixture-note') throw new Error('Fixture asset ownership mismatch');
      qaEvents.push(['asset', noteId]);
      if (${reconnectQA} && qaEvents.filter(event => event[0] === 'asset').length === 1) await new Promise(resolve => setTimeout(resolve, 35000));
      return new Blob([Uint8Array.from(atob('${wave.toString('base64')}'), value => value.charCodeAt(0))], {type: 'audio/wav'});
    }}}
  }
`;
await mkdir(path.join(root, '.local', 'browser-downloads'), { recursive: true });
const extension = path.join(root, 'extension');
const context = await chromium.launchPersistentContext(path.join(root, '.local', reconnectQA ? 'browser-reconnect-qa' : 'browser-export-qa'), {
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true, viewport: { width: 440, height: 600 },
  acceptDownloads: true, downloadsPath: path.join(root, '.local', 'browser-downloads'),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'],
});
try {
  await context.route('https://notability.com/**', route => {
    if (new URL(route.request().url()).pathname === '/app/assets/sentry-browser-fixture.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: fixtureModule });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic Notability browser fixture</title><script type="module" src="/app/assets/sentry-browser-fixture.js"></script><h1>Local browser test fixture — no account data</h1>' });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const fixture = await context.newPage();
  await fixture.goto('https://notability.com/app');
  let app = await context.newPage();
  const errors = [];
  app.on('pageerror', error => errors.push(error.message));
  await app.goto(`chrome-extension://${id}/popup.html`);
  await app.getByText('Notability web account', { exact: true }).waitFor().catch(async error => {
    console.log(JSON.stringify({ errors, body: await app.locator('body').innerText() }));
    throw error;
  });
  await app.getByText(title, { exact: true }).waitFor();
  await app.getByRole('button', { name: 'Load recordings', exact: true }).click();
  await app.getByLabel('Export 24-second generated tone', { exact: true }).waitFor();
  assert.equal(await app.getByLabel('Export 24-second generated tone', { exact: true }).isChecked(), true);
  await app.locator('#clean-audio').check();
  await app.locator('#noise-engine').selectOption(engine);
  await app.locator('#split-minutes').selectOption('0');
  if (reconnectQA) {
    // This used to compete with broadcast runtime.sendMessage responses when
    // another app window was open. Addressed ports must remain unaffected.
    const other = await context.newPage();
    await other.goto(`chrome-extension://${id}/popup.html`);
    await other.evaluate(() => chrome.runtime.onMessage.addListener(async () => undefined));
    const cdp = await context.newCDPSession(app);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await app.evaluate(() => connection.request({ type: 'PING' }));
    await app.getByText(title, { exact: true }).waitFor();
    await other.close();
    await cdp.detach();
  }
  const before = new Set(await readdir(path.join(root, 'exports')));
  await app.getByRole('button', { name: '↓ Export audio', exact: true }).click();
  await app.getByRole('button', { name: 'Export in progress…', exact: true }).waitFor();
  assert.equal(await app.locator('#clear-session').isDisabled(), true, 'Session clearing must be disabled while an export owns the audio.');
  if (reconnectQA) {
    await poll(() => fixture.evaluate(() => qaEvents.some(event => event[0] === 'asset')));
    // The worker owns the slow Notability fetch, independent of the initiating
    // panel. A reopened panel must attach without starting a duplicate export.
    await app.close();
    app = await context.newPage();
    app.on('pageerror', error => errors.push(error.message));
    await app.goto(`chrome-extension://${id}/popup.html`);
    await app.getByText(title, { exact: true }).waitFor();
    await app.getByRole('button', { name: 'Export in progress…', exact: true }).waitFor();
    await app.evaluate(() => chrome.runtime.onMessage.addListener(async () => undefined));
    const replay = await app.evaluate(async () => {
      const { exportRuntime } = await chrome.storage.session.get('exportRuntime');
      return connection.request({ type: 'EXPORT_AUDIO', operationId: exportRuntime.operation.id, noteId: 'fixture-note', recordingIds: ['fixture-recording'], clean: true, splitMinutes: 0 });
    });
    assert.equal(replay.ok, true);
  }
  await app.waitForFunction(() => document.querySelector('#feedback-text')?.textContent.startsWith('Export complete.'), null, { timeout: 60000 }).catch(async error => {
    console.log(JSON.stringify({ errors, body: await app.locator('body').innerText(), state: await app.evaluate(() => connection.request({ type: 'GET_STATE' })) }));
    throw error;
  });
  await app.waitForFunction(() => !document.querySelector('#clear-session')?.disabled, null, { timeout: 10000 });
  const folders = (await readdir(path.join(root, 'exports'))).filter(name => !before.has(name) && name.startsWith(title));
  assert.equal(folders.length, 1, 'Synthetic browser export should create one output folder.');
  const destination = path.join(root, 'exports', folders[0]);
  assert.ok((await stat(path.join(destination, 'lecture.mp3'))).size > 1000);
  const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
  assert.equal(manifest.speechCleanup, true);
  assert.equal(manifest.noiseReductionEngine, engine);
  assert.equal(manifest.chunkMinutes, 0);
  const events = await fixture.evaluate(() => globalThis.qaEvents);
  assert.ok(events.some(event => event[0] === 'asset' && event[1] === 'fixture-note'));
  assert.equal(events.filter(event => event[0] === 'asset').length, 1, 'Reopening or retrying must not duplicate the recording download.');
  await app.screenshot({ path: path.join(root, '.local', 'popup-fixture.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const mp3Bytes = (await stat(path.join(destination, 'lecture.mp3'))).size;
  const exportRoot = await realpath(path.join(root, 'exports'));
  const resolvedDestination = await realpath(destination);
  assert.ok(resolvedDestination.startsWith(`${exportRoot}${path.sep}`), 'Fixture cleanup must stay inside exports.');
  assert.equal(manifest.title, title, 'Only this synthetic fixture may be removed.');
  await rm(resolvedDestination, { recursive: true, force: true });

  // Exercise chrome.downloads with a blob URL created in Notability's MAIN
  // world. The Chrome API must cross that origin boundary and release ownership.
  const earlierDownloads = await app.evaluate(async () => (await chrome.downloads.search({})).map(item => item.id));
  const originalResult = await app.evaluate(() => connection.request({ type: 'EXPORT_AUDIO', noteId: 'fixture-note', recordingIds: ['fixture-recording'], clean: false, splitMinutes: 0 }));
  assert.equal(originalResult.ok, true, originalResult.error);
  const original = await poll(() => app.evaluate(async earlier => {
    const items = await chrome.downloads.search({});
    return items.find(item => !earlier.includes(item.id) && item.state === 'complete' && item.byExtensionId === chrome.runtime.id) || false;
  }, earlierDownloads)).catch(async error => {
    console.log(JSON.stringify(await app.evaluate(async () => ({ downloadDiagnostics: await chrome.downloads.search({}), extensionState: await connection.request({ type: 'GET_STATE' }) })), null, 2));
    throw error;
  });
  const downloadRoot = await realpath(path.join(root, '.local', 'browser-downloads'));
  const downloadPath = await realpath(original.filename);
  assert.ok(downloadPath.startsWith(`${downloadRoot}${path.sep}`), 'Original fixture download must stay within the dedicated test folder.');
  assert.deepEqual(await readFile(downloadPath), wave, 'Original export must preserve every WAV byte.');
  await poll(() => app.evaluate(async id => !(await chrome.storage.session.get(`download:${id}`))[`download:${id}`], original.id), 5000);
  assert.equal(await fixture.evaluate(async url => { try { return (await fetch(url)).ok; } catch { return false; } }, original.url), false, 'Completed original download should revoke its page blob.');
  await rm(downloadPath, { force: true });
  await app.evaluate(id => chrome.downloads.erase({ id }), original.id);

  console.log(JSON.stringify({ fixture: 'synthetic only; no authenticated account', appTab: 'passed', lazyRecordingLoad: 'passed', mainToIsolatedBlobTransfer: 'passed', chunkUpload: 'passed', localSpeechCleanup: 'passed', busyControls: 'passed', ...(reconnectQA ? { workerRestart: 'passed', panelClosedDuring35SecondFetch: 'passed', competingMessageListener: 'passed', duplicateExportSuppressed: 'passed' } : {}), originalDownloadByteMatch: 'passed', originalBlobRelease: 'passed', outputRetained: false, mp3Bytes, errors }, null, 2));
} finally { await context.close(); }
