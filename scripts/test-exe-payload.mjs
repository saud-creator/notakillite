import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runTool } from '../companion/audio.mjs';

const app = (await readFile('.local/exe-smoke/verification.txt', 'utf8')).trim().split(/\r?\n/).at(-1);
const data = path.resolve('.local/exe-smoke/audio-test');
const base = 'http://127.0.0.1:43289';
const headers = { Origin: `chrome-extension://${'a'.repeat(32)}` };
const child = spawn(path.join(app, 'runtime', 'node.exe'), ['companion/server.mjs'], { cwd: app, windowsHide: true, env: { ...process.env, NOTAKILLITE_PORT: '43289', NOTAKILLITE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', bytes => { log += bytes; });
child.stderr.on('data', bytes => { log += bytes; });
try {
  let health;
  for (let i = 0; i < 100; i++) {
    try { health = await (await fetch(`${base}/health`, { method: 'POST', headers })).json(); if (health.ready) break; } catch {}
    if (child.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.ready, true, log);
  headers['X-Notakillite-Token'] = health.token;
  assert.equal(health.version, '0.3.0');
  assert.deepEqual(health.engines, { classic: true, rnnoise: true, deepfilter: true, hybrid: true });
  const job = await (await fetch(`${base}/jobs`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Packaged EXE verification', recordingName: 'Generated test tone', clean: true, splitMinutes: 0 }) })).json();
  assert.ok(job.id);
  const bytes = 16000 * 2 * 2;
  const wave = Buffer.alloc(44 + bytes);
  wave.write('RIFF'); wave.writeUInt32LE(bytes + 36, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes / 2; i++) wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 5000), 44 + i * 2);
  assert.equal((await fetch(`${base}/jobs/${job.id}/audio`, { method: 'PUT', headers: { ...headers, 'X-Chunk-Offset': '0' }, body: wave })).status, 200);
  assert.equal((await fetch(`${base}/jobs/${job.id}/process`, { method: 'POST', headers })).status, 202);
  let result;
  for (let i = 0; i < 100; i++) {
    result = await (await fetch(`${base}/jobs/${job.id}`, { headers })).json();
    if (['done', 'error'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(result.status, 'done', result.error);
  assert.ok((await (await fetch(result.files[0].url)).arrayBuffer()).byteLength > 1000);
  const m4a = path.join(data, 'packaged-apple.m4a');
  await runTool(path.join(app, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.137:sample_rate=44100', '-c:a', 'aac', m4a]);
  const m4aBytes = await readFile(m4a);
  for (const engine of ['rnnoise', 'deepfilter', 'hybrid']) {
    const created = await (await fetch(`${base}/jobs`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Packaged neural engine verification', recordingName: `${engine} Apple M4A`, clean: true, engine, strength: 'balanced', splitMinutes: 0 }) })).json();
    assert.ok(created.id);
    assert.equal((await fetch(`${base}/jobs/${created.id}/audio`, { method: 'PUT', headers: { ...headers, 'X-Chunk-Offset': '0' }, body: m4aBytes })).status, 200);
    assert.equal((await fetch(`${base}/jobs/${created.id}/process`, { method: 'POST', headers })).status, 202);
    let processed;
    for (let i = 0; i < 300; i++) {
      processed = await (await fetch(`${base}/jobs/${created.id}`, { headers })).json();
      if (['done', 'error'].includes(processed.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(processed.status, 'done', `${engine}: ${processed.error}`);
    assert.ok((await (await fetch(processed.files[0].url)).arrayBuffer()).byteLength > 1000);
  }
  const pe = await readFile('release/Notakillite.exe');
  assert.equal(pe.toString('ascii', 0, 2), 'MZ');
  assert.equal(pe.toString('ascii', pe.readUInt32LE(0x3c), pe.readUInt32LE(0x3c) + 4), 'PE\x00\x00');
  console.log(JSON.stringify({ exe: 'release/Notakillite.exe', bytes: (await stat('release/Notakillite.exe')).size, extraction: 'passed', bundledNode: 'passed', bundledFFmpeg: 'passed', packagedProcessorMp3Export: 'passed', bundledRNNoiseM4a: 'passed', bundledDeepFilterNetM4a: 'passed', bundledHybridM4a: 'passed' }));
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
}
