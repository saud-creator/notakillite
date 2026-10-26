// Local speech-to-text with whisper.cpp. Free, offline, and private: audio never leaves the PC.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import { atomicJson, hashFile } from '../core/artifacts.mjs';
import { persistentPass, hasPersistentWorker } from './persistent-whisper.mjs';
import { capabilities, resourcePlan } from '../core/resource-policy.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const whisperDir = path.join(root, 'vendor', 'whisper');
export const vadModel = path.join(whisperDir, 'ggml-silero-v6.2.0.bin');
const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
// The Vulkan bundle runs on AMD/NVIDIA/Intel GPUs and falls back to its own CPU backends.
export const whisperBuilds = [
  { kind: 'cuda', program:path.join(whisperDir,'cuda',exe) },
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
  const installed = await Promise.all(whisperBuilds.map(b=>exists(b.program))); const gpu=installed.some((v,i)=>v&&whisperBuilds[i].kind!=='cpu'), cpu=installed.some((v,i)=>v&&whisperBuilds[i].kind==='cpu'), vad=await exists(vadModel);
  const models = {};
  for (const name of Object.keys(WHISPER_MODELS)) {
    const info = await stat(modelPath(modelsDir, name)).catch(() => null);
    models[name] = info?.size === WHISPER_MODELS[name].bytes && await verifiedModel(modelPath(modelsDir,name),WHISPER_MODELS[name]);
  }
  return { installed: (gpu || cpu) && vad, gpuBuild: gpu, models };
}

/** Downloads a pinned model once, verifying its SHA-256 before it can be used. */
const modelTransfers = new Map();
export async function verifiedModel(target, model) {
  const info = await stat(target).catch(() => null); if (!info || info.size !== model.bytes) return false;
  const identity = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const receipt = await readFile(`${target}.verified.json`, 'utf8').then(JSON.parse).catch(() => null);
  if (receipt?.identity === identity && receipt.sha256 === model.sha256) return true;
  if (await hashFile(target) !== model.sha256) return false;
  await atomicJson(`${target}.verified.json`, { identity, sha256:model.sha256 }); return true;
}
export async function ensureModel(name, directory, options = {}) {
  const model = WHISPER_MODELS[name]; if (!model) throw new Error('Choose a supported Whisper model.');
  const target = modelPath(directory,name); options.signal?.throwIfAborted();
  if (modelTransfers.has(target)) { await modelTransfers.get(target); options.signal?.throwIfAborted(); return target; }
  const transfer = downloadModelFile(target,model,name,options); modelTransfers.set(target,transfer);
  try { return await transfer; } finally { modelTransfers.delete(target); }
}
async function downloadModelFile(target,model,name,{signal,onProgress=()=>{},fetchImpl=fetch}) {
  if (await verifiedModel(target,model)) return target;
  await mkdir(path.dirname(target),{recursive:true}); const partial = `${target}.partial`;
  let received = (await stat(partial).catch(()=>null))?.size || 0;
  if (received > model.bytes) { await rm(partial,{force:true}); received=0; }
  if (received < model.bytes) {
    const response = await fetchImpl(modelUrl(name),{signal,redirect:'follow',headers:received?{Range:`bytes=${received}-`}:{}});
    if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}).`);
    if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${received}-`)) throw new Error('Invalid resumed download range.');
    if (response.status !== 206) received=0;
    const body=Readable.fromWeb(response.body); let tooLarge=false;
    body.on('data',chunk=>{received+=chunk.length;if(received>model.bytes){tooLarge=true;body.destroy(new Error('Model download exceeds expected size.'));} onProgress(Math.min(1,received/model.bytes));});
    try { await pipeline(body,createWriteStream(partial,{flags:response.status===206?'a':'w'}),{signal}); }
    catch(e) { if(tooLarge) await rm(partial,{force:true}); throw e; }
  }
  if ((await stat(partial)).size !== model.bytes || await hashFile(partial) !== model.sha256) { await rm(partial,{force:true}); throw new Error('Model download checksum failed.'); }
  await rename(partial,target); await verifiedModel(target,model); return target;
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
  for (const build of whisperBuilds) if ((!only || build.kind === only || only === 'vulkan' && build.kind === 'gpu') && await exists(build.program)) builds.push(build);
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

/** CLI compatibility fallback: no generated text context, fixed vocabulary prefix only.
 * The native worker enforces the actual 96-token vocabulary budget with whisper_tokenize.
 */
export function contextArgs(prompt = '') {
  const text=prompt.trim();
  return text ? ['--prompt',text,'--carry-initial-prompt','-mc','1'] : ['-mc','0'];
}

export const VAD_ARGS = ['--vad', '-vm', vadModel, '-vsd', '500', '-vp', '200'];

/** Arguments for one whisper-cli run over `wav`. Never uses -ot/-d (with --vad they count time
 *  on the silence-removed timeline): to transcribe an interval, cut the audio instead. */
export function whisperArgs({ modelFile, wav, language, prompt = '', vad = true, output, threadCount }) {
  return ['-m', modelFile, '-f', wav, '-l', language || 'auto', '-t', String(threadCount || 1), '-oj', '-of', output, '-pp', '-sns',
    ...(vad ? VAD_ARGS : []), ...contextArgs(prompt)];
}

/** One whisper-cli pass; segments are relative to the start of `wav`. */
export async function whisperPass({ modelFile, wav, language, prompt, vad = true, work, name = 'whisper', signal, onLine, only, threadCount, backend = 'auto', runner = runWhisper, production = runner === runWhisper }) {
  if (production) { const result = await persistentPass({ modelFile, wav, language, prompt, threadCount, signal, backend }); if (result) return result; }
  const output = path.join(work, name);
  await rm(`${output}.json`, { force: true });
  let result;
  try { result = await runner(whisperArgs({ modelFile, wav, language, prompt, vad, output, threadCount }), { signal, onLine, only }); }
  catch(error) { if(signal?.aborted || !vad || !production) throw error; await rm(`${output}.json`,{force:true}); result = await runner(whisperArgs({modelFile,wav,language,prompt,vad:false,output,threadCount}),{signal,onLine,only}); result.fallback='voice-detector-disabled-after-error'; }
  const parsed = parseWhisperJson(await readFile(`${output}.json`, 'utf8'));
  await rm(`${output}.json`, { force: true });
  return { ...parsed, build: result.build, device: /(?:using (?:CUDA|Vulkan\d+)|offload(?:ed|ing).*(?:GPU|device)|ggml_(?:cuda|vulkan).*using device)/i.test(result.stderr || '') ? 'GPU' : 'CPU' };
}

export function parseWhisperJson(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const segments = (data.transcription || []).map(item => ({ start: item.offsets.from / 1000, end: item.offsets.to / 1000, text: String(item.text || '').trim() })).filter(item => item.text);
  return { language: data.result?.language || data.params?.language, segments };
}

export async function transcribeLocal({ ffmpeg, wav, duration, model = 'turbo', language = 'auto', vocabulary = '', modelsDir, work, signal, onStage = () => {}, runTool, fetchImpl, runner = runWhisper, threads: threadCount, backend = 'auto', name = 'whisper', modelResolver = ensureModel }) {
  threadCount ||= resourcePlan(await capabilities()).threads;
  const selectedRunner = runner;
  if (['cuda','vulkan'].includes(backend) && !(await exists(whisperBuilds.find(b=>b.kind===(backend==='vulkan'?'gpu':'cuda')).program))) throw new Error(`The selected ${backend} backend is not installed.`);
  if (backend === 'cpu' && !process.env.NOTAKILLITE_WORKER) runner = (args, opts) => selectedRunner(args, { ...opts, only: 'cpu' });
  const modelFile = await modelResolver(model, modelsDir, { signal, fetchImpl, onProgress: fraction => onStage({ phase: `Downloading ${WHISPER_MODELS[model].label} (one time) · ${Math.round(fraction * 100)}%`, fraction: fraction * 0.3 }) });
  if (!(await exists(vadModel))) throw new Error('The Whisper voice detector is missing. Reinstall Notakillite.');
  let spoken = language;
  if (language === 'auto' && !(await hasPersistentWorker(backend))) {
    onStage({ phase: 'Detecting lecture language', fraction: 0.3 });
    spoken = await detectLanguage({ ffmpeg, wav, duration, model: modelFile, work, signal, runTool, runner });
  }
  const prompt = whisperPrompt(spoken, vocabulary);
  onStage({ phase: `Transcribing · ${WHISPER_MODELS[model].label}`, fraction: 0.32 });
  const pass = await whisperPass({ modelFile, wav, language: spoken, prompt, work, name, signal, runner, backend, threadCount, production:selectedRunner === runWhisper, onLine: line => {
    const match = /progress\s*=\s*(\d+)%/.exec(line);
    if (match) onStage({ phase: `Transcribing ${match[1]}% · ${WHISPER_MODELS[model].label}`, fraction: 0.32 + Number(match[1]) / 100 * 0.5 });
  } });
  return { language: spoken === 'auto' ? pass.language : spoken, segments: pass.segments, engine: 'local', model: WHISPER_MODELS[model].label, device: pass.device, build: pass.build,
    nativeMetrics:pass.nativeMetrics, settings: { modelFile, model, language: spoken, prompt, vad: true }, runner };
}
