// Regenerates shared/fixtures/transcript-golden.json, which the Node and iOS tests both check,
// so Windows and iPhone write byte-identical Markdown.
import { writeFile } from 'node:fs/promises';
import { indexMarkdown, lectureMarkdown } from '../companion/transcript-format.mjs';

const lecture = {
  title: 'Anatomy: "L3" | wall', recording: 'Recording 1', sourceFile: 'Anatomy L3.note', duration: 3705.5, cleanup: 'Apple Voice Isolation', number: 3, total: 5, createdAt: '2026-10-23T10:00:00.000Z', includePrompt: true,
  transcript: { language: 'ar', model: 'Whisper large-v3-turbo', device: 'iPhone', segments: [
    { start: 0.2, end: 4.8, text: ' اليوم نتكلم عن the anterior abdominal wall' },
    { start: 5.0, end: 9.5, text: 'وهذا   مهم جداً للامتحان.' },
    { start: 14, end: 18, text: 'Next, the rectus sheath.' },
    { start: 18.5, end: 80, text: 'A very long explanation that keeps going.' },
    { start: 80.5, end: 82, text: 'Then a new paragraph because of the 60 s cap.' },
    { start: 3700, end: 3705.5, text: 'Final point.' },
    { start: 3706, end: 3706.5, text: '   ' },
  ] },
};
const index = { title: 'Anatomy week 3', createdAt: '2026-10-23T10:00:00.000Z', lectures: [
  { number: 1, title: 'Intro | overview', duration: 3000, words: 5000, transcript: '01 - Intro.md' },
  { number: 2, title: 'Muscles', duration: 600, words: 900, transcript: '02 - Muscles.md' },
  { number: 3, title: 'No speech', duration: 59, words: 0, transcript: '' },
] };
const golden = { lecture, index, expected: { lecture: lectureMarkdown(lecture), lectureWithoutPrompt: lectureMarkdown({ ...lecture, includePrompt: false }), empty: lectureMarkdown({ title: 'Empty', recording: 'r', sourceFile: 's', duration: 0, cleanup: 'None', createdAt: lecture.createdAt, transcript: { language: 'en', model: 'm', segments: [] } }), index: indexMarkdown(index) } };
await writeFile(new URL('../shared/fixtures/transcript-golden.json', import.meta.url), `${JSON.stringify(golden, null, 2)}\n`);
console.log('shared/fixtures/transcript-golden.json written');
