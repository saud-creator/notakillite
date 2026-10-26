// No network: manifest fixtures must already be downloaded and authorized.
// node scripts/benchmark-desktop.mjs manifest.json results.json [repeats=3]
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'ffmpeg-static';
import { transcribeAudio } from '../companion/transcribe.mjs';
import { closeWorkers } from '../companion/persistent-whisper.mjs';
import { readLecturePdfs } from '../companion/lecture-context.mjs';
import { accuracy } from '../companion/evaluation.mjs';
import { hashFile } from '../core/artifacts.mjs';
import { capabilities } from '../core/resource-policy.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);
const [manifestPath,output,repeatsArg='3']=process.argv.slice(2);
if(!manifestPath || !output) throw new Error('Usage: benchmark-desktop manifest.json results.json [repeats]');
const manifest=JSON.parse(await readFile(manifestPath,'utf8')), repeats=Number(repeatsArg);
if(!Number.isInteger(repeats)||repeats<1||repeats>20) throw new Error('Invalid repetitions.');
const report={schemaVersion:1,commit:(await execute('git',['rev-parse','HEAD'])).stdout.trim(),dirty:!!(await execute('git',['status','--porcelain'])).stdout.trim(),capabilities:await capabilities(),node:process.version,platform:os.release(),startedAt:new Date().toISOString(),runs:[],measurementScope:'End-to-end transcription; process-tree native RAM/VRAM and Windows UI latency require platform instrumentation.'};
try {
for(const fixture of manifest.fixtures) {
  const audio=path.resolve(path.dirname(manifestPath),fixture.audio); const sourceHash=await hashFile(audio);
  if(fixture.sha256 && fixture.sha256!==sourceHash) throw new Error('Fixture hash mismatch.');
  for(let repeat=0;repeat<repeats;repeat++) for(const profile of manifest.profiles) {
    const work=await mkdtemp(path.join(os.tmpdir(),'notakillite-bench-')); const events=[]; const start=performance.now();
    try {
      const pdfFiles=profile.pdfs || fixture.pdfs;
      const context=profile.pdfContext && pdfFiles?await readLecturePdfs(pdfFiles.map(p=>path.resolve(path.dirname(manifestPath),p))):undefined;
      const result=await transcribeAudio({ffmpeg,inputs:[audio],work,context,options:{transcriber:'local',model:'tiny',language:fixture.language||'auto',vocabulary:'',...profile.options},modelsDir:process.env.NOTAKILLITE_MODELS_DIR,log:e=>events.push({...e,elapsedMs:performance.now()-start})});
      const seconds=(performance.now()-start)/1000; const hypothesis=result.segments.filter(s=>!s.marker).map(s=>s.text).join(' ');
      report.runs.push({fixture:fixture.id,sourceHash,profile:profile.id,options:profile.options,repeat,seconds,duration:result.duration,rtf:seconds/result.duration,device:result.device,quality:result.quality.status,retryAudioSeconds:result.quality.attempts.reduce((s,a)=>s+a.end-a.start,0),referenceVerified:fixture.referenceVerified===true,forbiddenTermsFound:(fixture.forbiddenTerms || []).filter(t=>hypothesis.toLowerCase().includes(t.toLowerCase())),accuracy:fixture.referenceVerified&&fixture.reference?{strict:accuracy(fixture.reference,hypothesis,{normalize:false}),normalized:accuracy(fixture.reference,hypothesis,{arabic:fixture.language==='ar'})}:null,events});
    } catch(error) { report.runs.push({fixture:fixture.id,profile:profile.id,repeat,success:false,error:error.message}); } finally { closeWorkers(); await rm(work,{recursive:true,force:true}); }
    await writeFile(output,JSON.stringify(report,null,2));
  }
}
} finally { closeWorkers(); await writeFile(output,JSON.stringify(report,null,2)); }
console.log(`Saved ${report.runs.length} measured runs to ${output}`);
