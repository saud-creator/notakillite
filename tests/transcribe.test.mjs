import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { runTool } from '../companion/audio.mjs';
import { transcribeGroq } from '../companion/groq.mjs';
import { whisperBuilds } from '../companion/whisper.mjs';
import { CoreService } from '../core/service.mjs';

const speech = fileURLToPath(new URL('./fixtures/spoken-lecture.wav', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
async function directory(t, prefix) { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function wait(probe, timeout) { const until = Date.now() + timeout; while (Date.now() < until) { const value = await probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 200)); } throw new Error('Timed out.'); }
const noBrowser = () => ({ async close() {}, async state() { throw new Error('Not connected'); } });
const whisperInstalled = await Promise.any(whisperBuilds.map(build => access(build.program))).then(() => true, () => false);

test('Groq transcription uploads 10-minute parts, retries rate limits and offsets timestamps', { timeout: 120000 }, async t => {
  const work = await directory(t, 'notakillite-groq-');
  const wav = path.join(work, 'long.wav');
  await runTool(ffmpeg, ['-y', '-stream_loop', '-1', '-i', speech, '-t', '1500', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, auth: request.headers.Authorization, language: request.body.get('language'), model: request.body.get('model'), bytes: request.body.get('file').size });
    if (calls.length === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    return Response.json({ language: 'English', segments: [{ start: 1, end: 3, text: ` part ${calls.length}` }] });
  };
  const result = await transcribeGroq({ ffmpeg, wav, duration: 1500, key: 'gsk_test', work, runTool, fetchImpl });
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(calls[0].auth, 'Bearer gsk_test');
  assert.equal(calls[0].model, 'whisper-large-v3-turbo');
  assert.equal(calls[0].language, null);
  assert.ok(calls.every(call => call.bytes < 24 * 1024 * 1024));
  assert.equal(result.segments.length, calls.length - 1);
  assert.equal(result.segments[0].start, 1);
  assert.ok(result.segments[1].start > 500 && result.segments[1].start < 700, String(result.segments[1].start));
  assert.equal(result.language, 'en');
  assert.deepEqual(await readdir(work), ['long.wav']);
  await assert.rejects(transcribeGroq({ ffmpeg, wav, duration: 1500, key: 'bad', work, runTool, fetchImpl: async () => new Response('', { status: 401 }) }), /rejected the API key/);
  await assert.rejects(transcribeGroq({ ffmpeg, wav, duration: 1500, key: '', work, runTool }), /Groq API key/);
});

test('cleaned audio is transcribed locally with Whisper into numbered Markdown and an index', { timeout: 600000, skip: !whisperInstalled && 'whisper.cpp is not installed (npm run install:engines)' }, async t => {
  process.env.NOTAKILLITE_MODELS_DIR ||= path.join(root, '.local', 'models');
  const work = await directory(t, 'notakillite-whisper-');
  const lecture = path.join(work, 'Abdominal wall.m4a');
  await runTool(ffmpeg, ['-y', '-i', speech, '-c:a', 'aac', lecture]);
  const service = await new CoreService({ dataRoot: path.join(work, 'data'), connector: noBrowser() }).init();
  try {
    const { ids } = await service.enqueue({ files: [lecture], engine: 'rnnoise', splitMinutes: 0, transcribe: true, transcriber: 'local', model: 'tiny', language: 'auto' });
    const job = await wait(() => { const job = service.jobs.find(item => item.id === ids[0]); return ['done', 'error'].includes(job.status) && job; }, 580000);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(job.files.map(file => file.name), ['01 - Abdominal wall.mp3', '01 - Abdominal wall.md']);
    const markdown = await readFile(job.transcriptPath, 'utf8');
    assert.match(markdown, /title: "Abdominal wall"/);
    assert.match(markdown, /noise_cleanup: "RNNoise"/);
    assert.match(markdown, /language: "English"/);
    assert.match(markdown, /\*\*\[00:00:0\d\]\*\* .*abdominal wall/i);
    assert.ok(job.transcript.words > 10);
    const index = await readFile(path.join(job.destination, '00 - Index.md'), 'utf8');
    assert.match(index, /\[01 - Abdominal wall\.md\]/);
    assert.deepEqual(await readdir(service.paths.temp), []);
  } finally { await service.close(); }
});
