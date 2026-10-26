import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'ffmpeg-static';
import { processAudio, runTool } from '../companion/audio.mjs';
import { assets, settings } from '../companion/engines.mjs';

const speech = new URL('./fixtures/spoken-lecture.wav', import.meta.url);
test('engine selection rejects invalid settings and retains the explicit original option', () => {
  assert.throws(() => settings({ engine: 'invented' }), /engine/);
  assert.throws(() => settings({ engine: 'rnnoise', strength: 'extreme' }), /strength/);
  assert.equal(settings({ engine: 'deepfilter', clean: false }).engine, 'none');
});
const base = ['-hide_banner', '-nostdin', '-y'];
async function decode(input, output, rate = 24000) {
  await runTool(ffmpeg, [...base, '-i', input, '-ac', '1', '-ar', String(rate), '-f', 'f32le', output]);
  const bytes = await readFile(output);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function rms(samples, start, end) {
  let square = 0;
  for (let i = start; i < Math.min(samples.length, end); i++) square += samples[i] ** 2;
  return Math.sqrt(square / Math.max(1, Math.min(samples.length, end) - start));
}
function noiseRatio(samples) { return rms(samples, samples.length - 19200, samples.length - 4800) / rms(samples, 24000, samples.length - 24000); }

test('real engines clean spoken M4A AAC/ALAC, preserve length, and reduce noise relative to speech', { timeout: 240000, skip:process.platform !== 'win32' && 'DeepFilterNet3 Windows runtime required' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notakillite-engines-'));
  t.after(async () => { assert.ok(path.basename(directory).startsWith('notakillite-engines-')); await rm(directory, { recursive: true, force: true }); });
  const noisy = path.join(directory, 'noisy.wav');
  await runTool(ffmpeg, [...base, '-i', fileURLToPath(speech), '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.025:sample_rate=48000:seed=42', '-filter_complex', '[0:a]aresample=48000,adelay=1000:all=1,apad=pad_dur=1[s];[s][1:a]amix=inputs=2:duration=first:normalize=0[out]', '-map', '[out]', '-c:a', 'pcm_f32le', noisy]);
  const sourceSamples = await decode(noisy, path.join(directory, 'source.f32'));
  const baseline = noiseRatio(sourceSamples);
  const results = [];
  for (const codec of ['aac', 'alac']) {
    const input = path.join(directory, `${codec}.m4a`);
    await runTool(ffmpeg, [...base, '-i', noisy, '-c:a', codec, ...(codec === 'aac' ? ['-b:a', '128k'] : []), input]);
    // Input deliberately has no extension, matching Notability's upload path.
    const rawUpload = path.join(directory, 'source.audio');
    await writeFile(rawUpload, await readFile(input));
    for (const engine of process.platform === 'win32' ? ['rnnoise','deepfilter','hybrid'] : ['rnnoise']) {
      const destination = path.join(directory, `${codec}-${engine}`);
      const manifest = await processAudio({ ffmpeg, input: rawUpload, destination, metadata: { title: 'Generated speech QA', recordingName: `${codec}.m4a`, clean: true, engine, strength: 'balanced', splitMinutes: 0 } });
      assert.equal(manifest.noiseReductionEngine, engine);
      const output = await decode(path.join(destination, 'lecture.mp3'), path.join(directory, 'output.f32'));
      assert.ok(Math.abs(output.length - sourceSamples.length) <= 2400, `${codec}/${engine} changed recording length`);
      assert.ok(rms(output, 24000, output.length - 24000) > 0.001, `${codec}/${engine} lost all speech`);
      const improvement = 20 * Math.log10(baseline / noiseRatio(output));
      console.log(JSON.stringify({ codec, engine, improvement, voiceRms: rms(output, 24000, output.length - 24000) }));
      results.push({ codec, engine, noiseToSpeechImprovementDb: Number(improvement.toFixed(2)) });
    }
  }
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('denoise-')), []);
  console.log(JSON.stringify({ generatedSpeech: true, results }));
  for (const result of results) assert.ok(result.noiseToSpeechImprovementDb > 3, `${result.codec}/${result.engine}: noise reduction was only ${result.noiseToSpeechImprovementDb} dB`);
});

test('other common containers decode through both neural engines', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notakillite-formats-'));
  t.after(async () => { assert.ok(path.basename(directory).startsWith('notakillite-formats-')); await rm(directory, { recursive: true, force: true }); });
  const formats = [['wav', 'pcm_s16le'], ['mp3', 'libmp3lame'], ['flac', 'flac'], ['ogg', 'libvorbis'], ['webm', 'libopus'], ['aiff', 'pcm_s16be'], ['caf', 'pcm_s16le'], ['aac', 'aac']];
  for (const [extension, codec] of formats) {
    const input = path.join(directory, `recording.${extension}`);
    await runTool(ffmpeg, [...base, '-i', fileURLToPath(speech), '-t', '1.137', '-ac', '2', '-ar', codec === 'libopus' ? '48000' : '44100', '-c:a', codec, input]);
    for (const engine of process.platform === 'win32' ? ['rnnoise','deepfilter'] : ['rnnoise']) {
      const destination = path.join(directory, `${extension}-${engine}`);
      const manifest = await processAudio({ ffmpeg, input, destination, metadata: { title: 'Format QA', recordingName: extension, clean: true, engine, strength: 'strong', splitMinutes: 0 } });
      assert.equal(manifest.files.length, 1);
      const decoded = await decode(path.join(destination, 'lecture.mp3'), path.join(directory, 'verify.f32'));
      assert.ok(decoded.length > 24000 && decoded.length < 32000, `${extension}/${engine} duration invalid`);
    }
  }
});

test('long DeepFilterNet exports retain exact core samples across overlapping chunks and clean temporary files', { timeout: 240000, skip:process.platform !== 'win32' && 'DeepFilterNet3 Windows runtime required' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notakillite-long-'));
  t.after(async () => { assert.ok(path.basename(directory).startsWith('notakillite-long-')); await rm(directory, { recursive: true, force: true }); });
  const input = path.join(directory, 'long.wav');
  await runTool(ffmpeg, [...base, '-stream_loop', '-1', '-i', fileURLToPath(speech), '-t', '121.137', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', input]);
  const stages = [];
  await processAudio({ ffmpeg, input, destination: path.join(directory, 'output'), metadata: { title: 'Long QA', recordingName: 'Two chunks', clean: true, engine: 'deepfilter', splitMinutes: 0 }, onStage: value => stages.push(value) });
  assert.ok(stages.some(stage => stage.parts === 2 && stage.part === 2));
  const decoded = await decode(path.join(directory, 'output', 'lecture.mp3'), path.join(directory, 'verify.f32'));
  assert.equal(decoded.length, Math.round(121.137 * 24000));
  assert.ok(rms(decoded, 120 * 24000, decoded.length) > 0.001, 'The final chunk must retain speech');
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('denoise-')), []);
});

test('model paths with spaces, apostrophes and Unicode work after Windows extraction', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notakillite O'Brien العربية-"));
  const previous = { ...assets };
  t.after(async () => { Object.assign(assets, previous); assert.ok(path.basename(directory).startsWith("notakillite O'Brien العربية-")); await rm(directory, { recursive: true, force: true }); });
  for (const [name, file] of Object.entries(previous)) {
    assets[name] = path.join(directory, path.basename(file));
    await copyFile(file, assets[name]);
  }
  for (const engine of process.platform === 'win32' ? ['rnnoise','deepfilter'] : ['rnnoise']) {
    const manifest = await processAudio({ ffmpeg, input: fileURLToPath(speech), destination: path.join(directory, engine), metadata: { title: 'Path QA', recordingName: 'Speech', clean: true, engine, splitMinutes: 0 } });
    assert.equal(manifest.files.length, 1);
  }
});
