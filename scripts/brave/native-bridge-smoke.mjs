import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, cp, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { findRegularBrave } from '../../core/browser-profiles.mjs';
import { Store } from '../../core/store.mjs';
import { EXTENSION_ID } from '../../core/connector-info.mjs';
import { runTool } from '../../companion/audio.mjs';
import ffmpeg from 'ffmpeg-static';

const root = process.cwd(), qa = path.join(root, '.local', 'bridge-native-qa');
await mkdir(qa, { recursive: true }); await mkdir(path.join(qa, 'data'), { recursive: true }); await mkdir(path.join(qa, 'bridge'), { recursive: true });
const stages = (await readdir(path.join(root, 'release'))).filter(name => /^brave-payload-\d+$/.test(name)).sort();
const stage = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : path.join(root, 'release', stages.at(-1));
const extension = path.join(qa, 'extension'); await cp(path.join(stage, 'brave-connector'), extension, { recursive: true });
await writeFile(path.join(extension, 'background.js'), (await readFile(path.join(extension, 'background.js'), 'utf8')).replace("'com.notakillite.bridge'", "'com.notakillite.qa'"));
const host = path.join(qa, 'bridge', 'native-host.exe'); await cp(path.join(stage, 'Notakillite.NativeHost.exe'), host);
const manifest = path.join(qa, 'host.json'); await writeFile(manifest, JSON.stringify({ name: 'com.notakillite.qa', description: 'Isolated Notakillite QA host', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }));
function registration(action) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/brave/qa-host-registration.ps1'), '-Action', action, '-ManifestPath', manifest], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
const input = path.join(qa, 'Apple lecture.m4a');
await runTool(ffmpeg, ['-y','-i',path.join(root,'tests/fixtures/spoken-lecture.wav'),'-t','4.137','-c:a','aac',input]);
const source = await readFile(input);
const nonce = 'b'.repeat(48), store = new Store(path.join(qa, 'data'));
const previous = store.get('braveBinding', null);
const previousJobIds = new Set(store.jobs().map(job => job.id));
if (!previous?.profileId) {
  store.set('braveBinding', { extensionId: EXTENSION_ID, profileDirectory: 'Default', profileLabel: 'Synthetic QA Brave', userDataRoot: path.join(qa, 'profile'), profileId: null, verifiedAccountId: null });
  store.set('bravePairing', { nonce, expires: Date.now()+600000, profileDirectory: 'Default' });
}
store.close();
const fixture = `const rec={id:()=> 'recording-1',name:()=> 'Apple M4A lecture',startTime:()=>0,initialDuration:()=>4137,assetHash:()=> 'qa-asset',recordingAsset:()=>({metadata:()=>({mimeType:()=> 'audio/mp4'})})};const session={getModel:()=>({getRecordingEntities:()=>[rec]})};const storage=new Map();const manager={_sessionStorage:storage,openNote:async id=>{storage.set(id,session);return session},closeNote:async id=>storage.delete(id)};
export class Services{static getPersistenceManager(){return{getLibrary:async()=>localStorage.getItem('synthetic-session')==='retained'?{status:'ready',library:{privateWorkspace:{id:'qa-account',notes:Array.from({length:1500},(_,i)=>({id:i?'note-'+i:'lecture',title:i?'محاضرة '+i+' الجهاز الهضمي '.repeat(16):'QA lecture — Apple M4A',folderId:'subject',hasRecordings:i===0,createdAt:1,updatedAt:2})),organizers:[{id:'subject',title:'LEVEL 5',organizerType:'Subject',siblingOrder:1,noteIds:['lecture'],children:[]}]},sharedNotes:[],sharedWorkspaces:[]}}:{status:'signed-out'}}}static getNoteManager(){return manager}static getRecordingAssetManager(){return{getAsset:async()=>new Blob([Uint8Array.from(atob('${source.toString('base64')}'),c=>c.charCodeAt(0))],{type:'audio/mp4'})}}}globalThis.qaServicesReady=true;`;
let context, native;
registration('Install');
try {
  context = await chromium.launchPersistentContext(path.join(qa, 'profile'), { executablePath: await findRegularBrave(), headless: true, viewport: { width: 1100, height: 800 }, serviceWorkers:'block', ignoreDefaultArgs:['--disable-extensions'], args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`] });
  await context.route('https://notability.com/**', route => route.fulfill({ contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html', body:route.request().url().endsWith('.js')?fixture:'<!doctype html><title>Notakillite synthetic QA only</title><script type="module" src="/app/assets/sentry-native-qa.js"></script>' }));
  const page = await context.newPage(); await page.goto('https://notability.com/app'); await page.waitForFunction(()=>globalThis.qaServicesReady===true);
  // A persistent browser may restore a tab before route fixtures are registered.
  // Keep exactly the fixture tab before starting the native app, so the connector
  // cannot select a restored, unmocked Notability page.
  for (const other of context.pages()) if (other !== page) await other.close();
  if (!previous?.profileId) await page.evaluate(()=>{localStorage.setItem('synthetic-session','retained');document.cookie='synthetic_session=retained; Max-Age=86400; Secure; SameSite=Lax; path=/';});
  assert.equal(await page.evaluate(()=>localStorage.getItem('synthetic-session')), 'retained');
  assert.equal(await page.evaluate(()=>document.cookie.includes('synthetic_session=retained')), true);
  native = spawn(path.join(stage,'Notakillite.Desktop.exe'),['--data-dir',qa,'--no-connect','--bridge-test'],{windowsHide:false,stdio:['ignore','pipe','pipe']});
  let diagnostics=''; native.stderr.on('data',bytes=>{diagnostics=(diagnostics+bytes).slice(-3000);});
  const connectPage = await context.newPage(); await connectPage.goto(`chrome-extension://${EXTENSION_ID}/connect.html${previous?.profileId?'':`#pair=${nonce}`}`);
  await connectPage.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Connected to Notakillite'),{timeout:30000});
  const result = spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/brave/qa-native-export.ps1'),'-NativeAppPid',String(native.pid),'-Preset',process.argv.includes('--original')?'OriginalPreset':'BalancedPreset',...(process.argv.includes('--legacy-recording-retry')?['-AllowRecordingRetry']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';result.stdout.on('data',bytes=>{output+=bytes;});result.stderr.on('data',bytes=>{output+=bytes;});
  const [code]=await once(result,'exit'); assert.equal(code,0,output+diagnostics);
  let completedJob;
  const deadline = Date.now() + 60000;
  const liveDatabase = new DatabaseSync(path.join(qa, 'data', 'library.sqlite'), { readOnly: true });
  liveDatabase.exec('PRAGMA busy_timeout=2000');
  try { while (Date.now() < deadline) {
    const job = liveDatabase.prepare('SELECT value FROM jobs ORDER BY rowid DESC').all().map(row => JSON.parse(row.value)).find(item => !previousJobIds.has(item.id));
    if (job?.status === 'done') { completedJob = job; break; }
    assert.ok(!job || !['error', 'interrupted', 'cancelled'].includes(job.status), job?.error || 'Native export failed.');
    await new Promise(resolve => setTimeout(resolve, 150));
  } } finally { liveDatabase.close(); }
  assert.ok(completedJob, 'A new native UI export must complete, independent of any previously finished jobs. ' + output);
  if (process.argv.includes('--playback')) {
    const playback = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/brave/qa-native-playback.ps1'),'-NativeAppPid',String(native.pid)], { windowsHide: true, encoding: 'utf8' });
    assert.equal(playback.status, 0, playback.stdout + playback.stderr);
  }
  const close=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/brave/qa-close-window.ps1'),'-NativeAppPid',String(native.pid)],{windowsHide:true,encoding:'utf8'});assert.equal(close.status,0,close.stderr);
  const [nativeCode]=await Promise.race([once(native,'exit'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Native app did not close cleanly.')),25000).unref())]); assert.equal(nativeCode,0,diagnostics);native=undefined;
  const saved=new Store(path.join(qa,'data'));const binding=saved.get('braveBinding'), jobs=saved.jobs();saved.close();
  const latest=jobs.find(job=>job.id===completedJob.id);assert.ok(latest);assert.equal(binding.verifiedAccountId,'qa-account');assert.equal(binding.profileId,previous?.profileId||binding.profileId);assert.equal(latest.source,'Notability');assert.ok((await stat(latest.files[0].path)).size>1000);
  if(process.argv.includes('--original'))assert.deepEqual(await readFile(latest.files[0].path),source);
  const report={result:'passed',scope:'Synthetic account only',nativeMessaging:'actual Brave → native host → current-user WPF pipe → core',noteCount:1500,largeLibraryFrames:true,realM4AExport:latest.options.engine,persistentProfileId:binding.profileId,completedJobs:jobs.filter(j=>j.status==='done').length,sourceBytes:source.length,outputBytes:(await stat(latest.files[0].path)).size,...(process.argv.includes('--playback')?{nativePlayback:'passed (muted QA)'}:{})};
  await writeFile(path.join(qa,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
  if(native&&!native.killed) {spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/brave/qa-close-window.ps1'),'-NativeAppPid',String(native.pid)],{windowsHide:true,stdio:'ignore'});}
  if (context) { try { const blank = await context.newPage(); for (const page of context.pages()) if (page !== blank) await page.close(); } catch {} }
  await context?.close();registration('Remove');
}
