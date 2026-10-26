import { access, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const assets = {
  rnnoise: path.join(root, 'vendor', 'rnnoise', 'cb.rnnn'),
  deepfilter: path.join(root, 'vendor', 'deepfilternet', 'deep-filter.exe'),
  deepfilterModel: path.join(root, 'vendor', 'deepfilternet', 'DeepFilterNet3_onnx.tar.gz'),
};
export const ENGINE_NAMES = { classic: 'Light cleanup', rnnoise: 'RNNoise', deepfilter: 'DeepFilterNet3', hybrid: 'RNNoise + DeepFilterNet3', none: 'No noise reduction' };
export function settings(data = {}) {
  const engine = data.clean === false ? 'none' : data.engine || 'classic';
  const strength = data.strength || 'balanced';
  if (!Object.hasOwn(ENGINE_NAMES, engine) || !['balanced', 'strong'].includes(strength)) throw new Error('Choose a supported noise reduction engine and strength.');
  if (![0, 10, 20, 30].includes(data.splitMinutes ?? 20)) throw new Error('Choose a supported chunk length.');
  return { ...data, clean: engine !== 'none', engine, strength, splitMinutes: data.splitMinutes ?? 20, ...transcriptSettings(data) };
}
export const TRANSCRIPT_DEFAULTS = { transcribe: true, transcriber: 'local', language: 'auto', model: 'turbo', transcribeFrom: 'cleaned', vocabulary: '', aiPrompt: true, resourcePolicy: 'auto', threads: 0, workers: 1, chunkSeconds: 60, backend: 'auto', ocr: false, pdfBias: false };
export function transcriptSettings(data = {}) {
  const value = { ...TRANSCRIPT_DEFAULTS };
  for (const key of Object.keys(value)) if (data[key] !== undefined && data[key] !== null) value[key] = data[key];
  if (typeof value.transcribe !== 'boolean' || typeof value.aiPrompt !== 'boolean' || typeof value.ocr !== 'boolean' || typeof value.pdfBias !== 'boolean') throw new Error('Choose whether to create a transcript.');
  if (!['local', 'groq'].includes(value.transcriber)) throw new Error('Choose Whisper on this PC or Groq for transcripts.');
  if (!['auto', 'ar', 'en'].includes(value.language)) throw new Error('Choose Auto, Arabic, or English as the lecture language.');
  if (!['turbo', 'large-v3', 'base', 'tiny'].includes(value.model)) throw new Error('Choose a supported Whisper model.');
  if (!['cleaned', 'original'].includes(value.transcribeFrom)) throw new Error('Choose cleaned or original audio for the transcript.');
  if (typeof value.vocabulary !== 'string' || value.vocabulary.length > 600) throw new Error('Keep course vocabulary under 600 characters.');
  if (!['auto','background','maximum'].includes(value.resourcePolicy) || !['auto','cpu','vulkan','cuda'].includes(value.backend)) throw new Error('Invalid resource policy or backend.');
  if (![0,30,60,120].includes(value.chunkSeconds) || !Number.isInteger(value.workers) || value.workers < 1 || value.workers > 16 || !Number.isInteger(value.threads) || value.threads < 0 || value.threads > 1024) throw new Error('Invalid processing limits.');
  return value;
}
export async function availableEngines() {
  const exists = file => access(file, constants.R_OK).then(() => true, () => false);
  const [rnnoise, binary, model] = await Promise.all([exists(assets.rnnoise), exists(assets.deepfilter), exists(assets.deepfilterModel)]);
  const deepfilter = process.platform === 'win32' && binary && model;
  return { classic: true, rnnoise, deepfilter, hybrid: rnnoise && deepfilter };
}
export async function requireEngine(engine) {
  if (engine === 'none') return;
  if (!(await availableEngines())[engine]) throw new Error(`${ENGINE_NAMES[engine]} is not installed. Open the latest Notakillite EXE, which includes both engines.`);
}
export async function wavSamples(filename) {
  const file = await open(filename, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Could not read decoded audio.');
    let align;
    for (let offset = 12; offset + 8 <= bytesRead;) {
      const type = header.toString('ascii', offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      if (type === 'fmt ') align = header.readUInt16LE(offset + 20);
      if (type === 'data' && align) return size / align;
      offset += 8 + size + (size % 2);
    }
    throw new Error('Could not read decoded audio sample count.');
  } finally { await file.close(); }
}
