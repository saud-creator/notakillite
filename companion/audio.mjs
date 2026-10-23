import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assets, ENGINE_NAMES, requireEngine, settings, wavSamples } from './engines.mjs';

export function safeName(value = 'Lecture') {
  const name = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'Lecture';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}
function filterPath(filename) {
  // Escape the option value first, then escape it for the enclosing filtergraph.
  return filename.replaceAll('\\', '/').replace(/[:'\\]/g, value => `\\${value}`).replace(/[\\'\[\],;]/g, value => `\\${value}`);
}
function rnnoiseFilter(strength) { return `aresample=48000,arnndn=m=${filterPath(assets.rnnoise)}:mix=${strength === 'strong' ? 1 : 0.85}`; }
const classic = 'highpass=f=80,lowpass=f=10000,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11';
const normalize = 'highpass=f=60,loudnorm=I=-16:TP=-1.5:LRA=11';

export function audioArguments(input, destination, data = {}) {
  const options = settings(data);
  const args = ['-hide_banner', '-nostdin', '-y', ...(options.concat ? ['-f', 'concat', '-safe', '1'] : []), '-i', input, '-map', '0:a:0', '-vn'];
  if (options.clean) args.push('-af', options.engine === 'classic' ? classic : `${options.engine === 'rnnoise' ? `${rnnoiseFilter(options.strength)},` : ''}${normalize}`);
  args.push('-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', '-progress', 'pipe:1');
  if (options.splitMinutes) args.push('-f', 'segment', '-segment_time', String(options.splitMinutes * 60), '-reset_timestamps', '1');
  args.push(path.join(destination, options.splitMinutes ? 'lecture-%03d.mp3' : 'lecture.mp3'));
  return args;
}
export function runTool(program, args, { onProgress = () => {}, timeout = 30 * 60 * 1000, signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let diagnostic = '', progress = '', timedOut = false, startupError;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', bytes => {
      progress = (progress + bytes).slice(-4000);
      for (const match of progress.matchAll(/out_time_us=(\d+)\r?\n/g)) onProgress(Number(match[1]) / 1e6);
      progress = progress.slice(progress.lastIndexOf('\n') + 1);
    });
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-3000); });
    child.on('error', error => { startupError = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (signal?.aborted) reject(new DOMException('Export cancelled.', 'AbortError'));
      else if (startupError) reject(new Error(`Could not start ${path.basename(program)}: ${startupError.message}`));
      else if (timedOut) reject(new Error('Audio processing took too long. Try a shorter recording.'));
      else if (code === 0) resolve();
      else reject(new Error(`Audio processing failed (${code}). ${diagnostic.slice(-900)}`));
    });
  });
}
const base = ['-hide_banner', '-nostdin', '-y'];

async function deepFilter({ ffmpeg, input, work, options, onProgress, onStage, signal }) {
  onStage({ phase: 'Decoding audio to 48 kHz', fraction: 0.04 });
  const decode = [...base, '-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000'];
  if (options.engine === 'hybrid') decode.push('-af', rnnoiseFilter(options.strength));
  decode.push('-c:a', 'pcm_f32le', '-f', 'segment', '-segment_time', '120', '-reset_timestamps', '1', '-progress', 'pipe:1', path.join(work, 'input-%05d.wav'));
  await runTool(ffmpeg, decode, { onProgress, signal });
  const chunks = (await readdir(work)).filter(name => /^input-\d+\.wav$/.test(name)).sort();
  if (!chunks.length) throw new Error('The recording contains no decodable audio.');
  const counts = await Promise.all(chunks.map(name => wavSamples(path.join(work, name))));
  const cleaned = [];
  for (let index = 0; index < chunks.length; index++) {
    signal?.throwIfAborted();
    onStage({ phase: `${ENGINE_NAMES[options.engine]} · part ${index + 1} of ${chunks.length}`, fraction: 0.12 + 0.73 * index / chunks.length, part: index + 1, parts: chunks.length });
    const contextual = path.join(work, 'context.wav');
    const args = [...base];
    if (index) args.push('-i', path.join(work, chunks[index - 1]));
    else args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono');
    args.push('-i', path.join(work, chunks[index]));
    if (index + 1 < chunks.length) args.push('-i', path.join(work, chunks[index + 1]));
    else args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono');
    // Neighboring context warms each chunk's model state. Tail padding avoids
    // losing final syllables when the CLI compensates its model latency.
    const start = index ? Math.max(0, counts[index - 1] / 48000 - 0.5) : 0;
    args.push('-filter_complex', `[0:a]atrim=start=${start}:duration=0.5,asetpts=PTS-STARTPTS[a];[1:a]asetpts=PTS-STARTPTS[b];[2:a]atrim=duration=0.5,apad=whole_dur=0.5,atrim=duration=0.5,asetpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=0:a=1[out]`, '-map', '[out]', '-c:a', 'pcm_f32le', contextual);
    await runTool(ffmpeg, args, { signal });
    const enhanced = path.join(work, 'enhanced');
    await runTool(assets.deepfilter, ['--model', assets.deepfilterModel, '--compensate-delay', '--atten-lim-db', options.strength === 'strong' ? '40' : '24', '--output-dir', enhanced, contextual], { signal });
    const target = `clean-${String(index).padStart(5, '0')}.wav`;
    await runTool(ffmpeg, [...base, '-i', path.join(enhanced, 'context.wav'), '-af', `atrim=start_sample=24000:end_sample=${24000 + counts[index]},asetpts=PTS-STARTPTS`, '-c:a', 'pcm_f32le', path.join(work, target)], { signal });
    if (await wavSamples(path.join(work, target)) !== counts[index]) throw new Error('Noise reduction returned incomplete audio. Please try exporting the original recording.');
    cleaned.push(target);
  }
  const list = path.join(work, 'cleaned.txt');
  await writeFile(list, cleaned.map(name => `file '${name}'`).join('\n'));
  return list;
}

export async function processAudio({ ffmpeg, input, destination, metadata, onProgress = () => {}, onStage = () => {}, signal }) {
  const options = settings(metadata);
  await requireEngine(options.engine);
  await mkdir(destination, { recursive: true });
  const work = await mkdtemp(path.join(path.dirname(input), 'denoise-'));
  try {
    let encodedInput = input, concat = false;
    if (['deepfilter', 'hybrid'].includes(options.engine)) {
      encodedInput = await deepFilter({ ffmpeg, input, work, options, onProgress, onStage, signal });
      concat = true;
    }
    onStage({ phase: options.clean ? `Encoding MP3 · ${ENGINE_NAMES[options.engine]}` : 'Encoding MP3', fraction: concat ? 0.88 : 0.1 });
    let encodedSeconds = 0;
    await runTool(ffmpeg, audioArguments(encodedInput, destination, { ...options, concat }), { onProgress: seconds => { encodedSeconds = Math.max(encodedSeconds, seconds); onProgress(seconds); }, signal });
    const files = (await readdir(destination)).filter(name => name.endsWith('.mp3')).sort();
    if (!files.length) throw new Error('The recording contains no decodable audio.');
    const manifest = {
      title: metadata.title, recording: metadata.recordingName, source: metadata.source || 'Notability web account',
      exportedAt: new Date().toISOString(), format: 'MP3, mono, 24 kHz, 64 kbps',
      speechCleanup: options.clean, noiseReductionEngine: options.engine, noiseReductionName: ENGINE_NAMES[options.engine],
      strength: options.clean ? options.strength : null, chunkMinutes: options.splitMinutes,
      encodedSeconds,
      files: await Promise.all(files.map(async name => ({ name, bytes: (await stat(path.join(destination, name))).size }))),
    };
    await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(destination, 'READ ME.txt'), `${metadata.title}\n${metadata.recordingName}\n\nUpload the MP3 files to an AI service that accepts audio. Files are ordered in lecture sequence.\n\nNoise reduction: ${ENGINE_NAMES[options.engine]}${options.clean ? ` (${options.strength})` : ''}. Noise reduction can affect quiet speech; retain your original recording. No audio has been sent to an AI service by this app.\n\nSuggested prompt: Transcribe this lecture accurately. Preserve technical terms, explain the main ideas, and list uncertain or inaudible passages. These files are consecutive parts of the same lecture.\n`);
    onStage({ phase: 'Complete', fraction: 1 });
    return manifest;
  } catch (error) {
    if (/Invalid data found|does not contain any stream|matches no streams|Error opening input/i.test(error.message)) throw new Error('This file has no readable audio, is damaged, or is protected. Try exporting the original M4A, WAV, MP3, or another unprotected audio file.');
    throw error;
  } finally { await rm(work, { recursive: true, force: true }); }
}
