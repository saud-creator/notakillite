import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeConnector } from '../core/native-connector.mjs';
import { Store } from '../core/store.mjs';
import { CoreService } from '../core/service.mjs';
import { EXTENSION_ID } from '../core/connector-info.mjs';
import { connectorInstallation } from '../core/browser-profiles.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notakillite-native-'));
  await mkdir(path.join(root, 'data')); await mkdir(path.join(root, 'brave'));
  await writeFile(path.join(root, 'brave', 'Local State'), JSON.stringify({ profile: { last_used: 'Default', info_cache: { Default: { name: 'Usual Brave' }, 'Profile 1': { name: 'Other Brave' } } } }));
  const store = new Store(path.join(root, 'data'));
  t.after(async () => { store.close(); assert.ok(path.basename(root).startsWith('notakillite-native-')); await rm(root, { recursive: true, force: true }); });
  return { root, store, profileRoot: path.join(root, 'brave') };
}
const hello = (profileId, pairingNonce) => ({ extensionId: EXTENSION_ID, protocol: 1, version: '0.5.0', profileId, pairingNonce });

test('one-time explicit pairing retains the usual Brave identity across three core instances without relaunching sign-in', async t => {
  const options = await setup(t); let launched;
  let didLaunch; const launchReady = new Promise(resolve => { didLaunch = resolve; });
  let connector = await new NativeConnector({ ...options, launch: async (_binding, url) => { launched = url; didLaunch(); } }).init();
  await assert.rejects(connector.connect(), { code: 'CONNECTOR_SETUP_REQUIRED' }); assert.equal(launched, undefined);
  const connecting = connector.connect({ interactive: true });
  await launchReady;
  const nonce = new URLSearchParams(new URL(launched).hash.slice(1)).get('pair'), id = randomUUID();
  assert.equal((await connector.accept('wrong', hello(id, 'wrong'))).accepted, false);
  assert.equal((await connector.accept('build-A', hello(id, nonce))).accepted, true); await connecting;
  connector.rememberAccount('verified-workspace'); await connector.close();
  for (const build of ['B', 'C']) {
    connector = await new NativeConnector({ ...options, launch: async () => assert.fail('Existing connected profile must not open another login window.') }).init();
    assert.equal(connector.info().profileDirectory, 'Default'); assert.equal(connector.info().profileId, id); assert.equal(connector.info().verifiedAccountId, 'verified-workspace');
    assert.equal((await connector.accept(`build-${build}`, hello(id))).accepted, true); await connector.connect(); await connector.close();
  }
});

test('a missing or disabled local connector gives setup guidance without opening a blocked extension page or resetting pairing', async t => {
  const options = await setup(t), profileId = randomUUID();
  const binding = { extensionId: EXTENSION_ID, profileId, profileDirectory: 'Default', userDataRoot: options.profileRoot, verifiedAccountId: 'retained-account' };
  options.store.set('braveBinding', binding);
  const directory = path.join(options.profileRoot, 'Default'); await mkdir(directory);
  const file = path.join(directory, 'Secure Preferences');
  const connector = await new NativeConnector({ ...options, launch: async () => assert.fail('An unavailable extension must not open an error tab.') }).init();
  t.after(() => connector.close());
  for (const settings of [{}, { [EXTENSION_ID]: { state: 0, disable_reasons: [1] } }]) {
    const bytes = JSON.stringify({ extensions: { settings }, unrelatedPreference: 'must remain unchanged' });
    await writeFile(file, bytes);
    await assert.rejects(connector.connect({ interactive: true }), { code: 'CONNECTOR_SETUP_REQUIRED' });
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal(options.store.get('braveBinding').profileId, profileId);
    assert.equal(options.store.get('braveBinding').verifiedAccountId, 'retained-account');
  }
  await writeFile(file, JSON.stringify({ extensions: { settings: { [EXTENSION_ID]: { state: 1, disable_reasons: [] } } } }));
  assert.equal(await connectorInstallation(binding), 'installed');
});

test('wrong profile/protocol cannot take over the selected session; disconnect rejects owned requests and preserves binding', async t => {
  const options = await setup(t), id = randomUUID();
  options.store.set('braveBinding', { profileId: id, profileDirectory: 'Default', verifiedAccountId: 'account-a' });
  const connector = await new NativeConnector(options).init();
  t.after(() => connector.close());
  assert.equal((await connector.accept('bad-protocol', { ...hello(id), protocol: 99 })).code, 'PROTOCOL_MISMATCH');
  assert.equal((await connector.accept('bad-profile', hello(randomUUID()))).code, 'PROFILE_MISMATCH');
  await connector.accept('owner', hello(id));
  const pending = connector.state(); connector.detach('someone-else'); assert.equal(connector.info().connected, true); connector.detach('owner');
  await assert.rejects(pending, { code: 'CONNECTOR_UNAVAILABLE' }); assert.equal(options.store.get('braveBinding').profileId, id);
});

test('large Arabic libraries use bounded response frames; capture streams exact bytes and releases only owned data', async t => {
  const options = await setup(t), id = randomUUID(), bytes = Buffer.alloc(800321, 0x5a), calls = [];
  options.store.set('braveBinding', { profileId: id, profileDirectory: 'Default' });
  const connector = await new NativeConnector(options).init(); t.after(() => connector.close()); await connector.accept('browser', hello(id));
  const library = { notes: Array.from({ length: 10000 }, (_, i) => ({ id: String(i), title: 'محاضرة الجهاز الهضمي ' + i })) };
  connector.on('command', packet => {
    calls.push(packet);
    let result;
    if (packet.operation === 'state') result = library;
    else if (packet.operation === 'startCapture') result = { id: 'owned-task' };
    else if (packet.operation === 'captureStatus') result = { status: 'done', capture: { url: 'blob:https://notability.com/owned', size: bytes.length, mimeType: 'audio/mp4' } };
    else if (packet.operation === 'readChunk') { const [, offset, count] = packet.args; assert.ok(count <= 192 * 1024); result = bytes.subarray(offset, offset + count).toString('base64'); }
    else result = {};
    queueMicrotask(() => {
      const response = { type: 'response', id: packet.id, result };
      if (packet.operation !== 'state') { connector.receive('browser', response); return; }
      const serialized = Buffer.from(JSON.stringify(response)), total = Math.ceil(serialized.length / 131072);
      for (let index = 0; index < total; index++) connector.receive('browser', { type: 'responseChunk', id: packet.id, index, total, data: serialized.subarray(index * 131072, (index + 1) * 131072).toString('base64') });
    });
  });
  assert.deepEqual(await connector.state(), library);
  const output = path.join(options.root, 'captured.m4a'); await connector.capture('note', 'recording', output);
  assert.deepEqual(await readFile(output), bytes);
  assert.equal(calls.filter(call => call.operation === 'readChunk').length, 5);
  assert.deepEqual(calls.at(-2).args, ['owned-task']); assert.deepEqual(calls.at(-1).args, ['blob:https://notability.com/owned']);
});

test('truncated/out-of-order responses and aborted requests fail explicitly without changing the paired profile', async t => {
  const options = await setup(t), id = randomUUID(); options.store.set('braveBinding', { profileId: id, profileDirectory: 'Default' });
  const connector = await new NativeConnector(options).init(); t.after(() => connector.close()); await connector.accept('browser', hello(id));
  let command; connector.on('command', value => { command = value; });
  const pending = connector.state(); connector.receive('browser', { type: 'responseChunk', id: command.id, index: 1, total: 2, data: 'e30=' });
  await assert.rejects(pending, { code: 'INVALID_RESPONSE' });
  const abort = new AbortController(), request = connector.request('captureStatus', ['task'], 5000, abort.signal); abort.abort();
  await assert.rejects(request, { name: 'AbortError' }); assert.equal(connector.pending.size, 0); assert.equal(connector.info().profileId, id);
});

test('offline failures keep cached metadata and typed genuine sign-out is distinguished from a connector failure', async t => {
  const options = await setup(t); let code = 'SITE_TIMEOUT';
  // The service owns a separate fixture database, with no authentication data.
  const connector = { async close() {}, async connect() {}, async state() { throw Object.assign(new Error('fixture error'), { code }); } };
  const service = await new CoreService({ dataRoot: path.join(options.root, 'service'), connector }).init();
  try { service.library = { notes: [{ id: 'cached' }], library: { accountId: 'a' } }; await service.refresh(); assert.equal(service.connection, 'Offline cache'); assert.equal(service.library.notes[0].id, 'cached'); code = 'SIGN_IN_REQUIRED'; await service.refresh(); assert.equal(service.connection, 'Sign-in required'); assert.equal(service.connectionCode, 'SIGN_IN_REQUIRED'); }
  finally { await service.close(); }
});
