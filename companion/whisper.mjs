// Local speech-to-text with whisper.cpp. Free, offline, and private: audio never leaves the PC.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const whisperDir = path.join(root, 'vendor', 'whisper');
export const vadModel = path.join(whisperDir, 'ggml-silero-v6.2.0.bin');
const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
// The Vulkan bundle runs on AMD/NVIDIA/Intel GPUs and falls back to its own CPU backends.
export const whisperBuilds = [
  { kind: 'gpu', program: path.join(whisperDir, 'vulkan', exe) },
  { kind: 'cpu', program: path.join(whisperDir, 'cpu', exe) },
];

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1';
export const WHISPER_MODELS = {
  turbo: { file: 'ggml-large-v3-turbo-q8_0.bin', bytes: 874188075, sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1', label: 'Whisper large-v3-turbo' },
  'large-v3': { file: 'ggml-large-v3.bin', bytes: 3095033483, sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2', label: 'Whisper large-v3' },
  base: { file: 'ggml-base.bin', bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', label: 'Whisper base' },
  tiny: { file: 'ggml-tiny.bin', bytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', label: 'Whisper tiny' },
};
export const modelUrl = name => `${HF}/${WHISPER_MODELS[name].file}`;

const exists = file => access(file).then(() => true, () => false);
export const modelsDirectory = dataRoot => process.env.NOTAKILLITE_MODELS_DIR || path.join(dataRoot, 'models');
export const modelPath = (directory, name) => path.join(directory, WHISPER_MODELS[name].file);

export async function whisperStatus(modelsDir) {
  const [gpu, cpu, vad] = await Promise.all([exists(whisperBuilds[0].program), exists(whisperBuilds[1].program), exists(vadModel)]);
  const models = {};
  for (const name of Object.keys(WHISPER_MODELS)) {
    const info = await stat(modelPath(modelsDir, name)).catch(() => null);
    models[name] = info?.size === WHISPER_MODELS[name].bytes;
  }
  return { installed: (gpu || cpu) && vad, gpuBuild: gpu, models };
}

/** Downloads a pinned model once, verifying its SHA-256 before it can be used. */
export async function ensureModel(name, directory, { signal, onProgress = () => {}, fetchImpl = fetch } = {}) {
  const model = WHISPER_MODELS[name];
  if (!model) throw new Error('Choose a supported Whisper model.');
  const target = modelPath(directory, name);
  if ((await stat(target).catch(() => null))?.size === model.bytes) return target;
  await mkdir(directory, { recursive: true });
  const partial = `${target}.partial`;
  await rm(partial, { force: true });
  const response = await fetchImpl(modelUrl(name), { signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Could not download the ${model.label} model (HTTP ${response.status}). Check your internet connection and retry.`);
  const hash = createHash('sha256');
  let received = 0, reported = -1;
  const body = Readable.fromWeb(response.body);
  body.on('data', chunk => {
    hash.update(chunk); received += chunk.length;
    const percent = Math.floor(received / model.bytes * 100);
    if (percent !== reported) { reported = percent; onProgress(received / model.bytes); }
  });
  try { await pipeline(body, createWriteStream(partial), { signal }); }
  catch (error) { await rm(partial, { force: true }); throw error; }
  if (received !== model.bytes || hash.digest('hex') !== model.sha256) { await rm(partial, { force: true }); throw new Error(`The ${model.label} download was incomplete or changed. Retry the export.`); }
  await rename(partial, target);
  return target;
}

/** Runs a process, streaming stderr lines to `onLine`, with cancellation and a timeout. */
export function spawnLines(program, args, { signal, timeout = 6 * 60 * 60 * 1000, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '', pending = '', timedOut = false, startupError;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-200000); });
    child.stderr.on('data', bytes => {
      stderr = (stderr + bytes).slice(-20000);
      pending += bytes;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.on('error', error => { startupError = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (pending) onLine(pending);
      if (signal?.aborted) reject(new DOMException('Export cancelled.', 'AbortError'));
      else if (startupError) reject(new Error(`Could not start ${path.basename(program)}: ${startupError.message}`));
      else if (timedOut) reject(new Error('Transcription took too long. Try the Fast model or Groq.'));
      else resolve({ code, stdout, stderr });
    });
  });
}

const threads = () => String(Math.max(2, Math.min(8, os.availableParallelism?.() ?? os.cpus().length)));
let workingBuild; // Remember which build works on this PC after the first run.

export async function runWhisper(args, { signal, onLine, only } = {}) {
  const builds = [];
  for (const build of whisperBuilds) if ((!only || build.kind === only) && await exists(build.program)) builds.push(build);
  if (!builds.length) throw new Error('Whisper is not installed. Reinstall Notakillite, or choose Groq in the transcript settings.');
  if (workingBuild) builds.sort((a, b) => (b.kind === workingBuild) - (a.kind === workingBuild));
  let last;
  for (const build of builds) {
    const result = await spawnLines(build.program, args, { signal, onLine });
    if (result.code === 0) { workingBuild = build.kind; return { ...result, build: build.kind }; }
    last = result;
  }
  throw new Error(`Whisper could not transcribe this audio (${last.code}). ${last.stderr.split(/\r?\n/).filter(line => /error|failed/i.test(line)).slice(-3).join(' ')}`.trim());
}

export function parseDetectedLanguage(text) {
  const match = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i.exec(text);
  return match ? { language: match[1], probability: Number(match[2]) } : null;
}

/**
 * whisper.cpp detects the language once per file. Mixed Arabic/English lectures can open
 * with either, so vote across short samples from the whole lecture instead.
 */
export async function detectLanguage({ ffmpeg, wav, duration, model, work, signal, runTool, runner = runWhisper }) {
  const votes = new Map();
  const positions = duration > 120 ? [0.15, 0.45, 0.75].map(at => Math.floor(duration * at)) : [0];
  for (const [index, start] of positions.entries()) {
    const sample = path.join(work, `language-${index}.wav`);
    await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', String(start), '-t', '30', '-i', wav, '-c:a', 'pcm_s16le', sample], { signal });
    const result = await runner(['-m', model, '-f', sample, '-l', 'auto', '-dl', '-t', threads()], { signal });
    const detected = parseDetectedLanguage(result.stderr);
    if (detected) votes.set(detected.language, (votes.get(detected.language) || 0) + detected.probability);
    await rm(sample, { force: true });
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'auto';
}

// A short bilingual prompt nudges Whisper to keep English terms in Latin script inside Arabic speech.
export function whisperPrompt(language, vocabulary = '') {
  const terms = vocabulary.trim().replace(/\s+/g, ' ').slice(0, 400);
  const base = language === 'ar' ? 'محاضرة جامعية بالعربية مع مصطلحات إنجليزية مثل diagnosis و treatment.' : '';
  return [base, terms].filter(Boolean).join(' ');
}

/**
 * Text-context arguments. whisper.cpp normally feeds the last ~224 decoded tokens back into every
 * 30-second window; one stuck sentence then re-primes every later window (the P0 "971 repeats"
 * failure, see docs/transcription-reliability.md). We never feed decoded text back:
 *  - no prompt: `-mc 0` (no text context at all);
 *  - with a prompt (course vocabulary / Arabic hint): the prompt is carried as a fixed prefix and
 *    the context budget is (prompt words + 1). Every word is at least one token, so the prefix
 *    fills the budget and no decoded tokens fit after it.
 */
export function contextArgs(prompt = '') {
  const text = prompt.trim();
  if (!text) return ['-mc', '0'];
  return ['--prompt', text, '--carry-initial-prompt', '-mc', String(text.split(/\s+/).length + 1)];
}

export const VAD_ARGS = ['--vad', '-vm', vadModel, '-vsd', '500', '-vp', '200'];

/** Arguments for one whisper-cli run over `wav`. Never uses -ot/-d (with --vad they count time
 *  on the silence-removed timeline): to transcribe an interval, cut the audio instead. */
export function whisperArgs({ modelFile, wav, language, prompt = '', vad = true, output }) {
  return ['-m', modelFile, '-f', wav, '-l', language || 'auto', '-t', threads(), '-oj', '-of', output, '-pp', '-sns',
    ...(vad ? VAD_ARGS : []), ...contextArgs(prompt)];
}

/** One whisper-cli pass; segments are relative to the start of `wav`. */
export async function whisperPass({ modelFile, wav, language, prompt, vad = true, work, name = 'whisper', signal, onLine, only, runner = runWhisper }) {
  const output = path.join(work, name);
  await rm(`${output}.json`, { force: true });
  const result = await runner(whisperArgs({ modelFile, wav, language, prompt, vad, output }), { signal, onLine, only });
  const parsed = parseWhisperJson(await readFile(`${output}.json`, 'utf8'));
  await rm(`${output}.json`, { force: true });
  return { ...parsed, build: result.build, device: result.build === 'gpu' && !/no GPU found/i.test(result.stderr || '') ? 'GPU' : 'CPU' };
}

export function parseWhisperJson(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const segments = (data.transcription || []).map(item => ({ start: item.offsets.from / 1000, end: item.offsets.to / 1000, text: String(item.text || '').trim() })).filter(item => item.text);
  return { language: data.result?.language || data.params?.language, segments };
}

export async function transcribeLocal({ ffmpeg, wav, duration, model = 'turbo', language = 'auto', vocabulary = '', modelsDir, work, signal, onStage = () => {}, runTool, fetchImpl, runner = runWhisper }) {
  const modelFile = await ensureModel(model, modelsDir, { signal, fetchImpl, onProgress: fraction => onStage({ phase: `Downloading ${WHISPER_MODELS[model].label} (one time) · ${Math.round(fraction * 100)}%`, fraction: fraction * 0.3 }) });
  if (!(await exists(vadModel))) throw new Error('The Whisper voice detector is missing. Reinstall Notakillite.');
  let spoken = language;
  if (language === 'auto') {
    onStage({ phase: 'Detecting lecture language', fraction: 0.3 });
    spoken = await detectLanguage({ ffmpeg, wav, duration, model: modelFile, work, signal, runTool, runner });
  }
  const prompt = whisperPrompt(spoken, vocabulary);
  onStage({ phase: `Transcribing · ${WHISPER_MODELS[model].label}`, fraction: 0.32 });
  const pass = await whisperPass({ modelFile, wav, language: spoken, prompt, work, signal, runner, onLine: line => {
    const match = /progress\s*=\s*(\d+)%/.exec(line);
    if (match) onStage({ phase: `Transcribing ${match[1]}% · ${WHISPER_MODELS[model].label}`, fraction: 0.32 + Number(match[1]) / 100 * 0.5 });
  } });
  return { language: spoken === 'auto' ? pass.language : spoken, segments: pass.segments, engine: 'local', model: WHISPER_MODELS[model].label, device: pass.device, build: pass.build,
    settings: { modelFile, model, language: spoken, prompt, vad: true }, runner };
}
