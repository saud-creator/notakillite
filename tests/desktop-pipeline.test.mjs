import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { resourcePlan, boundedMap, capabilities } from '../core/resource-policy.mjs';
import { claimDirectory, atomicJson, loadCheckpoint } from '../core/artifacts.mjs';
import { newDocument, editDocument, exportDocument } from '../core/transcript-document.mjs';
import { chunkWindows, recoveryWindows, transcribeChunks } from '../companion/chunk-pipeline.mjs';
import { contextIndex, retrieveContext } from '../companion/lecture-context.mjs';
import { Store } from '../core/store.mjs';
import { CoreService } from '../core/service.mjs';
import { writeZip } from './fixtures/zip.mjs';
import { zipEntries, extractEntry } from '../companion/notability-import.mjs';
const temp = async t => { const d=await mkdtemp(path.join(os.tmpdir(),'notakillite-new-')); t.after(()=>rm(d,{recursive:true,force:true})); return d; };
test('resource budgets never oversubscribe effective CPUs and respect memory caps', async () => {
  const cap={ effective:12,total:16*1024**3,available:12*1024**3 };
  for(const policy of ['auto','background','maximum']) { const p=resourcePlan(cap,{resourcePolicy:policy,workers:16,threads:100}); assert.ok(p.workers*p.threads<=12); assert.ok(p.memoryBudget<=cap.available); }
  const detected=await capabilities(); assert.ok(detected.effective>=1); assert.ok(resourcePlan({...cap,effective:1}).threads===1);
});
test('bounded concurrency preserves output order and aborts new work', async () => {
  let active=0,peak=0; const result=await boundedMap([1,2,3,4],2,async n=>{ peak=Math.max(peak,++active); await new Promise(r=>setTimeout(r,6-n)); active--; return n; });
  assert.deepEqual(result,[1,2,3,4]); assert.equal(peak,2);
  const c=new AbortController(); c.abort(); await assert.rejects(boundedMap([1],1,async()=>1,c.signal),{name:'AbortError'});
});
test('output ownership rejects other jobs and atomic checkpoint invalidation is exact', async t=>{
  const d=await temp(t); await claimDirectory(d,'a'); await claimDirectory(d,'a'); await assert.rejects(claimDirectory(d,'b'),/belongs/);
  const file=path.join(d,'checkpoint.json'); await atomicJson(file,{key:'one',result:{a:1}}); assert.deepEqual(await loadCheckpoint(file,'one'),{a:1}); assert.equal(await loadCheckpoint(file,'two'),null);
});
test('speech windows cover beginning, ending, and every ownership boundary exactly',()=>{
  const chunks=chunkWindows(2514.6,[{start:58,end:60}],60); assert.equal(chunks[0].start,0); assert.equal(chunks.at(-1).end,2514.6);
  for(let i=1;i<chunks.length;i++) {assert.equal(chunks[i].start,chunks[i-1].end); assert.ok(chunks[i].decodeStart<chunks[i].start);}
  assert.ok(chunks.every(c=>c.end>c.start));
});
test('short bad intervals no longer require retrying five minutes',()=>{
  const result=recoveryWindows([{start:613,end:660,kind:'loop'}],[],2514.6); assert.equal(result[0].end-result[0].start,53); assert.ok(53<300*.5);
});
test('chunk checkpoints resume without decoding and invalidate on settings change',async t=>{
  const d=await temp(t), wav=path.join(d,'source.wav'); await writeFile(wav,'source'); let calls=0;
  const args={wav,duration:120,work:d,options:{chunkSeconds:60,language:'en'},resource:{workers:2,threads:1},cut:async()=>{},decode:async()=>{calls++; return {segments:[{start:3,end:4,text:'spoken words'}],settings:{}};}};
  const a=await transcribeChunks(args); const b=await transcribeChunks(args); assert.equal(calls,2); assert.deepEqual(a.segments,b.segments);
  await transcribeChunks({...args,options:{...args.options,language:'ar'}}); assert.equal(calls,4);
});
test('PDF retrieval preserves page provenance and irrelevant PDFs produce no context',()=>{
  const index=contextIndex([{page:1,file:'anatomy.pdf',text:'External oblique aponeurosis inguinal ligament'},{page:2,file:'anatomy.pdf',text:'Rectus abdominis abdominal wall'}]);
  const hit=retrieveContext(index,'inguinal ligament'); assert.equal(hit.references[0].page,1); assert.match(hit.vocabulary,/oblique/);
  assert.equal(retrieveContext(index,'photosynthesis chlorophyll').vocabulary,''); assert.equal(retrieveContext(null,'anything').vocabulary,'');
});
test('review edits preserve raw text, reject stale revisions, and exports retain review state',()=>{
  const doc=newDocument({duration:10,quality:{status:'needs-review'},segments:[{start:1,end:3,text:'raw number 7'},{start:4,end:5,text:'check audio',marker:true}]});
  const edited=editDocument(doc,{revision:1,segmentId:doc.segments[0].id,text:'corrected number 7'}); assert.equal(edited.segments[0].rawText,'raw number 7'); assert.equal(edited.history.length,1);
  assert.throws(()=>editDocument(edited,{revision:1,segmentId:doc.segments[0].id,text:'stale'}),/changed/);
  assert.match(exportDocument(edited,'txt'),/needs-review/); assert.match(exportDocument(edited,'srt'),/00:00:01,000 --> 00:00:03,000/); assert.ok(!exportDocument(edited,'srt').includes('check audio')); assert.match(exportDocument(edited,'vtt'),/^WEBVTT/);
});
test('SQLite v1 migration preserves data and creates a backup and searchable segments',async t=>{
  const d=await temp(t), file=path.join(d,'library.sqlite'); const db=new DatabaseSync(file); db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE jobs(id TEXT PRIMARY KEY,value TEXT); PRAGMA user_version=1'); db.prepare('INSERT INTO settings VALUES(?,?)').run('example','"العربية"'); db.close();
  const store=new Store(d); try {assert.equal(store.get('example'),'العربية'); store.indexTranscript('job',newDocument({segments:[{start:3,end:4,text:'inguinal ligament'}],quality:{status:'ok'}})); assert.equal(store.search('inguinal')[0].start,3); assert.ok((await readFile(path.join(d,'library-before-v2.sqlite'))).length>0);} finally {store.close();}
});
test('newer library schema is rejected without resetting its version',async t=>{
  const d=await temp(t), file=path.join(d,'library.sqlite'); let db=new DatabaseSync(file); db.exec('PRAGMA user_version=99'); db.close(); assert.throws(()=>new Store(d),/newer/); db=new DatabaseSync(file); assert.equal(db.prepare('PRAGMA user_version').get().user_version,99); db.close();
});
test('archives reject traversal and compressed expansion before extraction',async t=>{
  const d=await temp(t), file=path.join(d,'bad.zip'); await writeZip(file,[{name:'../recording.wav',data:'audio'}]); await assert.rejects(zipEntries(file),/Unsafe/);
  await writeZip(file,[{name:'recording.wav',data:Buffer.alloc(2*1024*1024)}]); await assert.rejects(zipEntries(file),/expansion/);
});
test('streaming extraction stops forged expanded size and removes partial output',async t=>{
  const d=await temp(t), file=path.join(d,'test.zip'), output=path.join(d,'out'); await writeZip(file,[{name:'recording.wav',data:Buffer.alloc(10000,3)}]); const [entry]=await zipEntries(file); await assert.rejects(extractEntry(file,{...entry,uncompressedSize:4},output),/expansion/); await assert.rejects(readFile(output),{code:'ENOENT'});
});
test('clear-completed emits a state update and keeps needs-review without revealing folders', async t=>{
  const d=await temp(t); const core=await new CoreService({dataRoot:d,connector:{async close(){}}}).init();
  try { core.jobs=[{id:'complete',status:'done'},{id:'review',status:'needs-review'}]; core.jobs.forEach(j=>core.store.saveJob(j)); let changed=0;core.on('state',()=>changed++); await core.handle('clearCompleted'); assert.deepEqual(core.jobs.map(j=>j.id),['review']);assert.equal(changed,1); } finally{await core.close();}
});

test('same-minute exports use distinct folders and retries keep earlier outputs', async t=>{
  const d=await temp(t), input=path.join(d,'VeryLongLectureTitle'.repeat(8)+'.wav');
  const original=await readFile(new URL('./fixtures/spoken-lecture.wav',import.meta.url)); await writeFile(input,original);
  const core=await new CoreService({dataRoot:path.join(d,'data'),connector:{async close(){}}}).init();
  const wait=async id=>{for(let i=0;i<200;i++){const j=core.jobs.find(j=>j.id===id);if(['done','error'].includes(j.status))return j;await new Promise(r=>setTimeout(r,20));}throw new Error('Job timeout');};
  try {
    const a=(await core.enqueue({files:[input],engine:'none',transcribe:false,splitMinutes:0})).ids[0];
    const b=(await core.enqueue({files:[input],engine:'none',transcribe:false,splitMinutes:0})).ids[0];
    const first=await wait(a),second=await wait(b); assert.equal(first.status,'done',first.error);assert.equal(second.status,'done',second.error);assert.notEqual(first.destination,second.destination);
    const waveform=await core.handle('waveform',{id:a});assert.ok(waveform.levels.length>0);
    const completion=JSON.parse(await readFile(path.join(first.destination,'.notakillite',`${first.id}-complete.json`),'utf8'));assert.equal(completion.complete,true);assert.ok(completion.files[0].sha256);
    const before=first.files[0].path;core.save(first,{status:'error'});await core.retry(a);const retried=await wait(a);assert.equal(retried.status,'done',retried.error);assert.notEqual(retried.files[0].path,before);assert.deepEqual(await readFile(before),original);
  } finally{await core.close();}
});
test('concurrent transcript edits cannot both accept the same revision', async t=>{
  const d=await temp(t);const core=await new CoreService({dataRoot:d,connector:{async close(){}}}).init();
  try {const doc=newDocument({segments:[{start:0,end:1,text:'original'}],quality:{status:'ok'}});core.jobs.push({id:'race'});await atomicJson(path.join(core.paths.data,'transcripts','race.json'),doc);
    const results=await Promise.allSettled(['one','two'].map(text=>core.handle('editTranscript',{id:'race',revision:1,segmentId:doc.segments[0].id,text})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await core.transcript('race')).revision,2);
  } finally{await core.close();}
});
test('queued pause persists across restart and corrupt media never publishes success', async t=>{
  const d=await temp(t), bad=path.join(d,'bad.wav');await writeFile(bad,'not audio');
  let core=await new CoreService({dataRoot:path.join(d,'data'),connector:{async close(){}}}).init();
  core.pumping=true;
  try {const id=(await core.enqueue({files:[bad],engine:'none',transcribe:false,splitMinutes:0})).ids[0];await core.pause(id);core.pumping=false;await core.close();
    core=await new CoreService({dataRoot:path.join(d,'data'),connector:{async close(){}}}).init();assert.equal(core.jobs.find(j=>j.id===id).status,'paused');await core.retry(id);
    for(let i=0;i<100&&core.jobs.find(j=>j.id===id).status!=='error';i++)await new Promise(r=>setTimeout(r,20));
    const job=core.jobs.find(j=>j.id===id);assert.equal(job.status,'error');assert.equal(job.files.length,0);
  } finally{core.pumping=false;if(!core.closing)await core.close();}
});

test('actual PDF extraction and local page rendering preserve vocabulary provenance',async t=>{
  const {readLecturePdfs,renderPdfPage}=await import('../companion/lecture-context.mjs');const {textPdf}=await import('./fixtures/pdf.mjs');
  const d=await temp(t),pdf=path.join(d,'lecture.pdf'),png=path.join(d,'page.png');await writeFile(pdf,textPdf());
  const result=await readLecturePdfs([pdf]);assert.equal(result.pages.length,1);assert.match(result.pages[0].text,/inguinal/);assert.ok(result.sources[0].hash);
  await renderPdfPage(pdf,1,png);assert.deepEqual((await readFile(png)).subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  await assert.rejects(renderPdfPage(pdf,2,png),/Invalid/);
});
test('strict and Arabic-normalized metrics are distinct and silence has no fake WER',async()=>{
  const {accuracy}=await import('../companion/evaluation.mjs');assert.equal(accuracy('one two','one three').wer,.5);
  assert.equal(accuracy('أَلْف','الف',{arabic:true}).wer,0);assert.ok(accuracy('أَلْف','الف',{normalize:false}).wer>0);assert.equal(accuracy('','invented speech').wer,null);
});

test('a failed parallel chunk waits for active work before cleanup and stops dispatch',async()=>{
  let finished=false,third=false;
  await assert.rejects(boundedMap([0,1,2],2,async n=>{if(n===0){await new Promise(r=>setTimeout(r,2));throw new Error('decode failed');}if(n===1){await new Promise(r=>setTimeout(r,15));finished=true;}if(n===2)third=true;}),/decode failed/);
  assert.ok(finished);assert.equal(third,false);
});

test('cached models with matching size but changed bytes fail verification',async t=>{
  const {verifiedModel}=await import('../companion/whisper.mjs');const {createHash}=await import('node:crypto');const d=await temp(t),file=path.join(d,'model');await writeFile(file,'abcd');const model={bytes:4,sha256:createHash('sha256').update('abcd').digest('hex')};
  assert.equal(await verifiedModel(file,model),true);await writeFile(file,'abce');assert.equal(await verifiedModel(file,model),false);
});
test('persistent worker cancellation rejects pending requests and restart stays isolated',async t=>{
  const {WhisperWorker}=await import('../companion/persistent-whisper.mjs');const d=await temp(t),file=path.join(d,'worker.mjs');
  await writeFile(file,"import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',s=>{const r=JSON.parse(s);if(!r.hang)console.log(JSON.stringify({id:r.id,result:{ok:true}}));});\n");
  const worker=new WhisperWorker(process.execPath,file);try {assert.ok((await worker.request({})).ok);const controller=new AbortController();const request=worker.request({hang:true},controller.signal);controller.abort();await assert.rejects(request,{name:'AbortError'});assert.ok((await worker.request({})).ok);}finally{worker.close();}
});

test('PDF vocabulary is review-only by default and automatic bias requires explicit opt-in',async t=>{
  const {transcribeAudio}=await import('../companion/transcribe.mjs');const {contextIndex}=await import('../companion/lecture-context.mjs');const {vadModel}=await import('../companion/whisper.mjs');const {access,mkdir}=await import('node:fs/promises');
  if(!await access(vadModel).then(()=>true,()=>false)) return t.skip('Whisper VAD asset required');
  const ffmpeg=(await import('ffmpeg-static')).default,d=await temp(t),calls=[];
  const context=contextIndex([{page:1,file:'wrong.pdf',text:'Anatomy caput medusae portal hypertension'}]);
  const runner=async args=>{calls.push(args);await writeFile(args[args.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'en'},transcription:[{offsets:{from:0,to:3000},text:'The anterior abdominal wall has several layers.'}]}));return {code:0,stderr:'',build:'cpu'};};
  for(const pdfBias of [false,true]){const work=path.join(d,String(pdfBias));await mkdir(work);await transcribeAudio({ffmpeg,inputs:[(await import('node:url')).fileURLToPath(new URL('./fixtures/spoken-lecture.wav',import.meta.url))],work,context,options:{model:'tiny',language:'en',chunkSeconds:0,transcriber:'local',pdfBias},runner,modelResolver:async()=>'/mock-model',modelsDir:d});}
  assert.ok(!calls[0].includes('--prompt'));assert.ok(calls[1].includes('--prompt'));
});
