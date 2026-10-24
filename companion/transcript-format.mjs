// Turns timed speech segments into Markdown that ChatGPT or Claude can analyse directly.
const LANGUAGE_NAMES = { ar: 'Arabic', en: 'English', auto: 'Auto-detected' };

export function timestamp(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const pad = number => String(number).padStart(2, '0');
  return `${pad(Math.floor(value / 3600))}:${pad(Math.floor(value / 60) % 60)}:${pad(value % 60)}`;
}

export function durationLabel(seconds) {
  const value = Math.round(Number(seconds) || 0);
  const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60;
  return hours ? `${hours} h ${minutes} min` : `${Math.max(minutes, value ? 1 : 0)} min`;
}

const yaml = value => JSON.stringify(String(value ?? '')); // JSON strings are valid YAML scalars.

/** Groups segments into readable paragraphs at natural pauses, capped at about a minute. */
export function paragraphs(segments, { pause = 2, maxSeconds = 60 } = {}) {
  const result = [];
  let current;
  for (const segment of segments) {
    const text = String(segment.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (segment.marker) { result.push({ start: segment.start, end: segment.end, parts: [text], marker: true }); current = undefined; continue; }
    const gap = current ? segment.start - current.end : Infinity;
    if (!current || gap >= pause || segment.end - current.start > maxSeconds) {
      current = { start: segment.start, end: segment.end, parts: [text] };
      result.push(current);
    } else { current.parts.push(text); current.end = segment.end; }
  }
  return result.map(item => ({ start: item.start, end: item.end, text: item.parts.join(' '), ...(item.marker ? { marker: true } : {}) }));
}

export const AI_PROMPT = [
  'This is an automatic transcript of a university lecture, kept in the language(s) the lecturer spoke (often Arabic with English terms).',
  'Each paragraph starts with a [hh:mm:ss] timestamp from the recording. Speech recognition can mishear names and technical terms; correct obvious errors from context and say when unsure.',
  'Suggested request: list everything the lecturer said is important, will be on the exam, quiz or assignment, or must be memorised (quote it with its timestamp). Then give the key concepts, definitions, lists and a short summary.',
];

export function wordCount(segments) {
  return segments.reduce((total, segment) => total + (segment.marker ? 0 : String(segment.text || '').match(/\S+/g)?.length || 0), 0);
}

/** Human-readable quality line for the transcript header and the index. */
export function qualityLabel(quality) {
  if (!quality) return '';
  const parts = n => `${n} part${n === 1 ? '' : 's'}`;
  const artifacts = quality.artifactsRemoved ? `; ${quality.artifactsRemoved} known Whisper artifact${quality.artifactsRemoved === 1 ? '' : 's'} removed (e.g. "Subtitles by…" credits)` : '';
  if (quality.status === 'needs-review') return `needs review — ${parts(quality.unresolved.length)} could not be transcribed reliably${artifacts}`;
  if (quality.status === 'repaired') return `repaired — ${parts(quality.repairs.length)} re-transcribed after the automatic quality check${artifacts}`;
  return `ok — passed the automatic quality check${artifacts}`;
}

export function lectureMarkdown({ title, recording, sourceFile, duration, cleanup, transcript, createdAt = new Date(), includePrompt = true, number, total, quality }) {
  const blocks = paragraphs(transcript.segments);
  const language = LANGUAGE_NAMES[transcript.language] || transcript.language || 'Auto-detected';
  const lines = [
    '---',
    `title: ${yaml(title)}`,
    ...(number ? [`lecture: ${number}${total ? ` of ${total}` : ''}`] : []),
    `recording: ${yaml(recording)}`,
    `source_file: ${yaml(sourceFile)}`,
    `duration: ${yaml(timestamp(duration))}`,
    `language: ${yaml(language)}`,
    `noise_cleanup: ${yaml(cleanup)}`,
    `transcribed_with: ${yaml(`${transcript.model}${transcript.device ? ` (${transcript.device})` : ''}`)}`,
    `words: ${wordCount(transcript.segments)}`,
    ...(quality ? [`quality: ${yaml(qualityLabel(quality))}`] : []),
    `created: ${yaml(new Date(createdAt).toISOString().slice(0, 10))}`,
    '---',
    '',
    `# ${title}`,
    '',
  ];
  if (quality?.status === 'needs-review') lines.push(`> ⚠ **Needs review:** ${qualityLabel(quality).replace(/^needs review — /, '')}. Those parts are marked below with ⚠; the rest passed the quality check. Do not treat the marked parts as complete.`, '');
  if (includePrompt) lines.push(...AI_PROMPT.map(line => `> ${line}`), '');
  lines.push('## Transcript', '');
  if (!blocks.length) lines.push('_No speech was detected in this recording._', '');
  for (const block of blocks) {
    if (block.marker) lines.push(`> ⚠ **[${timestamp(block.start)}–${timestamp(block.end)}]** ${block.text}`, '');
    else lines.push(`**[${timestamp(block.start)}]** ${block.text}`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function indexMarkdown({ title, lectures, createdAt = new Date() }) {
  const total = lectures.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  const lines = [
    `# ${title}`,
    '',
    `${lectures.length} lecture${lectures.length === 1 ? '' : 's'} · ${durationLabel(total)} of audio · ${new Date(createdAt).toISOString().slice(0, 10)}`,
    '',
    'Upload the numbered `.md` files to ChatGPT or Claude (one chat for the whole course works well). Each file has the lecture\'s transcript with timestamps and a suggested request at the top.',
    '',
  ];
  // The Quality column appears only when quality results are available (keeps older indexes unchanged).
  const withQuality = lectures.some(item => item.quality);
  lines.push(withQuality ? '| # | Lecture | Length | Words | Quality | Transcript |' : '| # | Lecture | Length | Words | Transcript |', withQuality ? '|---|---|---|---|---|---|' : '|---|---|---|---|---|');
  const badge = { ok: '✓ ok', repaired: '✓ repaired', 'needs-review': '⚠ needs review' };
  for (const item of lectures) {
    const cell = value => String(value ?? '').replaceAll('|', '\\|');
    const link = item.transcript ? `[${cell(item.transcript)}](<${item.transcript}>)` : '—';
    lines.push(`| ${item.number} | ${cell(item.title)} | ${timestamp(item.duration)} | ${item.words ?? ''} | ${withQuality ? `${badge[item.quality] || '—'} | ` : ''}${link} |`);
  }
  return `${lines.join('\n')}\n`;
}
