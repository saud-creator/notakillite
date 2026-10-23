import assert from 'node:assert/strict';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = process.cwd();
const profile = path.join(root, '.local', 'browser-first-install-qa-0.3.0');
const extension = path.join(root, 'extension');
const { extensionId } = JSON.parse(await readFile(path.join(root, 'scripts', 'extension-id.json'), 'utf8'));
const appUrl = `chrome-extension://${extensionId}/popup.html`;
await mkdir(path.join(root, '.local'), { recursive: true });
let profileExists = false;
try { await access(profile); profileExists = true; } catch { /* A first-install test requires a new profile. */ }
assert.equal(profileExists, false, 'Use a fresh .local/browser-first-install-qa profile for this one-time first-install verification.');

const context = await chromium.launchPersistentContext(profile, {
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  timeout: 30_000,
  viewport: { width: 480, height: 850 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'],
});
let state;
try {
  context.setDefaultTimeout(30_000);
  // No Notability page is opened: the fixture profile contains no account.
  // Prevent accidental external page requests while retaining loopback access.
  await context.route(/^https?:\/\//, route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === 'http://127.0.0.1:43188') return route.continue();
    return route.abort();
  });
  const worker = context.serviceWorkers().find(item => item.url().startsWith(`chrome-extension://${extensionId}/`))
    || await context.waitForEvent('serviceworker', { timeout: 30_000, predicate: item => item.url().startsWith(`chrome-extension://${extensionId}/`) });
  assert.equal(new URL(worker.url()).hostname, extensionId, 'The manifest public key must give the expected extension ID.');

  const deadline = Date.now() + 30_000;
  let app;
  while (Date.now() < deadline) {
    app = context.pages().find(page => page.url() === appUrl);
    if (app) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(app, 'onInstalled must open its own popup.html after extension registration; the test must not navigate there manually.');
  await app.getByText('Processor ready', { exact: true }).waitFor({ timeout: 30_000 });
  await app.getByText('Waiting for Notability', { exact: true }).waitFor({ timeout: 30_000 });
  state = await app.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  assert.equal(state?.bridge?.ready, true, 'The automatically opened app window must access the local processor.');
  assert.equal(state.connected, false, 'A fresh profile without sign-in must not claim an account connection.');
  assert.deepEqual(state.notes, [], 'A fresh profile must not contain sample or account notes.');
  assert.ok(context.pages().every(page => page.url() === 'about:blank' || page.url() === appUrl), 'The test must not navigate to external sites.');
  await app.screenshot({ path: path.join(root, '.local', 'first-install.png'), fullPage: true });
} finally {
  // This context was created above with its own new test profile. Never connect
  // to or close the user's live dedicated app/profile or debugging endpoint.
  await context.close();
}

// Verify the launcher's next-run registration check against real persisted Edge
// settings. Inspect only our extension entry; no preference values are printed.
const preferences = JSON.parse(await readFile(path.join(profile, 'Default', 'Secure Preferences'), 'utf8'));
assert.ok(preferences.extensions?.settings?.[extensionId], 'The next-run launcher must find our installed extension in Secure Preferences.');
console.log(JSON.stringify({ firstInstallWindow: 'passed', extensionId, processorReady: state.bridge.ready, accountConnected: state.connected, registeredForNextLaunch: true, closedOwnedContext: true }));
