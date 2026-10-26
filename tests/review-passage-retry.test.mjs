import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'ffmpeg-static';
import { runTool } from '../companion/audio.mjs';
import { wavSamples } from '../companion/engines.mjs';
import { CoreService } from '../core/service.mjs';
import { newDocument } from '../core/transcript-document.mjs';

const tone = async (file, frequency, duration) => runTool(ffmpeg, [
  '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=16000:duration=${duration}`,
  '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', file,
]);

function estimateFrequency(wav) {
  const bytes = wav.subarray(wav.indexOf('data') + 8);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  let crossings = 0;
  const start = Math.floor(samples.length * 0.1), end = Math.floor(samples.length * 0.9);
  for (let i = start + 1; i < end; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
  return crossings / ((end - start) / 16000);
}

test('passage retry assembles split output at absolute times and rejects a missing part without editing the transcript', async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.local', 'passage-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'parts'); await mkdir(output);
  const first = path.join(output, 'lecture-000.mp3'), second = path.join(output, 'lecture-001.mp3');
  const firstWav = path.join(root, 'first.wav'), secondWav = path.join(root, 'second.wav');
  await tone(firstWav, 440, 4); await tone(secondWav, 880, 6);
  await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', firstWav, '-c:a', 'libmp3lame', '-b:a', '64k', first]);
  await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', secondWav, '-c:a', 'libmp3lame', '-b:a', '64k', second]);
  const original = path.join(root, 'original.wav'); await tone(original, 1320, 10);

  const transcribed = [];
  const core = await new CoreService({ dataRoot: path.join(root, 'data'), connector: { async close() {} }, transcribe: async ({ inputs, options }) => {
    assert.equal(inputs.length, 1);
    const bytes = await readFile(inputs[0]); transcribed.push({ seconds: (await wavSamples(inputs[0])) / 16000, frequency: estimateFrequency(bytes), options });
    return { segments: [{ start: 0, end: 1, text: 'candidate' }], quality: { status: 'ok' } };
  } }).init();
  const id = 'split-remote-job';
  const document = newDocument({ duration: 10, quality: { status: 'ok' }, segments: [{ start: 3.5, end: 4.5, text: 'keep this text' }] });
  const job = { id, status: 'done', input: null, localFile: null, files: [
    { kind: 'audio', name: path.basename(first), path: first }, { kind: 'audio', name: path.basename(second), path: second },
  ], options: { splitMinutes: 10, chunkSeconds: 0, transcriber: 'local' }, pdfs: [] };
  core.jobs.push(job);
  await mkdir(path.join(core.paths.data, 'transcripts'), { recursive: true });
  await writeFile(path.join(core.paths.data, 'transcripts', `${id}.json`), JSON.stringify(document));
  try {
    await assert.rejects(core.handle('retryPassage', { id, revision: 2, segmentId: document.segments[0].id }), /Transcript changed/);
    assert.equal(transcribed.length, 0, 'stale revisions must fail before any audio work');
    const crossing = await core.handle('retryPassage', { id, revision: 1, segmentId: document.segments[0].id });
    assert.equal(crossing.candidateOnly, true);
    assert.equal(crossing.revision, 1);
    assert.ok(Math.abs(transcribed[0].seconds - 1) < 0.15, `expected a one-second passage across the chunk boundary, got ${transcribed[0].seconds}s`);
    assert.ok(transcribed[0].frequency > 550 && transcribed[0].frequency < 770, 'the boundary passage must contain audio from both parts');
    assert.equal(transcribed[0].options.chunkSeconds, 0);

    document.segments[0].start = 5; document.segments[0].end = 6;
    await writeFile(path.join(core.paths.data, 'transcripts', `${id}.json`), JSON.stringify(document));
    await core.handle('retryPassage', { id, revision: 1, segmentId: document.segments[0].id });
    assert.ok(Math.abs(transcribed[1].seconds - 1) < .15);
    assert.ok(transcribed[1].frequency > 830 && transcribed[1].frequency < 930, 'a later global timestamp must read the second part');

    job.input = original;
    await core.handle('retryPassage', { id, revision: 1, segmentId: document.segments[0].id });
    assert.ok(transcribed[2].frequency > 1100, `expected the retained original source, got about ${transcribed[2].frequency} Hz`);

    job.input = null; job.files[1].path = path.join(output, 'missing-part.mp3');
    const before = await core.transcript(id);
    await assert.rejects(core.handle('retryPassage', { id, revision: 1, segmentId: document.segments[0].id }), /audio part.*unavailable/i);
    assert.deepEqual(await core.transcript(id), before);
    assert.equal(transcribed.length, 3, 'a missing part must fail before transcription');
  } finally { await core.close(); }
});
