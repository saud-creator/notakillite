import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { runTool } from '../companion/audio.mjs';

const root = process.cwd();
const profile = await mkdtemp(path.join(root, '.local', 'advanced-ui-qa-'));
const source = path.join(profile, 'Lecture from Apple.m4a');
await runTool(ffmpeg, ['-y', '-i', path.join(root, 'tests', 'fixtures', 'spoken-lecture.wav'), '-t', '3.137', '-c:a', 'aac', source]);
const context = await chromium.launchPersistentContext(profile, {
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true,
  viewport: { width: 560, height: 900 },
  args: [`--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`, '--no-first-run'],
});
const errors = [];
const title = 'Lecture from Apple';
const before = new Set(await readdir(path.join(root, 'exports')));
try {
  await context.route('https://notability.com/**', route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const app = await context.newPage();
  app.on('pageerror', error => errors.push(error.message));
  await app.goto(`chrome-extension://${new URL(worker.url()).hostname}/popup.html`);
  await app.getByText('Processor ready', { exact: true }).waitFor();
  assert.equal(await app.locator('#noise-engine').inputValue(), 'deepfilter');
  await app.locator('#split-minutes').selectOption('0');
  await app.locator('#local-import summary').click();
  for (const engine of ['rnnoise', 'deepfilter', 'hybrid']) {
    await app.locator('#noise-engine').selectOption(engine);
    await app.locator('#noise-strength').selectOption('balanced');
    await app.locator('#audio-file').setInputFiles(source);
    await app.getByRole('button', { name: 'Clean & export MP3', exact: true }).click();
    await app.waitForFunction(() => document.querySelector('#feedback-text').textContent.startsWith('Export complete.'), null, { timeout: 60000 });
    await app.getByRole('button', { name: 'Clean & export MP3', exact: true }).waitFor();
    await app.getByLabel('Preview cleaned audio', { exact: true }).waitFor();
    const link = app.locator('.download-result').first();
    const download = await context.request.get(await link.getAttribute('href'));
    assert.equal(download.status(), 200);
    assert.ok((await download.body()).length > 1000);
    assert.equal(await app.locator('#export-progress').isVisible(), false);
    assert.equal(await app.locator('#noise-engine').isDisabled(), false);
    assert.equal(await app.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'The app must not scroll horizontally.');
  }
  // Engine settings and library navigation use separate persisted preferences.
  await app.locator('#export-settings>summary').click();
  await app.waitForFunction(async () => (await chrome.storage.local.get('audioExportPreferences')).audioExportPreferences?.expanded === false);
  await app.reload();
  await app.getByText('Processor ready', { exact: true }).waitFor();
  assert.equal(await app.locator('#export-settings').getAttribute('open'), null);
  assert.equal(await app.locator('#noise-engine').inputValue(), 'hybrid');
  await app.locator('#local-import summary').click();
  await app.locator('#audio-file').setInputFiles(source);
  assert.equal(await app.getByRole('button', { name: 'Clean & export MP3', exact: true }).isEnabled(), true, 'File import must still work after reopening with collapsed settings.');
  await app.evaluate(() => scrollTo(0, 0));
  await app.screenshot({ path: path.join(root, '.local', 'advanced-audio-ui.png'), fullPage: true, animations: 'disabled' });
  await app.setViewportSize({ width: 380, height: 820 });
  await app.evaluate(() => scrollTo(0, 0));
  assert.equal(await app.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await app.screenshot({ path: path.join(root, '.local', 'advanced-audio-ui-narrow.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  const exports = (await readdir(path.join(root, 'exports'))).filter(name => !before.has(name) && name.startsWith(title));
  assert.equal(exports.length, 3);
  const manifests = [];
  for (const name of exports) {
    const destination = await realpath(path.join(root, 'exports', name));
    const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
    assert.equal(manifest.title, title);
    assert.equal(manifest.source, 'Local audio file');
    assert.ok(destination.startsWith(`${await realpath(path.join(root, 'exports'))}${path.sep}`));
    manifests.push(manifest.noiseReductionEngine);
    await rm(destination, { recursive: true, force: true });
  }
  assert.deepEqual(manifests.sort(), ['deepfilter', 'hybrid', 'rnnoise']);
  console.log(JSON.stringify({ localM4aImport: 'passed', RNNoise: 'passed', DeepFilterNet: 'passed', bothEngines: 'passed', previewAndDownload: 'passed', savedPreferences: 'passed', collapsibleSettings: 'passed', narrowLayout: 'passed', errors }));
} finally { await context.close(); }
