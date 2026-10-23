import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/rpc.js', import.meta.url), 'utf8');
function setup(onSend, options) {
  const ports = [];
  const context = { setTimeout, clearTimeout, chrome: { runtime: {
    connect() {
      const messages = [], disconnects = [];
      const port = {
        onMessage: { addListener: fn => messages.push(fn) },
        onDisconnect: { addListener: fn => disconnects.push(fn) },
        postMessage: packet => onSend(packet, port, ports.length),
        disconnect: () => disconnects.forEach(fn => fn()),
        reply: packet => messages.forEach(fn => fn(packet)),
      };
      ports.push(port);
      return port;
    },
  } } };
  vm.runInNewContext(source, context);
  return { client: new context.NotakilliteWorkerClient(options), ports };
}

test('concurrent replies are addressed to their request and state notifications stay separate', async () => {
  const pending = [];
  const { client, ports } = setup(packet => pending.push(packet));
  let notifications = 0;
  client.subscribe(() => notifications++);
  try {
    const first = client.request({ type: 'GET_STATE' });
    const second = client.request({ type: 'PING' });
    ports[0].reply({ type: 'STATE_UPDATED' });
    ports[0].reply({ id: pending[1].id, result: { ok: true } });
    ports[0].reply({ id: pending[0].id, result: { notes: [] } });
    assert.deepEqual(JSON.parse(JSON.stringify(await first)), { notes: [] });
    assert.equal((await second).ok, true);
    assert.equal(notifications, 1);
    assert.equal(client.pending.size, 0);
  } finally { client.dispose(); }
});

test('a disconnected export reconnects with the same operation ID to prevent duplicate exports', async () => {
  const packets = [];
  const { client, ports } = setup((packet, port, attempt) => {
    packets.push(packet);
    queueMicrotask(() => attempt === 1 ? port.disconnect() : port.reply({ id: packet.id, result: { ok: true } }));
  });
  try {
    assert.equal((await client.request({ type: 'EXPORT_AUDIO', noteId: 'lecture' })).ok, true);
    assert.equal(ports.length, 2);
    assert.equal(packets[0].id, packets[1].id);
    assert.equal(packets[0].message.operationId, packets[1].message.operationId);
    assert.ok(packets[0].message.operationId);
  } finally { client.dispose(); }
});

test('missing replies retry once and fail explicitly without leaving pending timers', async () => {
  let sends = 0;
  const { client } = setup(() => { sends++; }, { timeout: 5 });
  try {
    await assert.rejects(client.request({ type: 'GET_STATE' }), error => error.transport === true);
    assert.equal(sends, 2);
    assert.equal(client.pending.size, 0);
  } finally { client.dispose(); }
});

test('an interrupted audio chunk is never blindly repeated', async () => {
  let sends = 0;
  const { client } = setup((packet, port) => { sends++; queueMicrotask(() => port.disconnect()); });
  try {
    await assert.rejects(client.request({ type: 'UPLOAD_CHUNK' }), error => error.transport === true);
    assert.equal(sends, 1);
  } finally { client.dispose(); }
});
