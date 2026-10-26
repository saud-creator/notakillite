import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { boundedMap } from '../core/resource-policy.mjs';
import { fingerprint, hashFile, atomicJson, loadCheckpoint } from '../core/artifacts.mjs';
import { retrieveContext } from './lecture-context.mjs';
// Ownership cores never overlap. Decoder windows include surrounding acoustic context.
export function chunkWindows(duration, silences = [], seconds = 60, overlap = 2) {
  const chunks = []; let start = 0;
  while (start < duration) {
    let end = Math.min(duration, start + seconds);
    if (end < duration) {
      const nearby = silences.map(s => (s.start + s.end) / 2).filter(t => t > start + seconds * .5 && Math.abs(t - end) <= 8).sort((a, b) => Math.abs(a - end) - Math.abs(b - end));
      end = nearby[0] ?? end;
    }
    chunks.push({ index: chunks.length, start, end, decodeStart: Math.max(0, start - overlap), decodeEnd: Math.min(duration, end + overlap) }); start = end;
  }
  return chunks;
}
export function recoveryWindows(findings, pieces, duration, padding = 3, segments = []) {
  const result = [];
  for (const f of [...findings].sort((a,b) => a.start - b.start)) {
    let start = Math.max(0, f.start - padding), end = Math.min(duration, Math.max(f.end, f.start + 1) + padding);
    // Include complete existing segments via the caller so no boundary sentence is discarded.
    const last = result.at(-1);
    if (last && start <= last.end + 2) { last.end = Math.max(last.end, end); last.findings.push(f); }
    else result.push({ index: result.length, start, end, findings: [f] });
  }
  const windows = result.length ? result : pieces.filter(p => !p.ok);
  for (const window of windows) {
    const text = new Set(segments.filter(s=>s.end>window.start && s.start<window.end).map(s=>s.text.trim().toLowerCase()));
    let changed;
    do { changed=false; for (const s of segments) if(text.has(s.text.trim().toLowerCase()) && s.end>=window.start-3 && s.start<=window.end+3) {
      const start=Math.max(0,Math.min(window.start,s.start)),end=Math.min(duration,Math.max(window.end,s.end));
      if(start!==window.start || end!==window.end) { window.start=start; window.end=end; changed=true; }
    } } while(changed);
  }
  const merged=[];
  for(const p of windows.sort((a,b)=>a.start-b.start)) { const last=merged.at(-1); if(last && p.start<=last.end) { last.end=Math.max(last.end,p.end); last.findings=[...(last.findings||[]),...(p.findings||[])]; } else merged.push({...p}); }
  return merged.flatMap(p => { const out=[]; let start=p.start;
    const opening=segments.filter(s=>s.start<start && s.end>start); if(opening.length) start=Math.max(0,Math.min(start,...opening.map(s=>s.start)));
    while(start<p.end) { let end=Math.min(p.end,start+120); const crossing=segments.filter(s=>s.start<end && s.end>end); if(crossing.length) end=Math.min(duration,Math.max(end,...crossing.map(s=>s.end))); out.push({...p,start,end}); start=end; }
    return out;
  }).map((p,index)=>({...p,index}));
}
export async function transcribeChunks({ wav, duration, silences, work, checkpointDir, options, resource, context, signal, cut, decode, onProgress = () => {}, log = () => {} }) {
  const chunks = chunkWindows(duration, silences, options.chunkSeconds || 60);
  const source = await hashFile(wav); const root = checkpointDir || path.join(work, 'checkpoints'); await mkdir(root, { recursive: true });
  let complete = 0; const started = Date.now();
  const results = await boundedMap(chunks, resource.workers, async chunk => {
    const key = fingerprint({ version: 3, whisperCommit:'d1be6fde11ac6e0407606b4e42fe72d34add8037', source, chunk, options, context: context?.sources, glossary: context?.glossary });
    const checkpoint = path.join(root, `chunk-${chunk.index}.json`);
    let result = await loadCheckpoint(checkpoint, key);
    if (result) log({ event: 'checkpoint-reused', chunk: chunk.index });
    else {
      const file = path.join(work, `chunk-${chunk.index}.wav`);
      try {
        await cut(file, chunk.decodeStart, chunk.decodeEnd);
        const selected = options.pdfBias ? retrieveContext(context, '', 320) : {vocabulary:''};
        result = await decode(file, chunk.decodeEnd - chunk.decodeStart, { ...options, vocabulary: [options.vocabulary, selected.vocabulary].filter(Boolean).join(', ').slice(0, 600), threads: resource.threads }, chunk.index);
        result.segments = result.segments.map(s => ({ ...s, start: s.start + chunk.decodeStart, end: Math.min(duration, s.end + chunk.decodeStart) }));
        await atomicJson(checkpoint, { key, result });
      } finally { await rm(file, { force: true }); }
    }
    complete += chunk.end - chunk.start;
    onProgress({ phase: `Transcribing · ${Math.round(complete / duration * 100)}%`, fraction: complete / duration * .8, completedSeconds: complete, etaSeconds: complete ? (Date.now() - started) / 1000 * (duration - complete) / complete : null, resources: resource });
    return { chunk, result };
  }, signal);
  // Select by the midpoint inside a disjoint ownership core. Preserve true repeated speech.
  const segments = results.flatMap(({ chunk, result }) => result.segments.filter(s => {
    const midpoint = (s.start + s.end) / 2; return midpoint >= chunk.start && (midpoint < chunk.end || chunk.end === duration);
  })).sort((a,b) => a.start - b.start);
  return { ...results[0]?.result, segments, chunks: chunks.length, resources: resource };
}
