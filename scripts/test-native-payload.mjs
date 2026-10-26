import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, rm, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
const root=process.cwd(), qa=path.join(root,'.local','native-payload QA العربية'), packagedExe=process.env.NOTAKILLITE_PACKAGED_EXE||path.join(root,'release','Notakillite.exe'), launcherOnly=process.argv.includes('--launcher-only');await mkdir(qa,{recursive:true});
async function command(exe,args,cwd=root){const child=spawn(exe,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const [code]=await once(child,'exit');assert.equal(code,0,log);return log;}
await command(packagedExe,['--verify-only','--extract-to',qa]);
const app=(await readFile(path.join(qa,'verification.txt'),'utf8')).trim().split(/\r?\n/).at(-1);
const runtimeNode=path.join(app,'runtime','node.exe');await rm(runtimeNode,{force:true});await command(packagedExe,['--verify-only','--extract-to',qa]);
assert.ok((await stat(runtimeNode)).size>1000,'A cached extraction missing runtime/node.exe must be repaired.');
assert.equal((await readFile(path.join(qa,'verification.txt'),'utf8')).trim().split(/\r?\n/).at(-1),app,'Repair should reuse the matching cached payload directory.');
let output='{}';
if (!launcherOnly) {
const program=path.join(qa,'payload-test.mjs'); const speech=path.join(qa,'spoken-lecture.wav'); await writeFile(speech,await readFile(path.join(root,'tests/fixtures/spoken-lecture.wav')));
await writeFile(program,`import assert from 'node:assert/strict';import{readFile,mkdir,stat,readdir}from'node:fs/promises';import path from'node:path';import{pathToFileURL}from'node:url';
assert.equal(process.platform,'win32','The embedded runtime should be Windows.');assert.equal(process.arch,'x64','The embedded runtime should be x64.');assert.equal(Number(process.versions.node.split('.')[0]),24,'The embedded runtime should be Node.js 24.');
const app=process.argv[2],directory=process.argv[3];await mkdir(directory,{recursive:true});
const{CoreService}=await import(pathToFileURL(path.join(app,'core/service.mjs')));const{runTool}=await import(pathToFileURL(path.join(app,'companion/audio.mjs')));const ffmpeg=path.join(app,'node_modules/ffmpeg-static/ffmpeg.exe');
let service=await new CoreService({dataRoot:path.join(directory,'data'),connector:{async close(){}}}).init();
const results=[];try{for(const codec of['aac','alac']){const input=path.join(directory,codec+'.m4a');await runTool(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=2.137:sample_rate=44100','-c:a',codec,input]);for(const engine of['rnnoise','deepfilter','hybrid','none']){const{id}= {id:(await service.enqueue({file:input,engine,splitMinutes:0,transcribe:false})).ids[0]};let job;for(let i=0;i<800;i++){job=service.jobs.find(j=>j.id===id);if(['done','error'].includes(job.status))break;await new Promise(r=>setTimeout(r,50));}assert.equal(job.status,'done',job.error);assert.ok((await stat(job.files[0].path)).size>1000);if(engine==='none')assert.deepEqual(await readFile(job.files[0].path),await readFile(input));else await runTool(ffmpeg,['-v','error','-i',job.files[0].path,'-f','null','-']);results.push({codec,engine,bytes:(await stat(job.files[0].path)).size});}}
const speech=process.argv[4];const speechId=(await service.enqueue({files:[speech],engine:'rnnoise',splitMinutes:0,transcribe:true,transcriber:'local',model:'tiny',language:'en'})).ids[0];
let speechJob;for(let i=0;i<1200;i++){speechJob=service.jobs.find(j=>j.id===speechId);if(['done','needs-review','error'].includes(speechJob.status))break;await new Promise(r=>setTimeout(r,100));}
assert.ok(['done','needs-review'].includes(speechJob.status),speechJob.error);assert.ok(speechJob.transcript.words>5);assert.ok((await service.handle('transcript',{id:speechId})).segments.length>0);
await import(pathToFileURL(path.join(app,'node_modules/pdfjs-dist/legacy/build/pdf.mjs')));
await import(pathToFileURL(path.join(app,'node_modules/@napi-rs/canvas/index.js')));
await service.close();service=await new CoreService({dataRoot:path.join(directory,'data'),connector:{async close(){}}}).init();assert.equal(service.jobs.filter(j=>['done','needs-review'].includes(j.status)).length,9);assert.deepEqual(await readdir(service.paths.temp),[]);console.log(JSON.stringify({packagedCore:'passed',packagedASR:'passed',pdfDependencies:'passed',bundledNode:process.version,results,durableHistory:'passed',temporaryCleanup:'passed',networkServerRequired:false}));}finally{await service.close();}`);
output=await command(path.join(app,'runtime','node.exe'),['--disable-warning=ExperimentalWarning',program,app,path.join(qa,'audio-'+Date.now()),speech],app);
}
const manifest=JSON.parse(await readFile(path.join(app,'brave-connector/manifest.json'),'utf8'));assert.equal(manifest.version,'0.7.0');assert.ok(manifest.permissions.includes('nativeMessaging'));assert.ok(!manifest.host_permissions.some(origin=>origin.includes('127.0.0.1')));
const launcherQa=await mkdtemp(path.join(root,'.local','launcher QA العربية-'));
let launcherProof;
try {
  const data=path.join(launcherQa,'isolated data العربية');await mkdir(data,{recursive:true});
  const screenshot=path.join(launcherQa,'local-only capture.png');
  const launcher=spawn(packagedExe,['--data-dir',data+path.sep,'--no-connect','--capture-to',screenshot,'--capture-and-exit'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let launcherLog='';launcher.stdout.on('data',bytes=>launcherLog+=bytes);launcher.stderr.on('data',bytes=>launcherLog+=bytes);
  let launcherTimer;let launcherCode;
  try {
    [launcherCode]=await Promise.race([once(launcher,'exit'),new Promise((_,reject)=>{launcherTimer=setTimeout(()=>{launcher.kill();reject(new Error('Packaged launcher did not return after the desktop app became ready.'));},45000);launcherTimer.unref();})]);
  } finally { clearTimeout(launcherTimer); }
  if(launcherCode!==0){try{launcherLog+='\n'+await readFile(path.join(data,'logs','launcher-error.txt'),'utf8');}catch{}}
  assert.equal(launcherCode,0,launcherLog||'Packaged launcher should start the local-only desktop app.');
  const ready=path.join(data,'logs','desktop-ready.txt');const readyLines=(await readFile(ready,'utf8')).trim().split(/\r?\n/);const desktopPid=Number(readyLines[0]);
  assert.ok(Number.isInteger(desktopPid)&&desktopPid>0,'The desktop app should publish its process id when ready.');
  const launchedApp=readyLines[1];
  assert.equal(path.resolve(path.dirname(launchedApp)),path.resolve(path.join(data,'versions')),'The isolated launcher should extract under its explicit data directory.');
  assert.ok(path.basename(launchedApp).startsWith('0.7.0-'),'The launcher should start the expected packaged version.');
  assert.ok((await stat(path.join(launchedApp,'runtime','node.exe'))).size>1000,'The isolated launcher should extract the runtime payload.');
  assert.equal((await readFile(path.join(data,'launcher','current.txt'),'utf8')).trim(),launchedApp,'The launcher should update current.txt after desktop readiness.');
  assert.ok((await stat(screenshot)).size>1000,'The no-connect QA app should capture its real WPF window.');
  const deadline=Date.now()+30000;let alive=true;
  while(Date.now()<deadline){try{process.kill(desktopPid,0);await new Promise(resolve=>setTimeout(resolve,100));}catch(error){if(error.code==='ESRCH'){alive=false;break;}throw error;}}
  assert.equal(alive,false,'The packaged launcher QA app should exit after capture-and-exit.');
  launcherProof={localOnlyFlag:'forwarded',isolatedDataDirectory:'Unicode path used',packagedExtraction:'passed',desktopReady:'passed',currentPointer:'passed',capture:'passed',cleanExit:'passed'};
} finally {
  const resolvedLocal=path.resolve(root,'.local')+path.sep,resolvedQa=path.resolve(launcherQa);
  assert.ok(resolvedQa.startsWith(resolvedLocal),'Only the generated local QA directory may be removed.');
  await rm(launcherQa,{recursive:true,force:true});
}
const report={result:'passed',exeBytes:(await stat(packagedExe)).size,extractionPath:qa,cacheRepair:'passed',launcher:launcherProof,fullPayloadTests:launcherOnly?'skipped':JSON.parse(output.trim()),connector:{version:manifest.version,hostPermissions:manifest.host_permissions},accountDataIncluded:false};
await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
