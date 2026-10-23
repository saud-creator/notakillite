import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
async function restored(status) {
  const saved = { exportRuntime: { operation: { id: 'export-1', active: true, jobId: 'job-1', jobIndex: 0, capture: { tabId: 7, url: 'blob:https://notability.com/fixture' }, plan: {
    tabId: 7, note: { id: 'note-1', title: 'Lecture' }, recordings: [{ id: 'recording-1', name: 'Recording' }], options: { clean: true, splitMinutes: 0 },
  } } } };
  const requests = [], scripts = [];
  const event = { addListener() {} };
  const context = {
    setInterval: () => 1, clearInterval() {}, setTimeout, AbortSignal, URL,
    fetch: async (url, options = {}) => {
      requests.push([new URL(url).pathname, options.method || 'GET']);
      return { ok: true, json: async () => url.endsWith('/health') ? { ready: true, token: 'test-only' } : { status, files: [] } };
    },
    chrome: {
      runtime: { id: 'test-extension', getURL: name => `chrome-extension://test-extension/${name}`, onMessage: event, onConnect: event, onInstalled: event },
      storage: { session: {
        get: async key => ({ [key]: structuredClone(saved[key]) }),
        set: async value => Object.assign(saved, structuredClone(value)),
      } },
      downloads: { onChanged: event },
      scripting: { executeScript: async details => { scripts.push(details); return [{ result: { ok: true, value: true } }]; } },
    },
  };
  vm.runInNewContext(source, context);
  for (let i = 0; i < 100 && saved.exportRuntime.operation.active; i++) await new Promise(resolve => setTimeout(resolve, 2));
  return { saved: saved.exportRuntime, requests, scripts };
}

test('a restarted worker recovers a completed processor job without re-exporting its recording', async () => {
  const { saved, requests, scripts } = await restored('done');
  assert.equal(saved.operation.active, false);
  assert.equal(saved.operation.outcome, 'done');
  assert.match(saved.message, /Export complete/);
  assert.deepEqual(requests, [['/health', 'POST'], ['/jobs/job-1', 'GET']]);
  assert.deepEqual(scripts.filter(item => item.args).map(item => item.args[0]), ['release']);
});

test('a worker restarted during upload cancels the incomplete job and reports a retryable error', async () => {
  const { saved, requests, scripts } = await restored('uploading');
  assert.equal(saved.operation.active, false);
  assert.equal(saved.operation.outcome, 'error');
  assert.match(saved.error, /interrupted.*transfer.*again/i);
  assert.ok(requests.some(([url, method]) => url === '/jobs/job-1' && method === 'DELETE'));
  assert.deepEqual(scripts.filter(item => item.args).map(item => item.args[0]), ['release']);
});
