// P0 regression tests: transcript quality audit (see docs/transcription-reliability.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditTranscript, compressionRatio, similarity, piecesFor, qualityScore } from '../companion/transcript-quality.mjs';
import { assemble } from '../companion/transcribe.mjs';
import { incident, lecture } from './fixtures/lecture.mjs';

const kinds = report => [...new Set(report.findings.map(f => f.kind))].sort();

test('the real incident pattern (one sentence ×971 after 4 minutes) is detected where it starts', () => {
  const segments = incident();
  const report = auditTranscript(segments, { duration: 2514 });
  assert.equal(report.status, 'failed');
  for (const kind of ['repeated-sentence', 'low-diversity', 'dominant-sentence']) assert.ok(kinds(report).includes(kind), kind);
  const repeated = report.findings.find(f => f.kind === 'repeated-sentence');
  assert.ok(repeated.start >= 236 && repeated.start < 250, `starts at ${repeated.start}`);
  assert.ok(report.findings.some(f => f.end > 2400), 'covers the end of the lecture');
  // Every piece from 5:00 on is flagged; the first piece is flagged too because the loop starts inside it.
  assert.ok(report.pieces.filter(p => p.start >= 300).every(p => !p.ok));
  assert.ok(qualityScore(report) < 0.2);
});

test('a normal synthetic lecture passes', () => {
  const report = auditTranscript(lecture({ to: 2514 }), { duration: 2514 });
  assert.equal(report.status, 'ok', JSON.stringify(report.findings.slice(0, 3)));
  assert.ok(report.stats.distinctWordRatio > 0.02);
  assert.equal(qualityScore(report), 1);
});

test('legitimate lecturer repetition is kept: short phrases, emphasis, spaced definitions', () => {
  const definition = 'The inguinal ligament is formed by the external oblique aponeurosis.';
  const segments = [...lecture({ to: 600, seed: 3 })];
  segments.push({ start: 30.5, end: 31, text: 'Okay? Okay?' });
  segments.push({ start: 95.2, end: 98, text: 'Fascia lata. Fascia lata. Fascia lata.' });
  segments.push({ start: 120.1, end: 125, text: `${definition} ${definition}` }); // said twice for emphasis
  segments.push({ start: 240.3, end: 245, text: definition });
  segments.push({ start: 540.3, end: 545, text: definition });
  const report = auditTranscript(segments.sort((a, b) => a.start - b.start), { duration: 600 });
  assert.equal(report.status, 'ok', JSON.stringify(report.findings));
});

test('a definition repeated 4 times within 2 minutes or 3 times in a row is flagged', () => {
  const s = 'The conjoint tendon is formed by the internal oblique and transversus abdominis.';
  const base = lecture({ to: 300, seed: 5 });
  const fourInWindow = [...base, ...[10, 40, 70, 100].map(t => ({ start: t + 0.3, end: t + 3, text: s }))].sort((a, b) => a.start - b.start);
  assert.ok(kinds(auditTranscript(fourInWindow, { duration: 300 })).includes('repeated-sentence'));
  const threeInRow = [{ start: 0, end: 3, text: s }, { start: 3, end: 6, text: s }, { start: 6, end: 9, text: s }, ...lecture({ from: 10, to: 300, seed: 6 })];
  assert.ok(kinds(auditTranscript(threeInRow, { duration: 300 })).includes('repeated-sentence'));
});

test('Arabic–English code-switching and medical terms are not flagged', () => {
  const lines = ['اليوم نتكلم عن the anterior abdominal wall وهذا مهم جداً للامتحان.', 'الـ external oblique aponeurosis تكوّن الـ inguinal ligament.',
    'لاحظوا أن الـ iliohypogastric nerve يمر بين الـ internal oblique و transversus abdominis.', 'هذا السؤال جاء في الكويز السابق عن الـ rectus sheath.',
    'Pyramidalis muscle may be absent, وهذا يسمونه degenerating muscle.', 'الـ superficial fascia فيها طبقتين: Camper و Scarpa.'];
  const segments = [];
  for (let t = 0, i = 0; t < 600; t += 7, i++) segments.push({ start: t, end: t + 6, text: `${lines[i % lines.length]} (${Math.floor(t / 60)}:${i})` });
  const mixed = [...segments, ...lecture({ from: 3, to: 600, step: 7, seed: 9 })].sort((a, b) => a.start - b.start);
  assert.equal(auditTranscript(mixed, { duration: 600 }).status, 'ok');
});

test('hidden corruption: text on zero-length segments and 3× normal output are flagged', () => {
  const base = lecture({ to: 600, seed: 11 });
  const tiny = [...base, ...Array.from({ length: 6 }, (_, i) => ({ start: 444 + i * 0.1, end: 444 + i * 0.1 + 0.1, text: 'And here in the midline, the aponeurosis of the external oblique muscle.' }))].sort((a, b) => a.start - b.start);
  assert.ok(kinds(auditTranscript(tiny, { duration: 600 })).includes('impossible-timing'));
  const dense = [...lecture({ to: 300, seed: 12 }), ...lecture({ from: 300, to: 600, wordsPerSecond: 9, seed: 13 })];
  const report = auditTranscript(dense, { duration: 600, speech: [{ start: 0, end: 600 }] });
  assert.ok(kinds(report).includes('excess-output'));
  assert.ok(report.pieces[0].ok && !report.pieces[1].ok);
});

test('silence: text over long silence is flagged, short pauses are fine, and speech without text is reported', () => {
  const speech = [{ start: 0, end: 280 }, { start: 281, end: 300 }, { start: 600, end: 900 }]; // 1 s pause and a 5-minute silence
  const ok = [...lecture({ to: 280, seed: 14 }), ...lecture({ from: 281, to: 300, seed: 15 }), ...lecture({ from: 600, to: 900, seed: 16 })];
  assert.equal(auditTranscript(ok, { duration: 900, speech, pieces: piecesFor(900, [300, 600]) }).status, 'ok');
  const overSilence = [...ok, { start: 400, end: 430, text: 'Thank you for watching, please subscribe to the channel.' }].sort((a, b) => a.start - b.start);
  assert.ok(kinds(auditTranscript(overSilence, { duration: 900, speech, pieces: piecesFor(900, [300, 600]) })).includes('text-over-silence'));
  const missing = [...lecture({ to: 300, seed: 17 }), { start: 610, end: 612, text: 'Okay.' }];
  assert.ok(kinds(auditTranscript(missing, { duration: 900, speech, pieces: piecesFor(900, [300, 600]) })).includes('missing-text'));
});

test('low-volume speech (few words per minute) is not mistaken for a failure', () => {
  const quiet = lecture({ to: 600, step: 8, seed: 18 }); // ~60 words per minute
  assert.equal(auditTranscript(quiet, { duration: 600, speech: [{ start: 0, end: 600 }] }).status, 'ok');
});

test('the same text from two different parts of the lecture (duplicate audio or reused buffer) is flagged', () => {
  const part = lecture({ to: 300, seed: 19 });
  const segments = [...part, ...part.map(s => ({ ...s, start: s.start + 300, end: s.end + 300 }))];
  const report = auditTranscript(segments, { duration: 600, pieces: piecesFor(600, [300]) });
  assert.ok(kinds(report).includes('identical-pieces'));
});

test('a long internal repetition inside one segment is flagged (compression ratio, repeated phrases)', () => {
  const looping = Array(12).fill('the deep inguinal ring').join(' ');
  assert.ok(compressionRatio(looping) > 2.4);
  const report = auditTranscript([...lecture({ to: 300, seed: 20 }), { start: 299, end: 299.9, text: looping }], { duration: 300 });
  assert.ok(kinds(report).some(k => ['compressible', 'internal-repetition', 'impossible-rate'].includes(k)));
});

test('assembly orders segments and merges only exact decoder duplicates', () => {
  const s = { start: 444.55, end: 444.65, text: 'And here in the midline, the aponeurosis of the external oblique.' };
  const out = assemble([{ start: 10, end: 12, text: 'B' }, s, { ...s }, { start: 5, end: 6, text: 'A' }, { ...s, start: 500, end: 501 }]);
  assert.deepEqual(out.map(x => x.text[0] + x.start), ['A5', 'B10', 'A444.55', 'A500']);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].start);
});

test('similarity is robust to punctuation and case, and different sentences stay apart', () => {
  assert.equal(similarity('so deep membranous fascia is called fascia of the thigh', 'so deep membranous fascia is called fascia of the thigh'), 1);
  assert.ok(similarity('the fascia latae of the thigh known as', 'the fascia lata of the thigh is known as') > 0.8);
  assert.ok(similarity('the inguinal ligament is formed by the external oblique', 'the conjoint tendon is formed by the internal oblique') < 0.9);
});

test('shared quality cases (also used by the iPhone/iPad port) produce the expected verdicts', async () => {
  const cases = JSON.parse(await readFile(new URL('../shared/fixtures/quality-cases.json', import.meta.url), 'utf8'));
  for (const c of cases.cases) {
    const report = auditTranscript(c.segments, c.options);
    assert.equal(report.status, c.expected.status, c.name);
    for (const kind of c.expected.kinds) assert.ok(kinds(report).includes(kind), `${c.name}: ${kind}`);
  }
});

test('known Whisper artifacts are recognised only as whole segments', async () => {
  const { isKnownArtifact } = await import('../companion/transcript-quality.mjs');
  for (const t of ['Subtitles by the Amara.org community', 'ترجمة نانسي قنقر', 'Please subscribe to my channel.']) assert.equal(isKnownArtifact(t), true, t);
  for (const t of ['The subtitles by the professor are on the slide.', 'So, everybody has signed the sheet.', 'Thank you.']) assert.equal(isKnownArtifact(t), false, t);
});

test('long natural sentences without punctuation are not a "dominant repeated sentence"', () => {
  const runOn = { start: 2433, end: 2466, text: 'okay so if portal hypertension when the pressure increases all the veins surrounding your umbilicus they are dilated and tortuous so dilated tortuous veins surrounding your umbilicus that is the caput medusae it is because of portal hypertension because of cirrhosis of liver or whatever may be the reason okay is it clear' };
  const report = auditTranscript([...lecture({ to: 2433, seed: 21 }), runOn, { start: 2467, end: 2470, text: 'So everybody has signed the sheet.' }], { duration: 2514 });
  assert.equal(report.status, 'ok', JSON.stringify(report.findings));
});

test('a long but natural 30-second segment is not flagged by the compression check', () => {
  const segment = { start: 950, end: 981, text: 'Is it clear, okay, so only the questions which are important, so how many muscles are there in the anterior abdominal wall, okay, is it clear, how many flat muscles, how many vertical muscles, okay, is it clear, so four muscles, okay, external oblique, internal oblique, transversus abdominis and rectus abdominis, okay, is it clear?' };
  const report = auditTranscript([...lecture({ to: 950, seed: 22 }), segment, ...lecture({ from: 982, to: 1200, seed: 23 })], { duration: 1200 });
  assert.ok(!report.findings.some(f => f.kind === 'compressible' || f.kind === 'internal-repetition'), JSON.stringify(report.findings));
});

test('pause detection keeps every pause of a long recording (no stderr truncation)', { timeout: 120000 }, async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const ffmpeg = (await import('ffmpeg-static')).default;
  const { runTool } = await import('../companion/audio.mjs');
  const { detectSilences } = await import('../companion/groq.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notakillite-silence-')); t.after(() => rm(dir, { recursive: true, force: true }));
  // 45 minutes of 1-second beeps separated by 1-second silences = ~1,350 pauses (≈ 100 KB of ffmpeg output).
  const wav = path.join(dir, 'beeps.wav');
  await runTool(ffmpeg, ['-y', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)*lt(mod(t,2),1)':s=16000:d=2700", '-ac', '1', wav]);
  const silences = await detectSilences(ffmpeg, wav);
  assert.ok(silences.length > 1300, `${silences.length} pauses`);
  assert.ok(silences[0].start < 2 && silences.at(-1).start > 2690);
});

test('pause detection adapts to the recording noise floor (cleaned, loudness-normalised audio)', async () => {
  const { silencesFromLevels } = await import('../companion/groq.mjs');
  // Speech around -22 dB, pauses at -38 dB with short -33 dB noise peaks: a fixed -35 dB detector finds nothing.
  const levels = [];
  for (let s = 0; s < 120; s++) { for (let i = 0; i < 40; i++) levels.push(-22 + (i % 5)); for (let i = 0; i < 8; i++) levels.push(i === 3 ? -33 : -38); }
  const pauses = silencesFromLevels(levels);
  assert.ok(pauses.length >= 110, `${pauses.length} pauses at threshold ${pauses.threshold}`);
  assert.ok(pauses.threshold > -35 && pauses.threshold < -25);
  assert.equal(silencesFromLevels(Array(500).fill(-20)).length, 0, 'continuous loud audio has no pauses');
});
