import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd(), qa=path.join(root,'.local','native-payload QA العربية');await mkdir(qa,{recursive:true});
async function command(exe,args,cwd=root){const child=spawn(exe,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const [code]=await once(child,'exit');assert.equal(code,0,log);return log;}
await command(path.join(root,'release','Notakillite.exe'),['--verify-only','--extract-to',qa]);
const app=(await readFile(path.join(qa,'verification.txt'),'utf8')).trim().split(/\r?\n/).at(-1);
const program=path.join(qa,'payload-test.mjs'); const speech=path.join(qa,'spoken-lecture.wav'); await writeFile(speech,await readFile(path.join(root,'tests/fixtures/spoken-lecture.wav')));
await writeFile(program,`import assert from 'node:assert/strict';import{readFile,mkdir,stat,readdir}from'node:fs/promises';import path from'node:path';import{pathToFileURL}from'node:url';
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
const output=await command(path.join(app,'runtime','node.exe'),['--disable-warning=ExperimentalWarning',program,app,path.join(qa,'audio-'+Date.now()),speech],app);
const manifest=JSON.parse(await readFile(path.join(app,'brave-connector/manifest.json'),'utf8'));assert.equal(manifest.version,'0.7.0');assert.ok(manifest.permissions.includes('nativeMessaging'));assert.ok(!manifest.host_permissions.some(origin=>origin.includes('127.0.0.1')));
const report={result:'passed',exeBytes:(await stat(path.join(root,'release/Notakillite.exe'))).size,extractionPath:qa,app,tests:JSON.parse(output.trim()),connector:{version:manifest.version,hostPermissions:manifest.host_permissions},accountDataIncluded:false};
await writeFile(path.join(qa,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
