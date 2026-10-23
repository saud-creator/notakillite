import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { CoreService } from '../../core/service.mjs';
import { runTool } from '../../companion/audio.mjs';
import { wavSamples } from '../../companion/engines.mjs';

const directory=path.resolve('.local/long-lecture-qa');await mkdir(directory,{recursive:true});
const free=await statfs(directory);assert.ok(free.bavail*free.bsize>3*1024**3,'The long-lecture check requires 3 GB of free test disk space.');
const seconds=2700.137, input=path.join(directory,'45-minute generated lecture.wav');
await runTool(ffmpeg,['-y','-stream_loop','-1','-i',path.resolve('tests/fixtures/spoken-lecture.wav'),'-t',String(seconds),'-ac','1','-ar','48000','-c:a','pcm_s16le',input]);
const service=await new CoreService({dataRoot:path.join(directory,'app-data'),connector:{async close(){}}}).init();
const started=Date.now();let lastPhase='',coreMaxRss=0;
const timer=setInterval(()=>{coreMaxRss=Math.max(coreMaxRss,process.resourceUsage().maxRSS);const job=service.jobs.find(job=>job.status==='running');if(job&&job.phase!==lastPhase){lastPhase=job.phase;console.log(JSON.stringify({phase:lastPhase,elapsedSeconds:Math.round((Date.now()-started)/1000)}));}},500);timer.unref();
try{
 const id=(await service.enqueue({file:input,engine:'deepfilter',strength:'balanced',splitMinutes:0})).ids[0];let job;
 for(let i=0;i<24000;i++){job=service.jobs.find(job=>job.id===id);if(['done','error','cancelled'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(job.status,'done',job.error);
 const decoded=path.join(directory,'verified-output.wav');await runTool(ffmpeg,['-y','-v','error','-i',job.files[0].path,'-ac','1','-ar','24000','-c:a','pcm_s16le',decoded]);
 const samples=await wavSamples(decoded);assert.equal(samples,Math.round(seconds*24000));
 const tail=path.join(directory,'verified-tail.raw');await runTool(ffmpeg,['-y','-v','error','-sseof','-3','-i',decoded,'-f','f32le',tail]);
 const bytes=await readFile(tail), floats=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));let sum=0;for(const value of floats)sum+=value*value;const tailRms=Math.sqrt(sum/floats.length);assert.ok(tailRms>0.0002,'The final seconds must retain the generated speech.');
 assert.deepEqual(await readdir(service.paths.temp),[]);assert.ok(!(await readdir(job.destination)).includes('.partial'));
 const report={result:'passed',fixture:'Generated speech loop, no user account audio',engine:'DeepFilterNet3',sourceSeconds:seconds,decodedSamples:samples,rate:24000,tailRms,outputBytes:(await stat(job.files[0].path)).size,processingSeconds:Math.round((Date.now()-started)/1000),coreMaxRssMB:Math.round(coreMaxRss/1024),workerMemoryMeasured:false,temporaryCleanup:'passed',outputVerification:'passed'};
 await writeFile(path.join(directory,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{clearInterval(timer);await service.close();}
