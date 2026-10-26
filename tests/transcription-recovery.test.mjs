// P0 regression tests: the transcription pipeline never feeds decoded text back, re-transcribes only
// failing parts from source audio, keeps neighbours intact, and always terminates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { runTool } from '../companion/audio.mjs';
import { wavSamples } from '../companion/engines.mjs';
import { transcribeAudio, RECOVERY } from '../companion/transcribe.mjs';
import { WHISPER_MODELS, modelPath, vadModel } from '../companion/whisper.mjs';
import { auditTranscript } from '../companion/transcript-quality.mjs';
import { lectureMarkdown, indexMarkdown } from '../companion/transcript-format.mjs';
import { CoreService } from '../core/service.mjs';
import { lecture, rng } from './fixtures/lecture.mjs';

const speech = fileURLToPath(new URL('./fixtures/spoken-lecture.wav', import.meta.url));
const LOOP = 'So deep membranous fascia is called fascia of the thigh.';
const vadInstalled = await open(vadModel).then(h => h.close().then(() => true), () => false);

async function setup(t, minutes = 16) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'notakillite-recovery-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  // Continuous "speech" (the fixture looped) so the silence map and piece cuts are real.
  const audio = path.join(work, 'lecture.wav');
  await runTool(ffmpeg, ['-y', '-stream_loop', '-1', '-i', speech, '-t', String(minutes * 60), '-ac', '1', '-ar', '16000', audio]);
  const models = path.join(work, 'models');
  await mkdir(models);
  const handle = await open(modelPath(models, 'tiny'), 'w'); await handle.truncate(WHISPER_MODELS.tiny.bytes); await handle.close(); // size-only stand-in
  const jobWork = path.join(work, 'job'); await mkdir(jobWork);
  return { work, audio, models, jobWork };
}

/** Stand-in for whisper-cli: writes JSON for the audio it was given, per `behave`. */
function mockWhisper(behave) {
  const calls = [];
  const runner = async (args, { only } = {}) => {
    calls.push({ args, only });
    if (args.includes('-dl')) return { code: 0, stderr: 'whisper_full_with_state: auto-detected language: en (p = 0.97)', build: only || 'gpu' };
    const wav = args[args.indexOf('-f') + 1], out = args[args.indexOf('-of') + 1];
    const duration = await wavSamples(wav) / 16000;
    const segments = behave({ args, duration, call: calls.length, only, file: path.basename(wav) });
    await writeFile(`${out}.json`, JSON.stringify({ result: { language: 'en' }, transcription: segments.map(s => ({ offsets: { from: Math.round(s.start * 1000), to: Math.round(s.end * 1000) }, text: ` ${s.text}` })) }));
    return { code: 0, stderr: '', build: only || 'gpu' };
  };
  return { runner, calls };
}
const normal = (duration, seed = 1) => lecture({ to: duration, seed });
const looping = (duration, from = 0) => [...normal(Math.min(from, duration), 2), ...Array.from({ length: Math.floor((duration - from) / 2.3) }, (_, i) => ({ start: from + i * 2.3, end: from + i * 2.3 + 2.2, text: LOOP }))];
const options = { transcriber: 'local', model: 'tiny', language: 'en', vocabulary: '', chunkSeconds: 0 };
const run = (ctx, runner, extra = {}) => transcribeAudio({ ffmpeg, inputs: [ctx.audio], originalInputs: [ctx.audio], work: ctx.jobWork, options, modelsDir: ctx.models, modelResolver: async (name,dir) => modelPath(dir,name), runner, ...extra });

test('decoded text is never fed back: every Whisper run uses -mc 0 or a prompt-only context budget', { skip: !vadInstalled && 'vendor/whisper not installed' }, async t => {
  const ctx = await setup(t, 6);
  // A decoder that loops only when it receives its own previous text (whisper.cpp's default).
  const { runner, calls } = mockWhisper(({ args, duration }) => args.includes('-mc') && args[args.indexOf('-mc') + 1] === '0' ? normal(duration) : looping(duration, 60));
  const result = await run(ctx, runner);
  assert.equal(result.quality.status, 'ok');
  for (const { args } of calls.filter(c => !c.args.includes('-dl'))) {
    assert.ok(args.includes('-mc'), 'context limit always set');
    assert.ok(!args.includes('-ot') && !args.includes('-d'), 'intervals are cut, never offset');
  }
  const vocab = await run(ctx, mockWhisper(({ duration }) => normal(duration)).runner, { options: { ...options, vocabulary: 'pyramidalis iliohypogastric' } });
  assert.equal(vocab.quality.status, 'ok');
});

test('the local speech-detection retry toggles the CLI VAD flag from the reported initial setting', { skip: !vadInstalled && 'vendor/whisper not installed' }, async t => {
  const ctx = await setup(t, 6), log = [];
  const { runner, calls } = mockWhisper(({ duration, call }) => call === 1 ? looping(duration, 60) : normal(duration, 70 + call));
  const result = await run(ctx, runner, { log: event => log.push(event) });
  assert.equal(log.find(event => event.event === 'decode')?.settings.vad, true, 'CLI initial-pass settings report VAD on.');
  assert.ok(calls[0].args.includes('--vad'), 'the initial CLI pass uses its VAD-on default.');
  assert.ok(result.quality.attempts.some(attempt => attempt.strategy === 'voice-detection-toggled'), JSON.stringify(result.quality.attempts));
  const toggleIndex = calls.findIndex(call => !call.args.includes('--vad'));
  assert.ok(toggleIndex > 0, 'the VAD retry removes --vad after observing an initial VAD-on CLI pass.');
});

test('a loop in the first pass is repaired from source audio; neighbouring parts stay unchanged', { skip: !vadInstalled && 'vendor/whisper not installed' }, async t => {
  const ctx = await setup(t, 16);
  const log = [];
  // First (full) pass loops from 6:00 to 9:00; any shorter re-transcription is clean.
  const { runner, calls } = mockWhisper(({ duration, call }) => {
    if (duration > 900) { const base = normal(duration); return [...base.filter(s => s.start < 360 || s.start >= 540), ...looping(540, 360).filter(s => s.start >= 360)].sort((a, b) => a.start - b.start); }
    return normal(duration, 100 + call);
  });
  const first = normal(960);
  const result = await run(ctx, runner, { log: e => log.push(e) });
  assert.equal(result.quality.status, 'repaired', JSON.stringify(result.quality));
  assert.ok(result.quality.repairs.length >= 1);
  assert.equal(result.segments.filter(s => s.text === LOOP).length, 0, JSON.stringify({left:result.segments.filter(s => s.text === LOOP), repairs:result.quality.repairs, attempts:result.quality.attempts}));
  // Text before the failing part is byte-identical to the first pass.
  const cutoff = Math.min(...result.quality.repairs.map(r => r.start));
  assert.ok(cutoff > 200, `first repaired part starts at ${cutoff}`);
  assert.deepEqual(result.segments.filter(s => s.start < cutoff).map(s => s.text), first.filter(s => s.start < cutoff).map(s => s.text));
  // Re-transcribed text sits inside the repaired interval with absolute timestamps, in order.
  for (const repair of result.quality.repairs) {
    const inside = result.segments.filter(s => s.start >= repair.start && s.start < repair.end);
    assert.ok(inside.length > 0 && inside.every(s => s.end <= repair.end + 1));
  }
  for (let i = 1; i < result.segments.length; i++) assert.ok(result.segments[i].start >= result.segments[i - 1].start);
  assert.equal(auditTranscript(result.segments, { duration: 960 }).status, 'ok');
  // Diagnostics: pieces with audio hashes, the audit, retries and the final verdict — but no text.
  assert.ok(log.some(e => e.event === 'pieces' && e.pieces.every(p => /^[0-9a-f]{16}$/.test(p.hash))));
  assert.ok(log.some(e => e.event === 'retry'));
  assert.equal(log.at(-1).event, 'quality');
  assert.ok(!JSON.stringify(log).includes('fascia of the thigh'), 'logs contain no transcript text');
  assert.ok(calls.length < 12);
});

test('a final-only repetition crossing a repaired window gets a timed marker without losing trusted neighbors', { skip: !vadInstalled && 'vendor/whisper not installed' }, async t => {
  const ctx = await setup(t, 6);
  const repeated = 'The conjoint tendon is formed by the internal oblique and transversus abdominis.';
  const before = 'This trusted statement remains before the flagged passage.';
  const after = 'This trusted statement remains after the flagged passage.';
  const { runner, calls } = mockWhisper(({ duration, file }) => {
    if (file !== 'speech-16k.wav') return [{ start: 0.5, end: 3, text: repeated }];
    return [...normal(duration, 31),
      { start: 100, end: 103, text: before },
      { start: 220, end: 223, text: repeated },
      { start: 235, end: 238, text: repeated },
      { start: 250, end: 250, text: 'first pass decoder glitch words here' },
      { start: 265, end: 268, text: repeated },
      { start: 320, end: 323, text: after },
    ].sort((a, b) => a.start - b.start);
  });
  const result = await run(ctx, runner);
  assert.equal(result.quality.status, 'needs-review');
  assert.ok(result.quality.attempts.length > 0 && result.quality.attempts.length <= RECOVERY.maxAttemptsPerPiece);
  assert.equal(result.quality.attempts[0].status, 'ok', 'the recovery candidate passes its local audit');
  assert.equal(result.quality.repairs.length, 1);
  assert.equal(result.quality.unresolved.length, 1, JSON.stringify(result.quality.unresolved));
  assert.ok(result.quality.unresolved[0].reasons.includes('repeated-sentence'), JSON.stringify(result.quality.unresolved));
  const marker = result.segments.find(s => s.marker && /Not reliably transcribed/.test(s.text));
  assert.ok(marker, 'final merged finding must have a visible review marker');
  assert.ok(marker.start <= 220 && marker.end >= 268, JSON.stringify({ marker, unresolved: result.quality.unresolved }));
  assert.match(marker.text, /repeated-sentence/);
  assert.match(marker.text, /\(\d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}\)/, 'the review marker has a visible time range');
  assert.ok(result.rawSegments.some(s => s.text === 'first pass decoder glitch words here'), 'raw ASR is retained');
  assert.ok(result.segments.some(s => !s.marker && s.text === before), 'trusted text before the flagged interval stays');
  assert.ok(result.segments.some(s => !s.marker && s.text === after), 'trusted text after the flagged interval stays');
  assert.ok(!result.quality.finalAudit.findings.some(f => f.kind === 'repeated-sentence'), 'the marker removes the untrusted repeated text from the exported transcript');
  assert.ok(calls.length <= 1 + RECOVERY.maxAttemptsPerPiece, `unexpected retries: ${calls.length}`);
});

test('retry exhaustion ends as needs-review with a visible marker and a bounded number of runs', { skip: !vadInstalled && 'vendor/whisper not installed' }, async t => {
  const ctx = await setup(t, 16);
  const { runner, calls } = mockWhisper(({ duration }) => looping(duration, Math.min(60, duration)));
  const result = await run(ctx, runner);
  assert.equal(result.quality.status, 'needs-review');
  assert.ok(result.quality.unresolved.length >= 1);
  const markers = result.segments.filter(s => s.marker);
  assert.ok(markers.length >= 1 && markers.every(m => /Not reliably transcribed/.test(m.text)));
  assert.ok(!auditTranscript(result.segments.filter(s=>!s.marker), {duration:960}).findings.some(f=>['repeated-sentence','internal-repetition','low-diversity'].includes(f.kind)), 'a repeated decoder loop is not exported; an isolated ordinary sentence is allowed');
  const pieces = Math.ceil(960 / RECOVERY.pieceSeconds) + 1;
  assert.ok(calls.length <= 1 + pieces * (RECOVERY.maxAttemptsPerPiece + 1), `${calls.length} runs`);
  const markdown = lectureMarkdown({ title: 'T', recording: 'R', sourceFile: 'S', duration: 960, cleanup: 'DeepFilterNet3', transcript: { ...result, model: 'Whisper tiny' }, quality: result.quality });
  assert.match(markdown, /quality: "needs review — \d+ parts? could not be transcribed reliably"/);
  assert.match(markdown, /> ⚠ \*\*Needs review:\*\*/);
  assert.match(markdown, /> ⚠ \*\*\[00:\d\d:\d\d–00:\d\d:\d\d\]\*\* Not reliably transcribed/);
  assert.match(indexMarkdown({ title: 'I', lectures: [{ number: 1, title: 'T', duration: 960, words: 1, quality: 'needs-review', transcript: '01 - T.md' }] }), /\| ⚠ needs review \|/);
});

test('original audio is tried when the cleaned audio keeps failing, and the better result wins', { skip: !vadInstalled && 'vendor/whisper not installed' }, async t => {
  const ctx = await setup(t, 12);
  const original = path.join(ctx.work, 'original.wav');
  await runTool(ffmpeg, ['-y', '-i', ctx.audio, '-af', 'volume=0.9', original]);
  // Cleaned audio always loops; anything cut from the original audio transcribes cleanly.
  const { runner, calls } = mockWhisper(({ duration, file }) => file.includes('-original') ? normal(duration, 7) : looping(duration, 30));
  const result = await transcribeAudio({ ffmpeg, inputs: [ctx.audio], originalInputs: [original], work: ctx.jobWork, options, modelsDir: ctx.models, modelResolver: async (name,dir) => modelPath(dir,name), runner });
  assert.ok(calls.some(c => c.args.some(a => a.includes('-original'))), 'a retry used the original audio: ' + JSON.stringify(result.quality.attempts));
  assert.ok(result.quality.repairs.some(r => r.strategy === 'original-audio'), JSON.stringify(result.quality.attempts));
  assert.ok((await readdir(ctx.jobWork)).includes('original-16k.wav'), 'the original audio is decoded for recovery');
});

test('the quality gate: a needs-review transcript is not "Ready for AI", keeps its source, and retries from the original', { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notakillite-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'Lecture 1.m4a');
  await runTool(ffmpeg, ['-y', '-i', speech, '-c:a', 'aac', input]);
  const quality = { status: 'needs-review', repairs: [], unresolved: [{ start: 2, end: 6, reasons: ['repeated-sentence'] }], attempts: [], findings: [] };
  const fake = async ({ options: o }) => ({ language: 'en', model: 'Whisper tiny', device: 'GPU', engine: 'local', duration: 10,
    segments: [{ start: 0, end: 2, text: 'Hello class.' }, { start: 2, end: 6, marker: true, text: 'Not reliably transcribed (00:00:02–00:00:06) — check the audio.' }], quality: o.transcribeFrom === 'original' ? { ...quality, status: 'ok', unresolved: [] } : quality });
  const service = await new CoreService({ dataRoot: path.join(root, 'data'), connector: { async close() {}, async state() { throw new Error('offline'); } }, transcribe: fake }).init();
  try {
    service.engines.whisper = true;
    const { ids } = await service.enqueue({ files: [input], engine: 'none', splitMinutes: 0, transcribe: true, transcriber: 'local', model: 'tiny' });
    const wait = async status => { for (let i = 0; i < 300; i++) { const job = service.jobs.find(j => j.id === ids[0]); if (job.status === status) return job; await new Promise(r => setTimeout(r, 100)); } throw new Error(`never ${status}: ${service.jobs[0].status} ${service.jobs[0].error}`); };
    let job = await wait('needs-review');
    assert.match(job.phase, /Needs review · 1 part could not be transcribed reliably/);
    assert.ok(job.input, 'source audio kept for retry');
    assert.match(await readFile(job.transcriptPath, 'utf8'), /quality: "needs review/);
    assert.match(await readFile(path.join(job.destination, '00 - Index.md'), 'utf8'), /⚠ needs review/);
    await service.retry(job.id);
    job = await wait('done');
    assert.equal(job.options.transcribeFrom, 'original');
    assert.match(job.phase, /^Ready for AI/);
    assert.match(await readFile(job.transcriptPath, 'utf8'), /quality: "ok — passed the automatic quality check"/);
    const log = await service.diagnostics(job.id);
    assert.equal(typeof log.text, 'string');
  } finally { await service.close(); }
});

test('every case terminates within the recovery budget, even with an engine that always fails', { skip: !vadInstalled && 'vendor/whisper not installed' }, async t => {
  const ctx = await setup(t, 30);
  let runs = 0;
  const random = rng(5);
  const { runner } = mockWhisper(({ duration }) => { runs++; if (runs > 1 && random() < 0.3) throw new Error('decoder crashed'); return looping(duration, 10); });
  const started = Date.now();
  const result = await run(ctx, async (...a) => { try { return await runner(...a); } catch (e) { return { code: 1, stderr: e.message }; } });
  assert.ok(['needs-review', 'repaired', 'ok'].includes(result.quality.status));
  const budgetRuns = result.quality.attempts.length;
  assert.ok(result.quality.attempts.reduce((sum,a)=>sum+a.end-a.start,0) <= 1800 * RECOVERY.budgetShare + .1, `${budgetRuns} attempts exceeded audio budget`);
  assert.ok(Date.now() - started < 60000);
});
