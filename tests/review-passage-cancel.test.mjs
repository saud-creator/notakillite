import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { runTool } from '../companion/audio.mjs';
import { CoreService } from '../core/service.mjs';
import { newDocument } from '../core/transcript-document.mjs';

test('a passage retry can be cancelled while its transcript is still loading', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notakillite-early-cancel-'));
  let core;
  t.after(async () => { await core?.close(); await rm(root, { recursive: true, force: true }); });
  core = await new CoreService({ dataRoot: root, connector: { async close() {} } }).init();
  core.jobs.push({ id: 'early-cancel', status: 'done' });
  let release;
  const loaded = new Promise(resolve => { release = resolve; });
  core.transcript = async () => loaded;
  const retry = core.handle('retryPassage', { id: 'early-cancel', revision: 0, segmentId: 'passage' });
  const rejected = assert.rejects(retry, { name: 'AbortError' });
  assert.deepEqual(await core.handle('cancelPassageRetry', { id: 'early-cancel' }), { cancelled: true });
  release({ revision: 0, segments: [{ id: 'passage', start: 0, end: 1 }] });
  await rejected;
  assert.equal(core.reviewRetry, null);
  assert.equal(core.reviewRetryJobId, null);
  assert.deepEqual(await readdir(core.paths.temp), []);
});

test('cancelling a passage retry aborts only its job and never creates a candidate', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notakillite-passage-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'synthetic.wav');
  await runTool(ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=4',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', original,
  ]);

  let started;
  const transcriberStarted = new Promise(resolve => { started = resolve; });
  let transcriberSignal;
  const core = await new CoreService({
    dataRoot: path.join(root, 'data'),
    connector: { async close() {} },
    transcribe: async ({ signal }) => {
      transcriberSignal = signal;
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('Synthetic passage transcription aborted.'), { name: 'AbortError' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        started();
      });
    },
  }).init();
  const id = 'synthetic-cancel-job';
  const document = newDocument({ duration: 4, quality: { status: 'ok' }, segments: [{ start: 0.5, end: 1.5, text: 'manual transcript stays' }] });
  core.jobs.push({ id, status: 'done', input: original, localFile: original, files: [], options: { chunkSeconds: 0, transcriber: 'local' }, pdfs: [] });
  await mkdir(path.join(core.paths.data, 'transcripts'), { recursive: true });
  const transcriptPath = path.join(core.paths.data, 'transcripts', `${id}.json`);
  await writeFile(transcriptPath, JSON.stringify(document));
  const before = await core.transcript(id);
  let retry;

  try {
    retry = core.handle('retryPassage', { id, revision: document.revision, segmentId: document.segments[0].id });
    let startTimeout;
    try {
      await Promise.race([
        transcriberStarted,
        new Promise((_, reject) => { startTimeout = setTimeout(() => reject(new Error('Synthetic transcriber did not start in time.')), 15000); }),
      ]);
    } finally { clearTimeout(startTimeout); }
    assert.ok(transcriberSignal, 'the fake transcriber received the active retry signal');

    assert.deepEqual(await core.handle('cancelPassageRetry', { id: 'another-job' }), { cancelled: false });
    assert.equal(transcriberSignal.aborted, false, 'a wrong-job cancel must not abort the active retry');
    assert.deepEqual(await core.handle('cancelPassageRetry', { id }), { cancelled: true });
    assert.equal(transcriberSignal.aborted, true);
    await assert.rejects(retry, /Synthetic passage transcription aborted/);

    assert.equal(core.reviewRetry, null, 'the active retry controller is cleared after settlement');
    assert.equal(core.reviewRetryJobId, null, 'the active retry job id is cleared after settlement');
    assert.deepEqual(await core.transcript(id), before, 'cancelled retry leaves the stored transcript untouched');
    assert.equal((await readdir(core.paths.temp)).some(name => name.startsWith('review-')), false, 'retry scratch audio is removed');
  } finally {
    if (core.reviewRetry) core.reviewRetry.abort();
    if (retry) await retry.catch(() => {});
    await core.close();
  }
});
