#!/usr/bin/env node
// Headless Notakillite: clean lecture audio and write one Markdown transcript per recording.
//
//   node scripts/transcribe.mjs <audio | .note | .zip | folder> ... [options]
//
//   --out <folder>          where to save results (default: ./notakillite-output)
//   --engine local|groq     transcript engine (default: local Whisper)
//   --language auto|ar|en   spoken language (default: auto, for mixed Arabic/English)
//   --model turbo|large-v3  Whisper model (default: turbo)
//   --cleanup deepfilter|rnnoise|hybrid|classic|none   noise reduction (default: deepfilter)
//   --from cleaned|original transcribe the cleaned or the original audio (default: cleaned)
//   --vocabulary "terms"    course words to help spelling (drug names, etc.)
//   --no-transcript         only clean the audio
//   --no-prompt             omit the ChatGPT/Claude instructions at the top of each file
//
// Groq needs GROQ_API_KEY in the environment.
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { CoreService } from '../core/service.mjs';

const args = process.argv.slice(2);
const files = [], flags = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') { console.log((await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map(line => line.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
  if (arg === '--no-transcript') flags.transcribe = false;
  else if (arg === '--no-prompt') flags.aiPrompt = false;
  else if (arg.startsWith('--')) flags[arg.slice(2)] = args[++i];
  else files.push(path.resolve(arg));
}
if (!files.length) { console.error('Usage: node scripts/transcribe.mjs <audio | .note | folder> ... [--out folder] [--engine local|groq] [--language auto|ar|en]'); process.exit(2); }

// Share downloaded Whisper models with the desktop app instead of downloading them again.
process.env.NOTAKILLITE_MODELS_DIR ||= path.join(process.env.LOCALAPPDATA || os.homedir(), 'Notakillite', 'models');
flags.out ||= path.join(process.cwd(), 'notakillite-output');
const dataRoot = process.env.NOTAKILLITE_DATA_DIR ? undefined : await mkdtemp(path.join(os.tmpdir(), 'notakillite-cli-'));
const service = await new CoreService({ dataRoot, connector: { async close() {}, async state() { throw new Error('The command line works with files only.'); } } }).init();
let exitCode = 0;
try {
  if (process.env.GROQ_API_KEY) await service.handle('secrets', { groqKey: process.env.GROQ_API_KEY });
  if (flags.out) service.savePreferences({ outputPath: path.resolve(flags.out) });
  const { ids } = await service.enqueue({ files, engine: flags.cleanup || 'deepfilter', splitMinutes: 0, transcribe: flags.transcribe ?? true, transcriber: flags.engine || 'local', language: flags.language || 'auto', model: flags.model || 'turbo', transcribeFrom: flags.from || 'cleaned', vocabulary: flags.vocabulary || '', aiPrompt: flags.aiPrompt ?? true });
  console.log(`Queued ${ids.length} recording${ids.length === 1 ? '' : 's'}.`);
  const seen = new Map();
  for (;;) {
    const jobs = ids.map(id => service.jobs.find(job => job.id === id));
    for (const job of jobs) {
      const line = `${String(job.order).padStart(2, '0')} ${job.title} · ${job.status === 'running' ? job.phase : job.status}`;
      if (seen.get(job.id) !== line) { seen.set(job.id, line); console.log(line); }
    }
    if (jobs.every(job => ['done', 'error', 'cancelled', 'interrupted'].includes(job.status))) {
      for (const job of jobs) if (job.status !== 'done') { exitCode = 1; console.error(`✖ ${job.title}: ${job.error}`); }
      const folder = jobs.find(job => job.destination)?.destination;
      if (folder) console.log(`\nSaved to ${folder}`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} catch (error) { console.error(error.message); exitCode = 1; }
finally { await service.close(); if (dataRoot && !process.env.NOTAKILLITE_KEEP_DATA) await rm(path.join(dataRoot, 'temp'), { recursive: true, force: true }); }
process.exit(exitCode);
