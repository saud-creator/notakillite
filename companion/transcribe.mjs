import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runTool } from './audio.mjs';
import { wavSamples } from './engines.mjs';
import { transcribeLocal } from './whisper.mjs';
import { transcribeGroq } from './groq.mjs';

export const TRANSCRIBER_NAMES = { local: 'Whisper on this PC', groq: 'Groq Whisper (cloud)' };

/** Decodes one or more consecutive audio files into a single 16 kHz mono WAV for Whisper. */
export async function speechWav({ ffmpeg, inputs, work, signal }) {
  const wav = path.join(work, 'speech-16k.wav');
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (inputs.length > 1) {
    const list = path.join(work, 'speech-parts.txt');
    await writeFile(list, inputs.map(file => `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'));
    args.push('-f', 'concat', '-safe', '0', '-i', list);
  } else args.push('-i', inputs[0]);
  args.push('-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
  await runTool(ffmpeg, args, { signal });
  const duration = await wavSamples(wav) / 16000;
  return { wav, duration };
}

/**
 * Transcribes `inputs` (cleaned or original audio) with the chosen engine.
 * Returns { language, segments: [{ start, end, text }], engine, model, device, duration }.
 */
export async function transcribeAudio({ ffmpeg, inputs, work, options, secrets = {}, modelsDir, signal, onStage = () => {}, fetchImpl }) {
  onStage({ phase: 'Preparing audio for transcription', fraction: 0 });
  const { wav, duration } = await speechWav({ ffmpeg, inputs, work, signal });
  const common = { ffmpeg, wav, duration, model: options.model, language: options.language, vocabulary: options.vocabulary, work, signal, onStage, runTool, fetchImpl };
  const result = options.transcriber === 'groq'
    ? await transcribeGroq({ ...common, key: secrets.groqKey })
    : await transcribeLocal({ ...common, modelsDir });
  return { ...result, duration };
}
