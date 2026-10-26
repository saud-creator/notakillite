import test from 'node:test';
import assert from 'node:assert/strict';
import { indexMarkdown, lectureMarkdown, paragraphs, timestamp, wordCount } from '../companion/transcript-format.mjs';
import { transcriptSettings } from '../companion/engines.mjs';
import { parseDetectedLanguage, parseWhisperJson, whisperPrompt } from '../companion/whisper.mjs';
import { chooseCuts, parseSilences } from '../companion/groq.mjs';

const segments = [
  { start: 0.2, end: 4.8, text: ' اليوم نتكلم عن the anterior abdominal wall' },
  { start: 5.0, end: 9.5, text: 'وهذا مهم جداً للامتحان.' },
  { start: 14, end: 18, text: 'Next, the rectus sheath.' },
  { start: 3700, end: 3705.5, text: 'Final point.' },
];

test('timestamps and paragraphs follow pauses in speech', () => {
  assert.equal(timestamp(0), '00:00:00');
  assert.equal(timestamp(3725.9), '01:02:05');
  const blocks = paragraphs(segments);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].text, 'اليوم نتكلم عن the anterior abdominal wall وهذا مهم جداً للامتحان.');
  assert.equal(paragraphs([{ start: 0, end: 50, text: 'a' }, { start: 50.5, end: 80, text: 'b' }], { maxSeconds: 60 }).length, 2);
  assert.equal(wordCount(segments), 17);
});

test('lecture Markdown keeps mixed Arabic/English text and is ready for an AI chat', () => {
  const markdown = lectureMarkdown({ title: 'Anatomy: "L3"', recording: 'Recording 1', sourceFile: 'Anatomy.note', duration: 3705.5, cleanup: 'DeepFilterNet3', transcript: { language: 'ar', segments, model: 'Whisper large-v3-turbo', device: 'GPU' }, number: 3, total: 5, createdAt: '2026-10-23T10:00:00Z' });
  assert.match(markdown, /^---\ntitle: "Anatomy: \\"L3\\""\nlecture: 3 of 5\n/);
  assert.match(markdown, /language: "Arabic"/);
  assert.match(markdown, /transcribed_with: "Whisper large-v3-turbo \(GPU\)"/);
  assert.match(markdown, /> .*exam, quiz/);
  assert.match(markdown, /\*\*\[00:00:00\]\*\* اليوم نتكلم عن the anterior abdominal wall/);
  assert.match(markdown, /\*\*\[01:01:40\]\*\* Final point\./);
  assert.doesNotMatch(lectureMarkdown({ title: 'x', transcript: { segments: [], model: 'm' }, includePrompt: false }), /Suggested request/);
  assert.match(lectureMarkdown({ title: 'x', transcript: { segments: [], model: 'm' } }), /No speech was detected/);
});

test('the batch index links every lecture transcript', () => {
  const markdown = indexMarkdown({ title: 'Anatomy week 3', lectures: [{ number: 1, title: 'Intro | overview', duration: 3000, words: 5000, transcript: '01 - Intro.md' }, { number: 2, title: 'Muscles', duration: 600, words: 900, transcript: '02 - Muscles.md' }] });
  assert.match(markdown, /2 lectures · 1 h 0 min of audio/);
  assert.match(markdown, /\| 1 \| Intro \\\| overview \| 00:50:00 \| 5000 \| \[01 - Intro\.md\]\(<01 - Intro\.md>\) \|/);
});

test('transcript settings are validated with safe defaults', () => {
  assert.deepEqual(transcriptSettings({}), { transcribe: true, transcriber: 'local', language: 'auto', model: 'turbo', transcribeFrom: 'cleaned', vocabulary: '', aiPrompt: true, resourcePolicy:'auto', threads:0, workers:1, chunkSeconds:60, backend:'auto', ocr:false, pdfBias:false });
  assert.throws(() => transcriptSettings({ transcriber: 'openai' }), /Groq/);
  assert.throws(() => transcriptSettings({ language: 'fr' }), /Arabic/);
  assert.throws(() => transcriptSettings({ vocabulary: 'x'.repeat(601) }), /600/);
});

test('whisper.cpp output, language detection and prompts are parsed', () => {
  const parsed = parseWhisperJson({ result: { language: 'en' }, transcription: [{ offsets: { from: 230, to: 7090 }, text: ' Hello ' }, { offsets: { from: 7090, to: 8000 }, text: ' ' }] });
  assert.deepEqual(parsed, { language: 'en', segments: [{ start: 0.23, end: 7.09, text: 'Hello' }] });
  assert.deepEqual(parseDetectedLanguage('whisper_full_with_state: auto-detected language: ar (p = 0.912345)'), { language: 'ar', probability: 0.912345 });
  assert.match(whisperPrompt('ar', 'pharmacokinetics, NSAIDs'), /diagnosis.*pharmacokinetics, NSAIDs$/s);
  assert.equal(whisperPrompt('auto'), '');
});

test('Groq uploads are cut in pauses close to every 10 minutes', () => {
  const silences = parseSilences('[silencedetect] silence_start: 590.5\n[silencedetect] silence_end: 591.5 | silence_duration: 1\n[silencedetect] silence_start: 1210\n[silencedetect] silence_end: 1211\n');
  assert.deepEqual(silences, [{ start: 590.5, end: 591.5 }, { start: 1210, end: 1211 }]);
  assert.deepEqual(chooseCuts(1500, silences), [{ start: 0, end: 591 }, { start: 591, end: 1210.5 }, { start: 1210.5, end: 1500 }]);
  assert.deepEqual(chooseCuts(650, []), [{ start: 0, end: 650 }]);
  assert.deepEqual(chooseCuts(2000, []).map(part => part.start), [0, 600, 1200, 1800]);
});

test('the shared golden transcript (also checked by the iOS app) is up to date', async () => {
  const { readFile } = await import('node:fs/promises');
  const golden = JSON.parse(await readFile(new URL('../shared/fixtures/transcript-golden.json', import.meta.url), 'utf8'));
  assert.equal(lectureMarkdown(golden.lecture), golden.expected.lecture);
  assert.equal(lectureMarkdown({ ...golden.lecture, includePrompt: false }), golden.expected.lectureWithoutPrompt);
  assert.equal(indexMarkdown(golden.index), golden.expected.index);
});
