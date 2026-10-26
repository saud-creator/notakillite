// Directly verify Unicode model, input-audio, and output paths through whisper-cli argv.
// node scripts/test-cli-unicode.mjs <whisper-cli.exe>
import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from '../core/artifacts.mjs';
import { modelPath, verifiedModel, WHISPER_MODELS } from '../companion/whisper.mjs';

const [cliArgument] = process.argv.slice(2);
if (!cliArgument) throw new Error('Supply the built whisper-cli executable; fallback is not tested here.');
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const program = path.resolve(cliArgument);
const model = modelPath(process.env.NOTAKILLITE_MODELS_DIR || path.join(root, '.local', 'models'), 'tiny');
assert.ok(await verifiedModel(model, WHISPER_MODELS.tiny), 'Install the pinned Tiny model before this offline test.');

const tempRoot = path.resolve(os.tmpdir());
const directory = await mkdtemp(path.join(tempRoot, 'notakillite CLI QA العربية 日本語 '));
const relativeDirectory = path.relative(tempRoot, directory);
assert.ok(relativeDirectory && relativeDirectory !== '..' && !relativeDirectory.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDirectory), 'Refusing to use a test directory outside the OS temp folder.');
const unicodeModel = path.join(directory, 'tiny العربية 日本語.bin');
const audio = path.join(directory, 'speech العربية 日本語.wav');
const outputPrefix = path.join(directory, 'transcript العربية 日本語');
const outputJson = `${outputPrefix}.json`;
const speech = fileURLToPath(new URL('../tests/fixtures/spoken-lecture.wav', import.meta.url));

try {
  await copyFile(model, unicodeModel);
  await copyFile(speech, audio);
  const started = performance.now();
  try {
    await execute(program, ['-m', unicodeModel, '-f', audio, '-l', 'en', '-t', '2', '-ng', '-np', '-nt', '-oj', '-of', outputPrefix], {
      timeout: 180000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(error.stderr || '').split(/\r?\n/).filter(line => /error|failed/i.test(line)).slice(-5).join(' ').slice(0, 1200);
    throw new Error(`whisper-cli rejected Unicode argv paths (exit ${error.code ?? 'unknown'}): ${stderr || error.message}`);
  }
  await access(outputJson);
  const result = JSON.parse(await readFile(outputJson, 'utf8'));
  assert.ok(Array.isArray(result.transcription) && result.transcription.length > 0, 'CLI produced no transcription segments.');
  console.log(JSON.stringify({
    result: 'passed',
    execution: 'direct whisper-cli',
    paths: { model: 'Arabic+Japanese', audio: 'Arabic+Japanese', output: 'Arabic+Japanese' },
    cliSha256: await hashFile(program),
    modelSha256: WHISPER_MODELS.tiny.sha256,
    elapsedMs: Math.round(performance.now() - started),
    segments: result.transcription.length,
  }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
