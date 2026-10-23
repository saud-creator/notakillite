import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrave } from '../../core/brave.mjs';

const root = process.cwd();
const directory = path.join(root, 'design', 'review');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: await findBrave(), headless: true });
const report = { scope: 'Interactive design prototype only; no real account or audio processing', date: new Date().toISOString(), checks: [], screenshots: [] };
const check = (name, evidence) => report.checks.push({ name, status: 'passed', evidence });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [], remote = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
  const url = pathToFileURL(path.join(root, 'design', 'index.html')).href;
  await page.goto(url);
  assert.equal(await page.locator('.note').count(), 8);
  assert.equal(await page.locator('#export').isEnabled(), true);
  assert.equal(await page.locator('#selection-summary').innerText(), '2 recordings selected');
  assert.equal(await page.locator('.queue').evaluate(el => Math.round(el.getBoundingClientRect().height)), 53);
  check('Library and compact idle queue', '8 sample notes in selected folder; 2 recordings selected; idle queue is 53 pixels tall including border.');

  async function capture(name, width, height, setup) {
    await page.setViewportSize({ width, height });
    if (setup) await setup();
    await page.screenshot({ path: path.join(directory, name), animations: 'disabled' });
    const geometry = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight, queueBottom: document.querySelector('.queue').getBoundingClientRect().bottom, viewport: document.documentElement.clientHeight }));
    assert.ok(geometry.scroll <= geometry.width, `${name}: horizontal overflow`);
    assert.ok(geometry.queueBottom <= geometry.height + 1, `${name}: queue outside viewport`);
    report.screenshots.push({ name, width, height });
  }

  await capture('desktop-dark.png', 1440, 940);
  await page.locator('#theme-toggle').click();
  await capture('desktop-light.png', 1280, 800);

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const ratios = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const hex = token => style.getPropertyValue(token).trim().slice(1).match(/../g).map(v => parseInt(v, 16) / 255);
      const luminance = values => values.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
      const pairs = [['--text', '--bg'], ['--muted', '--bg'], ['--muted', '--panel'], ['--muted', '--raised'], ['--text', '--selected'], ['--muted', '--selected'], ['--accent-ink', '--accent'], ['--accent', '--selected'], ['--green', '--panel'], ['--warning', '--raised'], ['--red', '--panel']];
      return pairs.map(([foreground, background]) => { const a = luminance(hex(foreground)), b = luminance(hex(background)); return { foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }; });
    });
    for (const pair of ratios) assert.ok(pair.ratio >= 4.5, `${theme}: ${pair.foreground} on ${pair.background}: ${pair.ratio.toFixed(2)}`);
    check(`${theme} semantic text contrast`, { minimum: Math.min(...ratios.map(v => v.ratio)), ratios });
    const rendered = await page.evaluate(() => {
      const luminance = rgb => rgb.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const result = [];
      for (const element of document.querySelectorAll('.brand-name,#folder-heading,.note-title,.note-meta,.preset-name,.preset-sub,.recording-name,.recording-sub,.output-info,.export-summary,.note-duration')) {
        if (!element.checkVisibility()) continue;
        const color = getComputedStyle(element).color.match(/[\d.]+/g).slice(0,3).map(Number);
        let ancestor = element, background;
        while (ancestor) { const value = getComputedStyle(ancestor).backgroundColor.match(/[\d.]+/g).map(Number); if (value.length === 3 || value[3] === 1) { background = value.slice(0,3); break; } ancestor = ancestor.parentElement; }
        if (!background) throw new Error('Visible text has no opaque ancestor background.');
        const a = luminance(color), b = luminance(background);
        result.push({ text: element.textContent.trim().slice(0,60), ratio: (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05) });
      }
      return result;
    });
    assert.ok(rendered.length >= 20);
    for (const item of rendered) assert.ok(item.ratio >= 4.5, `${theme}: rendered ${item.text}: ${item.ratio}`);
    check(`${theme} rendered text contrast`, { elements: rendered.length, minimum: Math.min(...rendered.map(item => item.ratio)) });
  }

  await page.locator('#audio-filter').click();
  assert.equal(await page.locator('.note').count(), 6);
  await page.locator('#audio-filter').click();
  await page.locator('#search').fill('محاضرة');
  assert.equal(await page.locator('.note').count(), 1);
  assert.equal(await page.locator('.note-title').evaluate(el => getComputedStyle(el).direction), 'rtl');
  await page.locator('#search').fill('');
  check('Audio filter and Arabic search', '6 audio notes in selected folder; Arabic global search finds the sample lecture and uses RTL text direction.');

  await page.locator('[data-recording="0"]').uncheck();
  await page.locator('[data-recording="1"]').uncheck();
  assert.equal(await page.locator('#export').isDisabled(), true);
  await page.locator('#select-all').click();
  assert.equal(await page.locator('#export').isEnabled(), true);
  await page.locator('#advanced-toggle').click();
  await page.locator('#engine').selectOption('hybrid');
  assert.equal(await page.locator('.engine-warning').isVisible(), true);
  await page.locator('#split').selectOption('20');
  assert.match(await page.locator('#output-info').innerText(), /20-minute parts/);
  await page.locator('[data-preset="balanced"]').click();
  await page.locator('#advanced-toggle').click();
  check('Recording selection and advanced settings', 'No selection disables export; Select all restores it; combined engine warning and split summary update.');

  await page.locator('#scenario').selectOption('offline');
  assert.equal(await page.locator('.note').count(), 8);
  assert.equal(await page.locator('#banner').isVisible(), true);
  assert.equal(await page.locator('#export').isDisabled(), true);
  await capture('offline-cache.png', 1280, 800);
  await page.locator('#scenario').selectOption('blocked');
  await capture('signin-attention.png', 1280, 800);
  check('Connection failures retain library', 'Offline and rejected sign-in show contextual actions; remote export is disabled while sample library remains visible.');

  await page.locator('#scenario').selectOption('firstRun');
  assert.equal(await page.locator('.welcome').isVisible(), true);
  assert.equal(await page.locator('.inspector').isVisible(), false);
  await capture('first-launch.png', 1280, 800);
  await page.locator('#scenario').selectOption('connected');
  await page.locator('#scenario').selectOption('engine');
  assert.equal(await page.locator('#export').isDisabled(), true);
  await page.locator('[data-preset="fast"]').click();
  assert.equal(await page.locator('#export').isEnabled(), true);
  await page.locator('#scenario').selectOption('connected');
  check('First launch and unavailable engine', 'First launch has focused onboarding; choosing RNNoise explicitly enables export when DeepFilterNet3 is unavailable.');

  await capture('compact-library.png', 1024, 768);
  assert.equal(await page.locator('.inspector').isVisible(), false);
  await page.locator('.note').first().click();
  assert.equal(await page.locator('.inspector').isVisible(), true);
  await capture('compact-detail.png', 1024, 768);
  const closeGeometry = await page.locator('#detail-close').boundingBox();
  assert.ok(closeGeometry.y > 110 && closeGeometry.y < 170, 'Compact detail close action stays at the top.');
  assert.equal(await page.locator('#inspector-content').evaluate(el => el.scrollTop), 0);
  await page.locator('#detail-close').click();
  await page.setViewportSize({ width: 760, height: 768 });
  await page.locator('#nav-toggle').click();
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.locator('#scrim').click({ position: { x: 500, y: 200 } });
  await capture('narrow-library.png', 760, 768);
  await page.keyboard.press('Control+f');
  assert.equal(await page.locator('#search').evaluate(el => el === document.activeElement), true);
  check('Responsive panels and keyboard search', '1024×768 detail pane opens and dismisses; 760×768 folder drawer works; Ctrl+F focuses search.');

  await page.setViewportSize({ width: 1440, height: 940 });
  await page.locator('#export').click();
  await page.locator('#cancel-job').click();
  assert.match(await page.locator('#queue-status').innerText(), /cancelled/);
  await page.locator('#retry-job').click();
  await page.waitForFunction(() => document.querySelector('#queue-status').textContent.includes('Ready for AI'), { timeout: 12000 });
  await page.locator('#view-output').click();
  assert.equal(await page.locator('#dialog').isVisible(), true);
  assert.match(await page.locator('#dialog-content').innerText(), /No file was created/);
  await page.locator('#dialog-done').click();
  check('Simulated export/cancel/retry/completion', 'Demo can be cancelled and retried; completed-output dialog clearly states that no file was created.');
  await capture('completed-export.png', 1440, 940);
  await page.locator('#scenario').selectOption('exportError');
  await capture('export-failure.png', 1280, 800);
  assert.match(await page.locator('.job-error').innerText(), /not writable/);

  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  check('Self-contained prototype', 'No JavaScript runtime errors and no remote network requests. No real browser profile was opened.');
  report.result = 'passed';
  await writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, checks: report.checks.length, screenshots: report.screenshots.length, report: path.join(directory, 'verification.json') }));
} finally { await browser.close(); }
