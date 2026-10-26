// Opt-in public corpus preparation. No private data is sent. See docs/implementation/EVALUATION.md.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from '../core/artifacts.mjs';
const destination=path.resolve(process.argv[2]||'.local/fleurs'); await mkdir(destination,{recursive:true}); const fixtures=[];
for(const [config,language] of [['en_us','en'],['ar_eg','ar']]) {
  const response=await fetch(`https://datasets-server.huggingface.co/rows?dataset=google%2Ffleurs&config=${config}&split=test&offset=0&length=10`);
  if(!response.ok) throw new Error(`Public dataset unavailable (${response.status}); no accuracy claim can be made.`);
  const data=await response.json();
  for(const item of data.rows) {
    const row=item.row, resource=row.audio?.[0]; if(!resource?.src || !row.transcription) throw new Error('Unexpected FLEURS schema.');
    const file=`${config}-${item.row_idx}.audio`, audio=await fetch(resource.src); if(!audio.ok) throw new Error('Audio download failed.');
    await writeFile(path.join(destination,file),new Uint8Array(await audio.arrayBuffer()));
    fixtures.push({id:`${config}-${item.row_idx}`,audio:file,language,reference:row.transcription,referenceVerified:true,referenceOrigin:'FLEURS human transcription; independent spot check pending',sha256:await hashFile(path.join(destination,file)),source:'google/fleurs',split:'test',license:'CC-BY-4.0',tuningAllowed:false});
  }
}
await writeFile(path.join(destination,'manifest.json'),JSON.stringify({fixtures,profiles:[{id:'balanced',options:{model:'turbo',chunkSeconds:60}}]},null,2));
