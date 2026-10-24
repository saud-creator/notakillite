// Transcript quality audit. Detects speech-recognition failures — repetition loops, hallucinated
// text, impossible timing, output that doesn't match the audio — before a transcript is called
// "Ready for AI". It never edits text itself; it reports suspicious audio intervals so the caller
// can re-transcribe them from the source audio.
//
// Background (P0, 2026-10): Whisper repeated one sentence 971 times across a 42-minute lecture.
// See docs/transcription-reliability.md.
import { deflateSync } from 'node:zlib';

export const QUALITY_DEFAULTS = Object.freeze({
  // Per segment
  compressionRatio: 2.4,        // Whisper's own threshold: highly compressible text = repetition
  compressionMinChars: 60,      // too short to judge below this…
  compressionMaxChars: 400,     // …and only for ~30-s windows (Whisper's own definition): longer text compresses more naturally
  tinySegmentSeconds: 0.3,      // text on a (near) zero-length segment is a decoder artifact…
  tinySegmentMinWords: 4,       // …when it has at least this many words
  maxWordsPerSecond: 6.5,       // over a 10-s window; fast lecturers peak around 4–5 words/s
  rateWindowSeconds: 10,
  ngram: 4,                     // repeated n-grams inside one segment
  ngramMaxRepeats: 3,           // flagged when an n-gram appears more than this (per 75 words)
  // Across segments (sentences)
  repeatMinWords: 5,            // shorter sentences ("Okay?", "Fascia lata.") are never flagged
  similarity: 0.9,              // char-trigram similarity for "the same sentence"
  repeatWindowSeconds: 120,
  repeatMaxInWindow: 3,         // a sentence may appear 3× within 2 minutes (lecturer emphasis)
  backToBackMax: 2,             // …and twice in a row
  // Windows and pieces
  ttrWindowWords: 300,
  minTypeTokenRatio: 0.18,      // normal lecture speech ≈ 0.4–0.6; a loop ≈ 0.02
  dominantShare: 0.15,          // one *repeated* sentence (≥ 3×) > 15 % of a piece's words
  dominantMinWords: 60,
  maxWordsPerMinute: 300,       // per piece, over its speech time (normal ≈ 100–200)
  silenceTextMinWords: 4,       // words on audio the silence map says is silent
  missingTextSpeechSeconds: 60, // a piece with this much speech…
  missingTextMaxWords: 10,      // …but at most this many words
  identicalPieceMinWords: 30,
});

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/**
 * Text Whisper is known to invent from its subtitle training data (usually on silence or noise at
 * the end of a recording). Matched only against a *whole* segment, never inside lecture speech.
 */
const KNOWN_ARTIFACTS = [
  /^(subtitles|captions|transcription|transcript) (by|from) (the )?amara ?(\.? ?org)( community)?$/,
  /^sous titres réalisés (par|para) la communauté d ?amara ?\.? ?org$/,
  /^untertitel (der|von) amara ?\.? ?org ?community$/,
  /^(please )?(like and )?subscribe( to (my|our|the) channel)?$/,
  /^ترجمة نانسي قنقر$/,
  /^(اشتركوا|اشترك) في القناة$/,
  /^(subtitles|subtitled) by .{0,40}$/,
];
export function isKnownArtifact(text) {
  const norm = normalize(text).replace(/ org\b/g, ' org');
  return norm.length > 0 && norm.length < 80 && KNOWN_ARTIFACTS.some(pattern => pattern.test(norm));
}

export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s'’]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
export const words = text => normalize(text).match(WORD) || [];

export function compressionRatio(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  return bytes.length ? bytes.length / deflateSync(bytes).length : 0;
}

function trigrams(text) {
  const padded = ` ${text} `, set = new Set();
  for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
  return set;
}
/** Dice similarity of character trigrams (0–1). */
export function similarity(a, b) {
  if (a === b) return 1;
  const x = trigrams(a), y = trigrams(b);
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return (2 * shared) / ((x.size + y.size) || 1);
}

/** Splits segments into sentences, each carrying its segment's time range. */
export function sentencesOf(segments) {
  const out = [];
  segments.forEach((segment, index) => {
    if (segment.marker) return;
    for (const piece of String(segment.text).split(/(?<=[.?!؟。])\s+/u)) {
      const norm = normalize(piece);
      if (norm) out.push({ start: segment.start, end: segment.end, norm, words: norm.split(' ').length, segment: index });
    }
  });
  return out;
}

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * Builds ~`target`-second pieces covering [0, duration]; cuts are supplied by the caller
 * (pauses from the silence map) or fall back to fixed boundaries.
 */
export function piecesFor(duration, cuts = []) {
  const starts = [0, ...cuts.filter(cut => cut > 0 && cut < duration)].sort((a, b) => a - b);
  return starts.map((start, i) => ({ index: i, start, end: i + 1 < starts.length ? starts[i + 1] : duration }));
}

/**
 * Audits a transcript.
 * @param segments  [{ start, end, text }] in seconds, chronological
 * @param options   { duration, pieces: [{start,end}], speech: [{start,end}] (speech intervals), config }
 * @returns { status: 'ok'|'failed', findings: [{start,end,kind,detail}], pieces: [...], stats }
 */
export function auditTranscript(segments, { duration, pieces, speech, config = {} } = {}) {
  const c = { ...QUALITY_DEFAULTS, ...config };
  const findings = [];
  const add = (start, end, kind, detail) => findings.push({ start, end: Math.max(end, start), kind, detail });
  const end = duration ?? segments.at(-1)?.end ?? 0;
  pieces = pieces?.length ? pieces : piecesFor(end, Array.from({ length: Math.floor(end / 300) }, (_, i) => (i + 1) * 300));

  // 1. Per segment
  segments.forEach(segment => {
    if (segment.marker) return;
    const count = words(segment.text).length;
    const length = segment.end - segment.start;
    if (length < c.tinySegmentSeconds && count >= c.tinySegmentMinWords) add(segment.start, segment.end, 'impossible-timing', `${count} words in ${length.toFixed(2)} s`);
    const text = normalize(segment.text);
    if (text.length >= c.compressionMinChars && text.length <= c.compressionMaxChars && compressionRatio(text) > c.compressionRatio) add(segment.start, segment.end, 'compressible', `compression ratio ${compressionRatio(text).toFixed(2)}`);
    const tokens = text.split(' '), grams = new Map();
    for (let i = 0; i + c.ngram <= tokens.length; i++) {
      const gram = tokens.slice(i, i + c.ngram).join(' ');
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }
    const worst = Math.max(0, ...grams.values());
    if (worst > c.ngramMaxRepeats * Math.max(1, Math.ceil(tokens.length / 75))) add(segment.start, segment.end, 'internal-repetition', `a ${c.ngram}-word phrase repeats ${worst}×`);
  });

  // 1b. Speaking rate over 10-second windows. Single segments are not used: with voice detection
  // whisper.cpp often rounds segment times to whole seconds, so one segment can look impossibly fast.
  // Each segment's words are spread evenly over its own duration.
  const counted = segments.filter(s => !s.marker).map(s => ({ start: s.start, end: Math.max(s.end, s.start + 0.05), n: words(s.text).length }));
  for (let i = 0, first = 0; i < counted.length; i++) {
    const window = { start: counted[i].start, end: counted[i].start + c.rateWindowSeconds };
    while (first < i && counted[first].end <= window.start) first++;
    let sum = 0, last = i;
    for (let j = first; j < counted.length && counted[j].start < window.end; j++) { sum += counted[j].n * overlap(counted[j], window) / (counted[j].end - counted[j].start); last = j; }
    if (sum / c.rateWindowSeconds > c.maxWordsPerSecond) add(window.start, counted[last].end, 'impossible-rate', `${(sum / c.rateWindowSeconds).toFixed(1)} words/s over ${c.rateWindowSeconds} s`);
  }

  // 2. Repeated sentences across segments (lecturer emphasis stays allowed)
  const sentences = sentencesOf(segments);
  let run = 1;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.words < c.repeatMinWords) { run = 1; continue; }
    const previous = sentences[i - 1];
    run = previous && previous.words >= c.repeatMinWords && similarity(previous.norm, s.norm) >= c.similarity ? run + 1 : 1;
    if (run > c.backToBackMax) add(sentences[i - run + 1].start, s.end, 'repeated-sentence', `same sentence ${run}× in a row`);
    let inWindow = 1, first = s;
    for (let j = i - 1; j >= 0 && s.start - sentences[j].start <= c.repeatWindowSeconds; j--) {
      const other = sentences[j];
      if (other.words >= c.repeatMinWords && similarity(other.norm, s.norm) >= c.similarity) { inWindow++; first = other; }
    }
    if (inWindow > c.repeatMaxInWindow) add(first.start, s.end, 'repeated-sentence', `same sentence ${inWindow}× within ${c.repeatWindowSeconds / 60} min`);
  }

  // 3. Vocabulary diversity over sliding word windows
  const stream = [];
  for (const segment of segments) if (!segment.marker) for (const w of words(segment.text)) stream.push({ w, start: segment.start, end: segment.end });
  for (let i = 0; i + c.ttrWindowWords <= stream.length; i += Math.floor(c.ttrWindowWords / 2)) {
    const slice = stream.slice(i, i + c.ttrWindowWords);
    const ratio = new Set(slice.map(x => x.w)).size / slice.length;
    if (ratio < c.minTypeTokenRatio) add(slice[0].start, slice.at(-1).end, 'low-diversity', `only ${Math.round(ratio * 100)} % distinct words`);
  }

  // 4. Pieces: dominant sentence, output vs. speech, identical pieces
  const pieceReports = pieces.map(piece => {
    const inPiece = segments.filter(s => !s.marker && s.start >= piece.start && s.start < piece.end);
    const pieceWords = inPiece.reduce((sum, s) => sum + words(s.text).length, 0);
    const speechSeconds = speech ? speech.reduce((sum, interval) => sum + overlap(interval, piece), 0) : piece.end - piece.start;
    const counts = new Map();
    for (const s of sentencesOf(inPiece)) if (s.words >= c.repeatMinWords) { const x = counts.get(s.norm) || { words: 0, times: 0 }; x.words += s.words; x.times++; counts.set(s.norm, x); }
    const repeated = [...counts.entries()].filter(([, x]) => x.times >= 3).sort((a, b) => b[1].words - a[1].words)[0];
    const [topSentence, topWords] = repeated ? [repeated[0], repeated[1].words] : ['', 0];
    if (pieceWords >= c.dominantMinWords && topWords / pieceWords > c.dominantShare) add(piece.start, piece.end, 'dominant-sentence', `one sentence is ${Math.round(topWords / pieceWords * 100)} % of the words`);
    if (speechSeconds > 30 && pieceWords / (speechSeconds / 60) > c.maxWordsPerMinute) add(piece.start, piece.end, 'excess-output', `${Math.round(pieceWords / (speechSeconds / 60))} words per minute of speech`);
    if (speech && speechSeconds >= c.missingTextSpeechSeconds && pieceWords <= c.missingTextMaxWords) add(piece.start, piece.end, 'missing-text', `${Math.round(speechSeconds)} s of speech but ${pieceWords} words`);
    return { ...piece, words: pieceWords, speechSeconds: Math.round(speechSeconds * 10) / 10, text: normalize(inPiece.map(s => s.text).join(' ')), topSentence };
  });
  if (speech) {
    for (const segment of segments) {
      if (segment.marker) continue;
      const count = words(segment.text).length;
      const spoken = speech.reduce((sum, interval) => sum + overlap(interval, segment), 0);
      if (count >= c.silenceTextMinWords && segment.end - segment.start >= 1 && spoken / (segment.end - segment.start) < 0.1) add(segment.start, segment.end, 'text-over-silence', `${count} words where the audio is silent`);
    }
  }
  const seen = new Map();
  for (const piece of pieceReports) {
    if (piece.words < c.identicalPieceMinWords) continue;
    const twin = seen.get(piece.text);
    if (twin) { add(twin.start, twin.end, 'identical-pieces', 'same text as another part of the lecture'); add(piece.start, piece.end, 'identical-pieces', 'same text as another part of the lecture'); }
    else seen.set(piece.text, piece);
  }

  // Attach findings to pieces.
  const flagged = pieceReports.map(piece => {
    const reasons = findings.filter(f => overlap(f, piece) > 0 || (f.start >= piece.start && f.start < piece.end));
    const { text, ...rest } = piece;
    return { ...rest, ok: reasons.length === 0, reasons: [...new Set(reasons.map(f => f.kind))] };
  });
  const totalWords = stream.length;
  return {
    status: findings.length ? 'failed' : 'ok',
    findings: mergeFindings(findings),
    pieces: flagged,
    stats: { segments: segments.length, words: totalWords, distinctWordRatio: totalWords ? Math.round(new Set(stream.map(x => x.w)).size / totalWords * 1000) / 1000 : 0 },
  };
}

/** Merges overlapping findings of the same kind so reports stay short. */
function mergeFindings(findings) {
  const sorted = [...findings].sort((a, b) => a.kind.localeCompare(b.kind) || a.start - b.start);
  const out = [];
  for (const f of sorted) {
    const last = out.at(-1);
    if (last && last.kind === f.kind && f.start <= last.end + 1) { last.end = Math.max(last.end, f.end); last.count = (last.count || 1) + 1; }
    else out.push({ ...f });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A score from 0 (unusable) to 1 (clean) used to pick the best of several attempts. */
export function qualityScore(report) {
  const span = report.findings.reduce((sum, f) => sum + Math.max(1, f.end - f.start), 0);
  const total = Math.max(1, report.pieces.reduce((sum, p) => sum + (p.end - p.start), 0));
  return Math.max(0, 1 - span / total) * (report.status === 'ok' ? 1 : 0.9);
}
