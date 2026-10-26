import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeWorkers } from '../companion/persistent-whisper.mjs';
import { transcribeLocal, vadModel, whisperPass } from '../companion/whisper.mjs';

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notakillite-vad-'));
  t.after(async () => { closeWorkers(); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

function nativeWorkerSource() {
  return `import { createInterface } from 'node:readline';
const mode=process.env.NOTAKILLITE_TEST_VAD_WORKER||'valid';
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  const result=request.type==='tokenize'?{tokens:1}:{segments:[],language:'en',device:'CPU',backendName:'CPU',deviceName:'mock worker',promptTokens:0,nativeMetrics:{workerPeakRssBytes:1,inferenceMs:1},...(mode==='valid'?{vadApplied:request.vad===true,vadSegments:request.vad?1:0}:{})};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});`;
}

async function cliOutput(args) {
  const output = args[args.indexOf('-of') + 1];
  await writeFile(`${output}.json`, JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: ' ok' }] }));
  return { code: 0, stderr: '', build: 'cpu' };
}

test('persistent worker defaults to VAD off and applies an explicit VAD retry on the retained process', async t => {
  const dir = await workspace(t), model = path.join(dir, 'mock-worker.mjs');
  await writeFile(model, nativeWorkerSource());
  const oldWorker = process.env.NOTAKILLITE_WORKER, oldMode = process.env.NOTAKILLITE_TEST_VAD_WORKER;
  process.env.NOTAKILLITE_WORKER = process.execPath;
  process.env.NOTAKILLITE_TEST_VAD_WORKER = 'valid';
  try {
    const common = { modelFile: model, wav: 'generated-padded-speech.wav', language: 'en', prompt: '', work: dir, production: true, runner: cliOutput };
    const initial = await whisperPass(common);
    assert.equal(initial.persistent, true);
    assert.equal(initial.vadApplied, false);
    assert.equal(initial.vadSegments, 0);
    const retry = await whisperPass({ ...common, vad: true });
    assert.equal(retry.persistent, true);
    assert.equal(retry.vadApplied, true);
    assert.equal(retry.vadSegments, 1);
  } finally {
    closeWorkers();
    if (oldWorker === undefined) delete process.env.NOTAKILLITE_WORKER; else process.env.NOTAKILLITE_WORKER = oldWorker;
    if (oldMode === undefined) delete process.env.NOTAKILLITE_TEST_VAD_WORKER; else process.env.NOTAKILLITE_TEST_VAD_WORKER = oldMode;
  }
});

test('unsupported worker evidence falls back to CLI with its actual default or explicit VAD setting', async t => {
  const dir = await workspace(t), model = path.join(dir, 'mock-worker.mjs');
  await writeFile(model, nativeWorkerSource());
  const oldWorker = process.env.NOTAKILLITE_WORKER, oldMode = process.env.NOTAKILLITE_TEST_VAD_WORKER;
  process.env.NOTAKILLITE_WORKER = process.execPath;
  process.env.NOTAKILLITE_TEST_VAD_WORKER = 'unsupported';
  const calls = [];
  const runner = async args => { calls.push(args); return cliOutput(args); };
  try {
    const common = { modelFile: model, wav: 'generated-padded-speech.wav', language: 'en', prompt: '', work: dir, production: true, runner };
    const defaultCli = await whisperPass(common);
    assert.equal(defaultCli.persistent, undefined);
    assert.equal(defaultCli.vadApplied, true);
    assert.ok(calls[0].includes('--vad'));
    const explicitOff = await whisperPass({ ...common, vad: false });
    assert.equal(explicitOff.vadApplied, false);
    assert.ok(!calls[1].includes('--vad'));
  } finally {
    closeWorkers();
    if (oldWorker === undefined) delete process.env.NOTAKILLITE_WORKER; else process.env.NOTAKILLITE_WORKER = oldWorker;
    if (oldMode === undefined) delete process.env.NOTAKILLITE_TEST_VAD_WORKER; else process.env.NOTAKILLITE_TEST_VAD_WORKER = oldMode;
  }
});

test('CLI VAD error retry reports VAD off, and transcribe settings record applied CLI defaults', async t => {
  const dir = await workspace(t), model = path.join(dir, 'not-installed.bin');
  const oldWorker = process.env.NOTAKILLITE_WORKER;
  process.env.NOTAKILLITE_WORKER = path.join(dir, 'missing-worker.exe');
  const calls = [];
  const retryRunner = async args => {
    calls.push(args);
    if (args.includes('--vad')) throw new Error('mock CLI cannot load VAD');
    return cliOutput(args);
  };
  try {
    const fallback = await whisperPass({ modelFile: model, wav: 'generated-padded-speech.wav', language: 'en', work: dir, runner: retryRunner, production: true });
    assert.equal(fallback.vadApplied, false);
    assert.equal(fallback.fallback, 'voice-detector-disabled-after-error');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('--vad'));
    assert.ok(!calls[1].includes('--vad'));

    if (!(await access(vadModel).then(() => true, () => false))) return t.skip('VAD asset is not installed');
    const defaults = await transcribeLocal({
      ffmpeg: 'unused', wav: 'generated-padded-speech.wav', duration: 1, model: 'tiny', language: 'en',
      modelsDir: dir, work: dir, threads: 1, modelResolver: async () => model,
      runner: cliOutput,
    });
    assert.equal(defaults.settings.vad, true, 'CLI initial-pass settings must reflect its default VAD-on behavior.');
  } finally {
    closeWorkers();
    if (oldWorker === undefined) delete process.env.NOTAKILLITE_WORKER; else process.env.NOTAKILLITE_WORKER = oldWorker;
  }
});
