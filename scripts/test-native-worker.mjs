// Real native-worker acceptance. Uses generated public test speech; never prints transcripts.
// node scripts/test-native-worker.mjs <worker.exe> [report.json]
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'ffmpeg-static';
import { runTool } from '../companion/audio.mjs';
import { WhisperWorker } from '../companion/persistent-whisper.mjs';
import { modelPath, verifiedModel, WHISPER_MODELS } from '../companion/whisper.mjs';
import { hashFile } from '../core/artifacts.mjs';

const [workerArgument, reportArgument = '.local/native-worker-report.json'] = process.argv.slice(2);
if (!workerArgument) throw new Error('Supply the built native worker executable; CLI fallback is not tested here.');
const execute = promisify(execFile), root = process.cwd(), program = path.resolve(workerArgument);
const model = modelPath(process.env.NOTAKILLITE_MODELS_DIR || path.join(root, '.local/models'), 'tiny');
assert.ok(await verifiedModel(model, WHISPER_MODELS.tiny), 'Install the pinned Tiny model before this offline test.');
const local = path.join(root, '.local'); await mkdir(local, { recursive: true });
const directory = await mkdtemp(path.join(local, "native-worker QA العربية ' "));
const unicodeModel = path.join(directory, "tiny's model.bin"), wav = path.join(directory, 'spoken العربية.wav');
await copyFile(model, unicodeModel);
await runTool(ffmpeg, ['-y', '-i', path.join(root, 'tests/fixtures/spoken-lecture.wav'), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
const worker = new WhisperWorker(program, unicodeModel, true);
const report = { commit: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), dirty: Boolean((await execute('git', ['status', '--porcelain'])).stdout.trim()), platform: process.platform, os: os.release(), node: process.version, workerSha256: await hashFile(program), modelSha256: WHISPER_MODELS.tiny.sha256, backend: 'cpu', runs: [], measurementScope: 'Native worker peak working set only; excludes the rest of the application.' };
report.libraries = await Promise.all((await readdir(path.dirname(program))).filter(name => /\.dll$/i.test(name)).sort().map(async name => ({ name, sha256: await hashFile(path.join(path.dirname(program), name)) })));
async function exitedWithin(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try { await Promise.race([once(child, 'exit'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native worker did not exit within the cancellation budget.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
try {
  const cold = performance.now();
  const tokens = await worker.request({ type: 'tokenize', text: 'inguinal ligament' }, AbortSignal.timeout(30000));
  report.coldLoadAndTokenizeMs = performance.now() - cold;
  assert.ok(tokens.tokens > 0 && tokens.tokens <= 96);
  const loadedChild = worker.child;
  for (let repeat = 0; repeat < 2; repeat++) {
    const started = performance.now();
    const result = await worker.request({ file: wav, language: 'en', prompt: 'inguinal ligament', threads: 4 }, AbortSignal.timeout(30000));
    assert.equal(worker.child, loadedChild, 'Warm inference must retain the same model process.');
    assert.equal(result.device, 'CPU'); assert.ok(result.segments.length > 0);
    assert.ok(result.segments.every(s => Number.isFinite(s.start) && s.end >= s.start && typeof s.text === 'string'));
    assert.ok(result.promptTokens > 0 && result.promptTokens <= 96);
    assert.ok(result.nativeMetrics.workerPeakRssBytes > 0);
    report.runs.push({ repeat, wallMs: performance.now() - started, segments: result.segments.length, promptTokens: result.promptTokens, ...result.nativeMetrics });
  }
  await assert.rejects(worker.request({ file: wav, language: 'en', prompt: 'anatomy '.repeat(300), threads: 4 }), /Vocabulary exceeds/);
  assert.ok((await worker.request({ type: 'tokenize', text: 'still ready' })).tokens > 0);
  const longWav = path.join(directory, 'cancel.wav');
  await runTool(ffmpeg, ['-y', '-stream_loop', '-1', '-i', wav, '-t', '60', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', longWav]);
  const controller = new AbortController(), child = worker.child;
  const pending = worker.request({ file: longWav, language: 'en', threads: 4 }, controller.signal);
  // Allow the request to reach the native process before cancelling it.
  await new Promise(resolve => setTimeout(resolve, 100));
  const cancelledAt = performance.now(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); await exitedWithin(child, 5000);
  report.cancellationMs = performance.now() - cancelledAt;
  assert.ok((await worker.request({ type: 'tokenize', text: 'restart' }, AbortSignal.timeout(30000))).tokens > 0);
  assert.notEqual(worker.child, loadedChild);
  Object.assign(report, { result: 'passed', unicodePaths: 'passed', retainedModel: 'passed', tokenizerBudget: 'passed', cancellationAndRestart: 'passed' });
  await mkdir(path.dirname(path.resolve(reportArgument)), { recursive: true });
  await writeFile(reportArgument, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  const child = worker.child; worker.close();
  if (child) await exitedWithin(child, 5000);
  await rm(directory, { recursive: true, force: true });
}
