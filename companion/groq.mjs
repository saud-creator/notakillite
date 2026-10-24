// Optional cloud transcription through Groq's free Whisper API. Audio is uploaded to Groq,
// so this only runs when the user chooses it and has entered their own API key.
import { openAsBlob } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnLines } from './whisper.mjs';

export const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_MODELS = { turbo: 'whisper-large-v3-turbo', 'large-v3': 'whisper-large-v3' };
const CHUNK_SECONDS = 600; // 10 minutes of 16 kHz FLAC stays well under the free tier's 25 MB limit.

export function parseSilences(stderr) {
  const silences = [];
  let start;
  for (const line of stderr.split(/\r?\n/)) {
    const begin = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (begin) start = Math.max(0, Number(begin[1]));
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && start !== undefined) { silences.push({ start, end: Number(end[1]) }); start = undefined; }
  }
  return silences;
}

/**
 * Finds pauses relative to the recording's own noise floor. A fixed threshold fails on cleaned,
 * loudness-normalised lectures (pauses at -37 to -42 dB with short peaks above -35 dB, so ffmpeg's
 * silencedetect found none in a 42-minute lecture). Levels are read as they stream: spawnLines keeps
 * only the last 20 KB of stderr.
 */
export async function detectSilences(ffmpeg, wav, { signal, minSeconds = 0.4, windowSeconds = 0.1 } = {}) {
  const levels = [];
  await spawnLines(ffmpeg, ['-hide_banner', '-nostdin', '-i', wav, '-af', `aresample=16000,asetnsamples=n=${Math.round(16000 * windowSeconds)}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`, '-f', 'null', '-'], {
    signal, onLine: line => { const m = /RMS_level=(-?[\d.]+|-inf)/.exec(line); if (m) levels.push(m[1] === '-inf' ? -120 : Number(m[1])); },
  });
  return silencesFromLevels(levels, { windowSeconds, minSeconds });
}

/** Pauses = runs of windows within 6 dB of the noise floor (10th percentile), at least `minSeconds` long. */
export function silencesFromLevels(levels, { windowSeconds = 0.1, minSeconds = 0.4, margin = 6 } = {}) {
  if (!levels.length) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor((sorted.length - 1) * 0.1)];
  const threshold = Math.min(-25, Math.max(-60, floor + margin));
  const out = [];
  let start = -1;
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i] < threshold;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      if ((i - start) * windowSeconds >= minSeconds) out.push({ start: +(start * windowSeconds).toFixed(2), end: +(i * windowSeconds).toFixed(2) });
      start = -1;
    }
  }
  out.threshold = threshold;
  return out;
}

/** Picks cut points in pauses near every 10 minutes so no word is split between two requests. */
export function chooseCuts(duration, silences, target = CHUNK_SECONDS, window = 90) {
  const cuts = [0];
  while (duration - cuts.at(-1) > target + window) {
    const ideal = cuts.at(-1) + target;
    const candidates = silences.map(item => (item.start + item.end) / 2).filter(mid => Math.abs(mid - ideal) <= window && mid > cuts.at(-1) + 30);
    cuts.push(candidates.length ? candidates.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0] : ideal);
  }
  return cuts.map((start, index) => ({ start, end: cuts[index + 1] ?? duration }));
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Export cancelled.', 'AbortError')); }, { once: true });
});

export async function groqRequest({ file, key, model, language, prompt, signal, fetchImpl = fetch, attempts = 6 }) {
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append('file', await openAsBlob(file), path.basename(file));
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (language && language !== 'auto') form.append('language', language);
    if (prompt) form.append('prompt', prompt.slice(0, 600));
    let response;
    try { response = await fetchImpl(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal }); }
    catch (error) { if (signal?.aborted || attempt >= attempts) throw signal?.aborted ? error : new Error('Could not reach Groq. Check your internet connection, or use Whisper on this PC.'); await sleep(2000 * attempt, signal); continue; }
    if (response.ok) return response.json();
    if (response.status === 401 || response.status === 403) throw new Error('Groq rejected the API key. Paste a valid key in Settings → Groq API key.');
    if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : Math.min(60000, 5000 * 2 ** (attempt - 1)), signal);
      continue;
    }
    const detail = await response.text().catch(() => '');
    if (response.status === 429) throw new Error('Groq\'s free limit was reached. Try again later, or use Whisper on this PC.');
    throw new Error(`Groq could not transcribe this audio (HTTP ${response.status}). ${detail.slice(0, 200)}`.trim());
  }
}

export async function transcribeGroq({ ffmpeg, wav, duration, key, model = 'turbo', language = 'auto', vocabulary = '', work, signal, onStage = () => {}, runTool, fetchImpl }) {
  if (!key) throw new Error('Add your free Groq API key in Settings, or switch the transcript engine to Whisper on this PC.');
  onStage({ phase: 'Finding pauses for upload', fraction: 0.02 });
  const parts = chooseCuts(duration, await detectSilences(ffmpeg, wav, { signal }));
  const segments = [];
  let detected;
  for (const [index, part] of parts.entries()) {
    signal?.throwIfAborted();
    onStage({ phase: `Transcribing with Groq · part ${index + 1} of ${parts.length}`, fraction: 0.05 + 0.95 * index / parts.length });
    const chunk = path.join(work, `groq-${String(index).padStart(3, '0')}.flac`);
    await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', part.start.toFixed(3), '-to', part.end.toFixed(3), '-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'flac', chunk], { signal });
    if ((await stat(chunk)).size > 24 * 1024 * 1024) throw new Error('A lecture part is too large for Groq\'s free tier. Use Whisper on this PC for this file.');
    const result = await groqRequest({ file: chunk, key, model: GROQ_MODELS[model] || GROQ_MODELS.turbo, language, prompt: vocabulary.trim(), signal, fetchImpl });
    detected ||= result.language;
    for (const segment of result.segments || []) {
      const text = String(segment.text || '').trim();
      if (text) segments.push({ start: part.start + Number(segment.start || 0), end: part.start + Number(segment.end || 0), text });
    }
    if (!result.segments && result.text?.trim()) segments.push({ start: part.start, end: part.end, text: result.text.trim() });
    await rm(chunk, { force: true });
  }
  const names = { arabic: 'ar', english: 'en' };
  const spoken = language !== 'auto' ? language : names[String(detected || '').toLowerCase()] || detected || 'auto';
  return { language: spoken, segments, engine: 'groq', model: `Groq ${GROQ_MODELS[model] || GROQ_MODELS.turbo}`, device: 'Cloud' };
}
