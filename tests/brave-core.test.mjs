import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { BraveConnector } from '../core/brave.mjs';
import { CoreService } from '../core/service.mjs';
import { pathsFor } from '../core/paths.mjs';
import { runTool } from '../companion/audio.mjs';

async function wait(probe, timeout = 60000) { const until = Date.now() + timeout; while (Date.now() < until) { const result = await probe(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out waiting for Brave/core check.'); }
async function directory(t, prefix) { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); t.after(async () => { assert.ok(path.basename(dir).startsWith(prefix)); await rm(dir, { recursive: true, force: true }); }); return dir; }
const noBrowser = () => ({ async close() {}, async state() { throw new Error('Not connected'); } });
test('native core queues AAC M4A, preserves job history and settings across versions, and exports originals exactly', { timeout: 120000 }, async t => {
  const root = await directory(t, 'notakillite-core-');
  const input = path.join(root, 'Apple lecture.m4a');
  await runTool(ffmpeg, ['-y', '-i', fileURLToPath(new URL('./fixtures/spoken-lecture.wav', import.meta.url)), '-t', '2.137', '-c:a', 'aac', input]);
  let service = await new CoreService({ dataRoot: root, connector: noBrowser() }).init();
  try {
    service.savePreferences({ engine: 'rnnoise', search: 'العربية', folder: 'fixture/folder' });
    const clean = (await service.enqueue({ file: input, engine: 'deepfilter', strength: 'balanced', splitMinutes: 0, transcribe: false })).ids[0];
    const original = (await service.enqueue({ file: input, engine: 'none', splitMinutes: 0, transcribe: false })).ids[0];
    await wait(() => service.jobs.find(job => job.id === original)?.status === 'done');
    assert.equal(service.jobs.find(job => job.id === clean).status, 'done', service.jobs.find(job => job.id === clean).error);
    assert.deepEqual(await readFile(service.jobs.find(job => job.id === original).files[0].path), await readFile(input));
    assert.deepEqual(await readdir(service.paths.temp), []);
    const profile = service.paths.profile;
    await service.close();
    for (const version of ['build-B', 'build-C']) {
      service = await new CoreService({ dataRoot: root, connector: noBrowser() }).init();
      assert.equal(service.paths.profile, profile);
      assert.equal(service.preferences.search, 'العربية');
      assert.equal(service.jobs.filter(job => job.status === 'done').length, 2);
      await service.close();
    }
  } finally { if (!service.closing) await service.close(); }
});

test('a durable queued local job is recoverable and cancellation stops native processing', { timeout: 120000 }, async t => {
  const root = await directory(t, 'notakillite-recovery-');
  const input = path.join(root, 'long.wav');
  await runTool(ffmpeg, ['-y', '-stream_loop', '-1', '-i', fileURLToPath(new URL('./fixtures/spoken-lecture.wav', import.meta.url)), '-t', '240.137', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', input]);
  const service = await new CoreService({ dataRoot: root, connector: noBrowser() }).init();
  try {
    const id = (await service.enqueue({ file: input, engine: 'deepfilter', splitMinutes: 0, transcribe: false })).ids[0];
    await wait(() => service.jobs.find(job => job.id === id)?.phase.includes('DeepFilterNet3'));
    await service.cancel(id);
    await wait(() => service.jobs.find(job => job.id === id)?.status === 'cancelled');
    const job = service.jobs.find(job => job.id === id);
    assert.ok(job.input);
    await service.close();
    const resumed = await new CoreService({ dataRoot: root, connector: noBrowser() }).init();
    try {
      assert.equal(resumed.jobs.find(job => job.id === id).status, 'cancelled');
      await resumed.retry(id);
      await wait(() => resumed.jobs.find(job => job.id === id)?.status === 'done', 120000);
      assert.ok(resumed.jobs.find(job => job.id === id).files.length);
      assert.deepEqual(await readdir(resumed.paths.temp), []);
    } finally { await resumed.close(); }
  } finally { if (!service.closing) await service.close(); }
});

test('Brave private pipe retains synthetic session state across three builds and exports full M4A without an extension', { timeout: 120000 }, async t => {
  const root = await directory(t, 'notakillite-brave-');
  const input = path.join(root, 'lecture.m4a');
  await runTool(ffmpeg, ['-y', '-i', fileURLToPath(new URL('./fixtures/spoken-lecture.wav', import.meta.url)), '-t', '3.137', '-c:a', 'aac', input]);
  const bytes = await readFile(input);
  const module = `const recording={id:()=> 'recording-1',name:()=> 'Apple M4A lecture',startTime:()=>0,initialDuration:()=>3137,assetHash:()=> 'hash',recordingAsset:()=>({metadata:()=>({mimeType:()=> 'audio/mp4'})})};
    const session={getModel:()=>({getRecordingEntities:()=>[recording]})};const storage=new Map();const manager={_sessionStorage:storage,openNote:async id=>{storage.set(id,session);return session},closeNote:async id=>{storage.delete(id)}};
    export class Services{static getPersistenceManager(){return{getLibrary:async()=>localStorage.getItem('synthetic-session')==='retained'?{status:'ready',library:{privateWorkspace:{id:'fixture-account',notes:[{id:'lecture',title:'محاضرة Anatomy',folderId:'subject',hasRecordings:true,createdAt:1,updatedAt:2}],organizers:[{id:'subject',title:'LEVEL 5',organizerType:'Subject',siblingOrder:1,noteIds:['lecture'],children:[]}]},sharedNotes:[],sharedWorkspaces:[]}}:{status:'signed-out'}}}static getNoteManager(){return manager}static getRecordingAssetManager(){return{getAsset:async()=>new Blob([Uint8Array.from(atob('${bytes.toString('base64')}'),c=>c.charCodeAt(0))],{type:'audio/mp4'})}}}globalThis.fixtureServicesReady=true;`;
  const prepareContext = async context => {
    await context.route('https://notability.com/**', route => route.fulfill({ contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html', body: route.request().url().endsWith('.js') ? module : '<!doctype html><title>Synthetic Brave session</title><script type="module" src="/app/assets/sentry-brave-fixture.js"></script>' }));
  };
  for (const build of ['A', 'B', 'C']) {
    const connector = new BraveConnector({ profile: pathsFor(root).profile, headless: true, prepareContext });
    try {
      await connector.connect();
      await connector.page.goto(`https://notability.com/app?fixture=${build}`, { waitUntil: 'load' });
      await connector.page.waitForFunction(() => globalThis.fixtureServicesReady === true);
      if (build === 'A') await connector.page.evaluate(() => { localStorage.setItem('synthetic-session', 'retained'); document.cookie = 'synthetic_session=retained; Max-Age=86400; Secure; SameSite=Lax; path=/'; });
      const state = await connector.state();
      assert.equal(state.notes[0].title, 'محاضرة Anatomy');
      assert.equal(state.library.workspaces[0].children[0].title, 'LEVEL 5');
      assert.equal(await connector.page.evaluate(() => document.cookie.includes('synthetic_session=retained')), true, `Cookie persistence failed on build ${build}`);
      const received = path.join(root, `received-${build}.m4a`);
      await connector.capture('lecture', 'recording-1', received);
      assert.deepEqual(await readFile(received), bytes);
      const settings = await connector.context.newPage(); await settings.goto('brave://extensions/');
      const configuration = await settings.evaluate(() => chrome.developerPrivate.getProfileConfiguration());
      assert.equal(configuration.inDeveloperMode, false);
      const extensions = await settings.evaluate(() => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }));
      assert.ok(!extensions.some(item => item.id === 'pnfghekgheamlilmdlapjbhaofgnbcco'));
    } finally { await connector.close(); }
  }
});
