import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audioArguments, safeName } from '../companion/audio.mjs';

function wav(seconds = 2) {
  const rate = 16000;
  const length = Math.round(rate * seconds) * 2;
  const data = Buffer.alloc(44 + length);
  data.write('RIFF'); data.writeUInt32LE(36 + length, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(length, 40);
  for (let i = 0; i < length / 2; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 400 / rate) * 10000), 44 + i * 2);
  return data;
}

test('export settings preserve all audio and produce small speech MP3s', () => {
  const args = audioArguments('input.wav', 'output', { clean: true, splitMinutes: 20 });
  assert.ok(args.includes('highpass=f=80,lowpass=f=10000,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11'));
  assert.equal(args[args.indexOf('-segment_time') + 1], '1200');
  assert.ok(!args.includes('-t'), 'must not truncate a long lecture');
  assert.ok(!audioArguments('in', 'out', { clean: false, splitMinutes: 0 }).includes('-af'));
  assert.throws(() => audioArguments('in', 'out', { splitMinutes: -1 }));
  assert.equal(safeName('../../A: lecture?'), '..-..-A- lecture-');
});

test('real local HTTP transfer, authorization, FFmpeg cleanup, export and failure recovery', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notakillite-test-'));
  const port = 43287;
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['companion/server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, NOTAKILLITE_PORT: String(port), NOTAKILLITE_DATA_DIR: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    const resolved = path.resolve(directory);
    assert.ok(path.basename(resolved).startsWith('notakillite-test-') && path.dirname(resolved) === path.resolve(os.tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  });
  let ready;
  for (let i = 0; i < 100; i++) {
    try { ready = await fetch(`${base}/health`, { headers: { Origin: origin } }); if (ready.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready?.ok, output);
  const health = await ready.json();
  assert.equal(health.ready, true);
  assert.equal(typeof health.token, 'string');
  const publicHealth = await (await fetch(`${base}/health`)).json();
  assert.equal(publicHealth.token, undefined);
  assert.equal((await fetch(`${base}/health`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', body: '{}' })).status, 401);
  const headers = { Origin: origin, 'X-Notakillite-Token': health.token };
  const create = async (title = 'Physics lecture') => {
    const response = await fetch(`${base}/jobs`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title, recordingName: 'Lecture 1', clean: true, splitMinutes: 20 }) });
    assert.equal(response.status, 201);
    return response.json();
  };
  const job = await create();
  const audio = wav();
  assert.equal((await fetch(`${base}/jobs/${job.id}/audio`, { method: 'PUT', headers: { ...headers, 'X-Chunk-Offset': '99' }, body: audio })).status, 409);
  for (let offset = 0; offset < audio.length; offset += 20000) {
    const response = await fetch(`${base}/jobs/${job.id}/audio`, { method: 'PUT', headers: { ...headers, 'X-Chunk-Offset': String(offset) }, body: audio.subarray(offset, offset + 20000) });
    assert.equal(response.status, 200);
  }
  assert.equal((await fetch(`${base}/jobs/${job.id}/process`, { method: 'POST', headers })).status, 202);
  let result;
  for (let i = 0; i < 200; i++) {
    result = await (await fetch(`${base}/jobs/${job.id}`, { headers })).json();
    if (['done', 'error'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(result.status, 'done', result.error);
  assert.equal(result.files.length, 1);
  const mp3 = await fetch(result.files[0].url);
  assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
  assert.ok((await mp3.arrayBuffer()).byteLength > 1000);
  const exportedDirectory = path.join(directory, 'exports', (await readdir(path.join(directory, 'exports')))[0]);
  const manifest = JSON.parse(await readFile(path.join(exportedDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.title, 'Physics lecture');
  assert.equal(manifest.speechCleanup, true);
  assert.equal((await readdir(path.join(directory, '.local', 'uploads'))).length, 0);
  const broken = await create('Corrupt audio');
  await fetch(`${base}/jobs/${broken.id}/audio`, { method: 'PUT', headers: { ...headers, 'X-Chunk-Offset': '0' }, body: 'This is not an audio file.' });
  await fetch(`${base}/jobs/${broken.id}/process`, { method: 'POST', headers });
  for (let i = 0; i < 100; i++) {
    result = await (await fetch(`${base}/jobs/${broken.id}`, { headers })).json();
    if (result.status === 'error') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(result.status, 'error');
  assert.equal((await readdir(path.join(directory, '.local', 'uploads'))).length, 0);
  assert.equal((await fetch(`${base}/files/${job.id}/..%2F..%2Fpackage.json`, { headers })).status, 404);
});
