import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { runTool } from '../companion/audio.mjs';
import { archiveRecordings, expandImports, extractEntry, looksLikeAudio, zipEntries } from '../companion/notability-import.mjs';
import { CoreService } from '../core/service.mjs';
import { writeZip } from './fixtures/zip.mjs';

const speech = fileURLToPath(new URL('./fixtures/spoken-lecture.wav', import.meta.url));
async function directory(t, prefix) { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function wait(probe, timeout = 60000) { const until = Date.now() + timeout; while (Date.now() < until) { const value = await probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out.'); }
const noBrowser = () => ({ async close() {}, async state() { throw new Error('Not connected'); } });

async function syntheticNote(root, name = 'Anatomy L3.note', work = root) {
  const first = path.join(work, 'first.m4a'), second = path.join(work, 'second.m4a');
  await runTool(ffmpeg, ['-y', '-i', speech, '-t', '2', '-c:a', 'aac', first]);
  await runTool(ffmpeg, ['-y', '-i', speech, '-ss', '2', '-t', '3', '-c:a', 'aac', second]);
  const [a, b] = await Promise.all([readFile(first), readFile(second)]);
  const note = path.join(root, name);
  // library.plist mentions B before A: Notability's saved order must win over file names.
  await writeZip(note, [
    { name: 'Anatomy L3/Session.plist', data: 'bplist00 session' },
    { name: 'Anatomy L3/Recordings/library.plist', data: 'bplist00 ... 2B6F-rec.m4a ... 1A2C-rec.m4a ...' },
    { name: 'Anatomy L3/Recordings/1A2C-rec.m4a', data: a, store: true },
    { name: 'Anatomy L3/Recordings/2B6F-rec.m4a', data: b },
    { name: 'Anatomy L3/Images/page.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: '__MACOSX/._junk', data: 'x' },
  ]);
  return { note, a, b };
}

test('a Notability .note export lists recordings in saved order and extracts them byte-for-byte', async t => {
  const root = await directory(t, 'notakillite-note-');
  const { note, a, b } = await syntheticNote(root);
  const recordings = await archiveRecordings(note);
  assert.deepEqual(recordings.map(entry => path.posix.basename(entry.name)), ['2B6F-rec.m4a', '1A2C-rec.m4a']);
  for (const [entry, expected] of [[recordings[0], b], [recordings[1], a]]) {
    const out = path.join(root, `out-${entry.method}.m4a`);
    await extractEntry(note, entry, out);
    assert.deepEqual(await readFile(out), expected);
  }
  assert.equal((await zipEntries(note)).some(entry => entry.name.startsWith('__MACOSX')), false);
  assert.equal(looksLikeAudio(a.subarray(0, 16)), true);
});

test('folders, audio files and notes expand into an ordered import list', async t => {
  const root = await directory(t, 'notakillite-expand-');
  const folder = path.join(root, 'Course');
  await mkdir(folder);
  await syntheticNote(folder, 'Lecture 2.note', root);
  await runTool(ffmpeg, ['-y', '-i', speech, '-t', '1', path.join(folder, 'Lecture 10.wav')]);
  await runTool(ffmpeg, ['-y', '-i', speech, '-t', '1', path.join(folder, 'Lecture 1.mp3')]);
  await writeFile(path.join(folder, 'notes.txt'), 'ignored');
  const items = await expandImports([folder]);
  assert.deepEqual(items.map(item => `${item.title}|${item.recordingName}`), ['Lecture 1|Lecture 1.mp3', 'Lecture 2|Recording 1', 'Lecture 2|Recording 2', 'Lecture 10|Lecture 10.wav']);
  const empty = path.join(root, 'empty.note');
  await writeZip(empty, [{ name: 'x/Session.plist', data: 'no audio' }]);
  await assert.rejects(expandImports([empty]), /no audio recordings/);
  await writeFile(path.join(root, 'broken.note'), 'not a zip');
  await assert.rejects(expandImports([path.join(root, 'broken.note')]), /not a Notability note/);
});

test('importing a .note queues one numbered job per recording in a single batch folder', { timeout: 120000 }, async t => {
  const root = await directory(t, 'notakillite-note-core-');
  const { note, a, b } = await syntheticNote(root);
  const service = await new CoreService({ dataRoot: path.join(root, 'data'), connector: noBrowser() }).init();
  try {
    const { ids } = await service.enqueue({ files: [note], engine: 'none', splitMinutes: 0, transcribe: false });
    assert.equal(ids.length, 2);
    await wait(() => ids.every(id => ['done', 'error'].includes(service.jobs.find(job => job.id === id).status)));
    const jobs = ids.map(id => service.jobs.find(job => job.id === id));
    for (const job of jobs) assert.equal(job.status, 'done', job.error);
    assert.equal(jobs[0].destination, jobs[1].destination);
    assert.deepEqual(jobs.map(job => path.basename(job.files[0].path)), ['01 - Anatomy L3.m4a', '02 - Anatomy L3.m4a']);
    assert.deepEqual(await readFile(jobs[0].files[0].path), b);
    assert.deepEqual(await readFile(jobs[1].files[0].path), a);
    assert.ok((await readdir(jobs[0].destination)).includes('.notakillite'));
    assert.deepEqual(await readdir(service.paths.temp), []);
  } finally { await service.close(); }
});
