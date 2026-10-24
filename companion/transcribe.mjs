// Transcription pipeline: one fast pass, a quality audit, and bounded re-transcription of only the
// parts that fail — from the source audio, never by guessing or deleting text.
// Background: docs/transcription-reliability.md (P0 repetition-loop incident).
import path from 'node:path';
import { createHash } from 'node:crypto';
import { open, writeFile, rm, stat } from 'node:fs/promises';
import { runTool } from './audio.mjs';
import { wavSamples } from './engines.mjs';
import { access } from 'node:fs/promises';
import { transcribeLocal, whisperPass, detectLanguage, WHISPER_MODELS, modelPath, spawnLines, whisperBuilds } from './whisper.mjs';
import { transcribeGroq, groqRequest, GROQ_MODELS, chooseCuts, detectSilences } from './groq.mjs';
import { auditTranscript, piecesFor, normalize, qualityScore, isKnownArtifact } from './transcript-quality.mjs';

const exists = file => access(file).then(() => true, () => false);

export const TRANSCRIBER_NAMES = { local: 'Whisper on this PC', groq: 'Groq Whisper (cloud)' };
export const RECOVERY = Object.freeze({ pieceSeconds: 300, maxAttemptsPerPiece: 4, budgetShare: 1 }); // retries may re-process at most the lecture's length once more

/** Decodes one or more consecutive audio files into a single 16 kHz mono WAV for Whisper. */
export async function speechWav({ ffmpeg, inputs, work, signal, name = 'speech-16k.wav' }) {
  const wav = path.join(work, name);
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (inputs.length > 1) {
    const list = path.join(work, `${name}.parts.txt`);
    await writeFile(list, inputs.map(file => `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'));
    args.push('-f', 'concat', '-safe', '0', '-i', list);
  } else args.push('-i', inputs[0]);
  args.push('-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
  await runTool(ffmpeg, args, { signal });
  const duration = await wavSamples(wav) / 16000;
  return { wav, duration };
}

/** Cuts [start, end) seconds of a WAV into a new WAV (sample-accurate for PCM input). */
export async function cutWav({ ffmpeg, wav, start, end, target, signal }) {
  const codec = target.endsWith('.flac') ? 'flac' : 'pcm_s16le';
  await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', wav, '-c:a', codec, target], { signal });
  return target;
}

/** Speech intervals = complement of the silences ffmpeg finds. */
export function speechFromSilences(silences, duration) {
  const speech = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) speech.push({ start: cursor, end: Math.min(s.start, duration) });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) speech.push({ start: cursor, end: duration });
  return speech.filter(x => x.end - x.start > 0.05);
}

/** SHA-256 of the PCM samples of [start, end) — lets the log prove which audio each piece used. */
async function pcmHash(wav, start, end) {
  const handle = await open(wav, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    let offset = 12, data = 44;
    while (offset + 8 <= bytesRead) {
      const id = header.toString('ascii', offset, offset + 4), size = header.readUInt32LE(offset + 4);
      if (id === 'data') { data = offset + 8; break; }
      offset += 8 + size + (size % 2);
    }
    const from = data + Math.floor(start * 16000) * 2, length = Math.max(0, Math.floor((end - start) * 16000) * 2);
    const hash = createHash('sha256'), buffer = Buffer.alloc(1 << 20);
    for (let done = 0; done < length;) {
      const { bytesRead: n } = await handle.read(buffer, 0, Math.min(buffer.length, length - done), from + done);
      if (!n) break;
      hash.update(buffer.subarray(0, n)); done += n;
    }
    return hash.digest('hex').slice(0, 16);
  } finally { await handle.close(); }
}

/**
 * Orders segments and merges only exact decoder duplicates (same text and same time range).
 * Nothing else is ever removed.
 */
export function assemble(segments, log = () => {}) {
  const sorted = segments.filter(s => String(s.text || '').trim() || s.marker)
    .map(s => ({ ...s, start: Math.max(0, s.start), end: Math.max(s.start, s.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let merged = 0;
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && !s.marker && !last.marker && Math.abs(last.start - s.start) < 0.05 && Math.abs(last.end - s.end) < 0.05 && normalize(last.text) === normalize(s.text)) { merged++; continue; }
    out.push(s);
  }
  if (merged) log({ event: 'merge', exactDuplicatesMerged: merged });
  return out;
}

const shift = (segments, by) => segments.map(s => ({ ...s, start: s.start + by, end: s.end + by }));
const within = (segments, piece) => segments.filter(s => s.start >= piece.start && s.start < piece.end);
const without = (segments, piece) => segments.filter(s => !(s.start >= piece.start && s.start < piece.end));
const timeLabel = seconds => new Date(Math.max(0, Math.floor(seconds)) * 1000).toISOString().slice(11, 19);
const wordCount = segments => segments.reduce((sum, s) => sum + (s.marker ? 0 : String(s.text).split(/\s+/).filter(Boolean).length), 0);

/**
 * Transcribes `inputs` (cleaned or original audio). Returns
 * { language, segments, engine, model, device, duration, quality: { status, findings, repairs, unresolved, attempts } }.
 * quality.status: 'ok' | 'repaired' | 'needs-review'.
 */
export async function transcribeAudio({ ffmpeg, inputs, originalInputs, work, options, secrets = {}, modelsDir, signal, onStage = () => {}, fetchImpl, log = () => {}, runner, config }) {
  onStage({ phase: 'Preparing audio for transcription', fraction: 0 });
  const { wav, duration } = await speechWav({ ffmpeg, inputs, work, signal });
  log({ event: 'source', role: originalInputs ? 'cleaned' : 'original', duration: Math.round(duration * 1000) / 1000, sampleRate: 16000, channels: 1 });

  // Silence map → speech intervals and ~5-minute pieces cut in pauses (audit/recovery granularity).
  const silences = await detectSilences(ffmpeg, wav, { signal });
  const speech = speechFromSilences(silences, duration);
  const pieces = piecesFor(duration, chooseCuts(duration, silences, RECOVERY.pieceSeconds, 60).slice(1).map(p => p.start));
  for (const piece of pieces) piece.hash = await pcmHash(wav, piece.start, piece.end);
  log({ event: 'pieces', pauses: silences.length, pauseThresholdDb: silences.threshold, speechSeconds: Math.round(speech.reduce((s, x) => s + x.end - x.start, 0)), pieces: pieces.map(p => ({ start: +p.start.toFixed(2), end: +p.end.toFixed(2), hash: p.hash })) });
  const duplicateAudio = pieces.filter((p, i) => pieces.findIndex(q => q.hash === p.hash) !== i);
  if (duplicateAudio.length) log({ event: 'warning', kind: 'duplicate-audio', pieces: duplicateAudio.map(p => p.index) });

  // First pass.
  const groq = options.transcriber === 'groq';
  const common = { ffmpeg, wav, duration, model: options.model, language: options.language, vocabulary: options.vocabulary, work, signal, runTool, fetchImpl };
  const first = groq
    ? await transcribeGroq({ ...common, key: secrets.groqKey, onStage: stage => onStage({ ...stage, fraction: stage.fraction * 0.8 }) })
    : await transcribeLocal({ ...common, modelsDir, onStage: stage => onStage({ ...stage, fraction: Math.min(0.8, stage.fraction) }), ...(runner ? { runner } : {}) });
  log({ event: 'decode', engine: first.engine, model: first.model, device: first.device, language: first.language,
    settings: first.settings ? { language: first.settings.language, vad: first.settings.vad, prompt: Boolean(first.settings.prompt), textContextFedBack: false } : { chunked: '10 min', textContextFedBack: false } });

  // Known Whisper artifacts (e.g. "Subtitles by the Amara.org community") are removed from whole
  // segments only, logged, and reported in the quality line — never silently.
  const artifacts = [];
  const withoutArtifacts = (list, sink) => list.filter(s => { if (!s.marker && isKnownArtifact(s.text)) { sink.push({ start: s.start, end: s.end }); return false; } return true; });
  let segments = withoutArtifacts(assemble(first.segments, log), artifacts);
  for (const a of artifacts) log({ event: 'artifact-removed', start: +a.start.toFixed(1), end: +a.end.toFixed(1) });
  let report = auditTranscript(segments, { duration, pieces, speech, config });
  log({ event: 'audit', stage: 'first-pass', status: report.status, words: report.stats.words, findings: report.findings.map(f => ({ kind: f.kind, start: +f.start.toFixed(1), end: +f.end.toFixed(1), detail: f.detail })) });

  // Recovery: re-transcribe failing pieces only, with different settings, within a fixed budget.
  const repairs = [], unresolved = [], attempts = [];
  if (report.status !== 'ok') {
    let originalWav;
    const getOriginal = async () => {
      if (!originalInputs?.length) return null;
      originalWav ||= (await speechWav({ ffmpeg, inputs: originalInputs, work, signal, name: 'original-16k.wav' })).wav;
      return originalWav;
    };
    const budget = duration * RECOVERY.budgetShare;
    let spent = 0;
    const failing = report.pieces.filter(p => !p.ok);
    for (const [n, piece] of failing.entries()) {
      signal?.throwIfAborted();
      const span = piece.end - piece.start;
      const pieceAudit = segs => auditTranscript(segs, { duration: piece.end, pieces: [piece], speech: speech.filter(x => x.end > piece.start && x.start < piece.end), config });
      const current = within(segments, piece);
      let best = { strategy: 'first-pass', segments: current, audit: pieceAudit(current) };
      best.score = qualityScore(best.audit);
      const strategies = recoveryStrategies({ first, groq, options, secrets, modelsDir, ffmpeg, wav, getOriginal, hasOriginal: async () => Boolean(originalInputs?.length), piece, speech, work, signal, fetchImpl, runner });
      let tries = 0;
      for (const strategy of strategies) {
        if (tries >= RECOVERY.maxAttemptsPerPiece || spent + span > budget) break;
        if (strategy.ready && !(await strategy.ready())) continue;   // e.g. no original audio: doesn't use an attempt
        tries++; spent += span;
        onStage({ phase: `Checking quality · re-transcribing part ${n + 1} of ${failing.length} (${strategy.label})`, fraction: 0.8 + 0.18 * n / failing.length });
        let candidate, error;
        const removed = [];
        try { candidate = withoutArtifacts(assemble(await strategy.run()), removed); }
        catch (e) { if (signal?.aborted) throw e; error = e.message; }
        const audit = candidate ? pieceAudit(candidate) : null;
        const score = audit ? qualityScore(audit) : -1;
        const entry = { piece: piece.index, start: +piece.start.toFixed(1), end: +piece.end.toFixed(1), strategy: strategy.name, status: audit?.status || 'error', score: +score.toFixed(3), words: candidate ? wordCount(candidate) : 0, error };
        attempts.push(entry); log({ event: 'retry', ...entry });
        if (candidate && (score > best.score || (audit.status === 'ok' && best.audit.status !== 'ok'))) best = { strategy: strategy.name, segments: candidate, audit, score, removed };
        if (audit?.status === 'ok') break;
      }
      segments = assemble([...without(segments, piece), ...best.segments], log);
      if (best.removed) { for (const a of artifacts.filter(a => a.start >= piece.start && a.start < piece.end)) artifacts.splice(artifacts.indexOf(a), 1); artifacts.push(...best.removed); }
      if (best.audit.status === 'ok') { if (best.strategy !== 'first-pass') repairs.push({ start: piece.start, end: piece.end, strategy: best.strategy }); }
      else unresolved.push({ start: piece.start, end: piece.end, reasons: [...new Set(best.audit.findings.map(f => f.kind))], findings: best.audit.findings });
      log({ event: 'merge', piece: piece.index, kept: best.strategy, status: best.audit.status });
    }
    // Pieces not attempted because the budget ran out stay unresolved.
    for (const piece of failing) if (!attempts.some(a => a.piece === piece.index) && !unresolved.some(u => u.start === piece.start)) {
      const audit = auditTranscript(within(segments, piece), { duration: piece.end, pieces: [piece], speech, config });
      if (audit.status !== 'ok') unresolved.push({ start: piece.start, end: piece.end, reasons: [...new Set(audit.findings.map(f => f.kind))], findings: audit.findings });
    }
  }

  // Parts that could not be repaired: keep everything outside the bad intervals, replace the bad
  // intervals with a visible marker. Never a guessed continuation.
  for (const part of unresolved) {
    const bad = mergeIntervals(part.findings.map(f => ({ start: Math.max(part.start, f.start), end: Math.min(part.end, Math.max(f.end, f.start + 1)) })));
    for (const interval of bad) {
      segments = segments.filter(s => s.marker || s.end <= interval.start || s.start >= interval.end);
      segments.push({ start: interval.start, end: interval.end, marker: true, text: `Not reliably transcribed (${timeLabel(interval.start)}–${timeLabel(interval.end)}) — check the audio. Reason: ${part.reasons.join(', ')}.` });
    }
  }
  segments = assemble(segments, log);
  for (let i = 1; i < segments.length; i++) if (segments[i].start < segments[i - 1].start) throw new Error('Internal error: transcript segments are out of order.');

  const final = auditTranscript(segments.filter(s => !s.marker), { duration, pieces, speech, config });
  const status = unresolved.length ? 'needs-review' : repairs.length ? 'repaired' : 'ok';
  log({ event: 'quality', status, finalAudit: final.status, repairs: repairs.length, unresolved: unresolved.length, attempts: attempts.length, words: wordCount(segments) });
  onStage({ phase: 'Quality check complete', fraction: 1 });
  return {
    language: first.language, model: first.model, device: first.device, engine: first.engine, duration, segments,
    quality: { status, repairs, unresolved: unresolved.map(({ findings, ...u }) => u), attempts, findings: report.findings, artifactsRemoved: artifacts.length },
  };
}

function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start), out = [];
  for (const x of sorted) { const last = out.at(-1); if (last && x.start <= last.end + 5) last.end = Math.max(last.end, x.end); else out.push({ ...x }); }
  return out;
}

/** Ordered retry strategies for one piece. Each returns segments with absolute timestamps. */
export function recoveryStrategies({ first, groq, options, secrets, modelsDir, ffmpeg, wav, getOriginal, hasOriginal = async () => false, piece, speech, work, signal, fetchImpl, runner }) {
  const list = [];
  const tag = `p${piece.index}`;
  const cut = async (source, start = piece.start, end = piece.end, name = tag) => cutWav({ ffmpeg, wav: source, start, end, target: path.join(work, `retry-${name}.wav`), signal });
  const quietMiddle = () => {
    const mid = (piece.start + piece.end) / 2;
    const gaps = [];
    for (let i = 1; i < speech.length; i++) if (speech[i - 1].end > piece.start && speech[i].start < piece.end) gaps.push((speech[i - 1].end + speech[i].start) / 2);
    return gaps.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0] ?? mid;
  };
  if (!groq) {
    const s = first.settings;
    const local = async ({ source = wav, vad = s.vad, only, modelFile = s.modelFile, start = piece.start, end = piece.end, name = tag }) => {
      const file = await cut(source, start, end, name);
      try {
        // Re-detect the language for this part when the lecture language is Auto (code-switching).
        const language = options.language === 'auto' ? await detectLanguage({ ffmpeg, wav: file, duration: end - start, model: modelFile, work, signal, runTool, ...(runner ? { runner } : {}) }) : s.language;
        const pass = await whisperPass({ modelFile, wav: file, language, prompt: s.prompt, vad, work, name: `retry-${name}`, signal, only, ...(runner ? { runner } : {}) });
        return shift(pass.segments, start);
      } finally { await rm(file, { force: true }); }
    };
    const turbo = modelPath(modelsDir, 'turbo');
    list.push({ name: 'voice-detection-toggled', label: 'different speech detection', run: () => local({ vad: !s.vad }) });
    list.push({ name: 'original-audio', label: 'original audio', ready: hasOriginal, run: async () => local({ source: await getOriginal(), name: `${tag}-original` }) });
    list.push({ name: 'recut', label: 'different boundaries', run: async () => { const middle = quietMiddle(); return [...await local({ end: middle, name: `${tag}a` }), ...await local({ start: middle, name: `${tag}b` })]; } });
    list.push({ name: 'cpu-build', label: 'processor build', ready: async () => first.build === 'gpu' && await exists(whisperBuilds.find(b => b.kind === 'cpu').program), run: () => local({ only: 'cpu' }) });
    list.push({ name: 'turbo-model', label: 'large-v3-turbo', ready: async () => s.model !== 'turbo' && (await stat(turbo).catch(() => null))?.size === WHISPER_MODELS.turbo.bytes, run: () => local({ modelFile: turbo }) });
  } else {
    const viaGroq = async (start = piece.start, end = piece.end, name = tag) => {
      const file = await cutWav({ ffmpeg, wav, start, end, target: path.join(work, `retry-${name}.flac`), signal });
      try {
        const result = await groqRequest({ file, key: secrets.groqKey, model: GROQ_MODELS[options.model] || GROQ_MODELS.turbo, language: options.language, prompt: options.vocabulary, signal, fetchImpl });
        return shift((result.segments || []).map(x => ({ start: Number(x.start) || 0, end: Number(x.end) || 0, text: String(x.text || '').trim() })), start);
      } finally { await rm(file, { force: true }); }
    };
    list.push({ name: 'recut', label: 'different boundaries', run: async () => { const middle = quietMiddle(); return [...await viaGroq(piece.start, middle, `${tag}a`), ...await viaGroq(middle, piece.end, `${tag}b`)]; } });
    list.push({ name: 'original-audio', label: 'original audio', ready: hasOriginal, run: async () => {
      const original = await getOriginal();
      const file = await cutWav({ ffmpeg, wav: original, start: piece.start, end: piece.end, target: path.join(work, `retry-${tag}-o.flac`), signal });
      try { const r = await groqRequest({ file, key: secrets.groqKey, model: GROQ_MODELS[options.model] || GROQ_MODELS.turbo, language: options.language, prompt: options.vocabulary, signal, fetchImpl }); return shift((r.segments || []).map(x => ({ start: +x.start || 0, end: +x.end || 0, text: String(x.text || '').trim() })), piece.start); }
      finally { await rm(file, { force: true }); }
    } });
  }
  return list;
}
