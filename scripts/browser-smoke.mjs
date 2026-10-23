import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = process.cwd();
await mkdir(path.join(root, '.local'), { recursive: true });
const extension = path.join(root, 'extension');
const profile = path.join(root, '.local', 'browser-qa');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  viewport: { width: 440, height: 600 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).hostname;
  const health = await worker.evaluate(async () => {
    const response = await fetch('http://127.0.0.1:43188/health', { method: 'POST', cache: 'no-store' });
    const data = await response.json();
    return { status: response.status, ready: data.ready, tokenReceived: typeof data.token === 'string' && data.token.length === 64 };
  });
  assert.equal(health.status, 200, 'Extension must reach the local companion.');
  assert.equal(health.ready, true);
  assert.equal(health.tokenReceived, true, 'Real extension POST must include an accepted Origin and receive its token.');

  // An actual action popup has no sender.tab. Opening popup.html as a normal tab
  // would exercise a different sender that the background intentionally rejects.
  await worker.evaluate(() => chrome.action.openPopup());
  const protocol = await context.browser().newBrowserCDPSession();
  const targets = await protocol.send('Target.getTargets');
  const target = targets.targetInfos.find(item => item.url === `chrome-extension://${id}/popup.html`);
  assert.ok(target, 'Edge must create an actual extension action popup.');
  const { sessionId } = await protocol.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  protocol.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (!message.id) return;
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  async function command(method, params = {}) {
    const commandId = ++sequence;
    const response = new Promise(resolve => pending.set(commandId, resolve));
    await protocol.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: commandId, method, params }) });
    const result = await response;
    if (result.error) throw new Error(result.error.message);
    return result.result;
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitFor(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Popup condition timed out: ${expression}`);
  }
  await command('Runtime.enable');
  await waitFor(`document.querySelector('#processor-status')?.textContent === 'Processor ready'`);
  await waitFor(`document.querySelector('#connection-label')?.textContent === 'Waiting for Notability'`);
  assert.equal(await evaluate(`document.querySelectorAll('.note-card').length`), 0, 'No account data should be invented.');
  await evaluate(`document.querySelector('#clean-audio').checked = false; document.querySelector('#clean-audio').dispatchEvent(new Event('change')); document.querySelector('#split-minutes').value = '0'; document.querySelector('#split-minutes').dispatchEvent(new Event('change'))`);
  await command('Page.reload');
  await waitFor(`document.querySelector('#processor-status')?.textContent === 'Processor ready'`);
  assert.equal(await evaluate(`document.querySelector('#clean-audio').checked`), false, 'Cleanup preference should persist.');
  assert.equal(await evaluate(`document.querySelector('#split-minutes').value`), '0', 'Split preference should persist.');
  await evaluate(`document.querySelector('#clean-audio').checked = true; document.querySelector('#clean-audio').dispatchEvent(new Event('change')); document.querySelector('#split-minutes').value = '20'; document.querySelector('#split-minutes').dispatchEvent(new Event('change'))`);
  await evaluate(`document.querySelector('#search').value = 'no-matching-lecture'; document.querySelector('#search').dispatchEvent(new Event('input'))`);
  await waitFor(`document.querySelector('#empty-title')?.textContent === 'No matching notes or folders'`);
  await evaluate(`document.querySelector('#search').value = ''; document.querySelector('#search').dispatchEvent(new Event('input'))`);
  const screenshot = await command('Page.captureScreenshot', { captureBeyondViewport: false });
  await writeFile(path.join(root, '.local', 'popup.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate('window.scrollTo(0, document.body.scrollHeight)');
  const libraryScreenshot = await command('Page.captureScreenshot', { captureBeyondViewport: false });
  await writeFile(path.join(root, '.local', 'popup-library.png'), Buffer.from(libraryScreenshot.data, 'base64'));
  assert.deepEqual(errors, [], 'Popup should not raise page errors.');
  console.log(JSON.stringify({ extensionId: id, health, popup: 'passed', preferences: 'passed', screenshot: '.local/popup.png', errors }, null, 2));
} finally {
  await context.close();
}
