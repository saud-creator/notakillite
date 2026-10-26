import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export class WhisperWorker {
  constructor(program, model, cpu = false) { this.program = program; this.model = model; this.cpu = cpu; this.next = 0; this.pending = new Map(); }
  start() {
    if (this.child) return;
    this.child = spawn(this.program, [this.model, ...(this.cpu ? ['--cpu'] : [])], { windowsHide: true, stdio: ['pipe','pipe','pipe'], env:{...process.env, OMP_WAIT_POLICY:'PASSIVE'} });
    const child=this.child;
    child.stdin.on('error',e=>{if(this.child===child)this.close(e);});
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { const value = JSON.parse(line); const req = this.pending.get(value.id); if (!req) return; value.error ? req.reject(new Error(value.error)) : req.resolve(value.result); }
      catch { this.close(new Error('Invalid inference worker response.')); }
    });
    this.child.on('error', e => {if(this.child===child)this.close(e);}); this.child.on('exit', () => {if(this.child===child)this.close(new Error('Inference worker stopped.'));});
  }
  async request(data, signal) {
    signal?.throwIfAborted(); this.start(); const id = ++this.next;
    const timeout = setTimeout(() => this.close(new Error('Inference worker deadline exceeded.')), 30 * 60 * 1000);
    const abort = () => this.close(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    try { return await new Promise((resolve,reject) => { this.pending.set(id, { resolve,reject }); this.child.stdin.write(JSON.stringify({ ...data, id })+'\n', e => { if (e) reject(e); }); }); }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.pending.delete(id); }
  }
  close(error = new Error('Worker closed.')) { const child = this.child; this.child = null; child?.kill(); for (const req of this.pending.values()) req.reject(error); this.pending.clear(); }
}
const workers = new Map();
export async function hasPersistentWorker(backend='auto') {
  const kinds=backend==='cpu'?['cpu']:backend==='auto'?['cuda','vulkan','cpu']:[backend,'cpu'];
  const candidates=process.env.NOTAKILLITE_WORKER?[process.env.NOTAKILLITE_WORKER]:kinds.map(kind=>path.join(root,'vendor','whisper',kind,`notakillite-worker${process.platform==='win32'?'.exe':''}`));
  for(const candidate of candidates) if(await access(candidate).then(()=>true,()=>false)) return true; return false;
}
export async function persistentPass({ modelFile, wav, language, prompt, threadCount, signal, backend, vad = false, vadModelPath }) {
  const kinds=backend==='cpu'?['cpu']:backend==='auto'?['cuda','vulkan','cpu']:[backend,'cpu'];
  const candidates=process.env.NOTAKILLITE_WORKER?[process.env.NOTAKILLITE_WORKER]:kinds.map(kind=>path.join(root,'vendor','whisper',kind,`notakillite-worker${process.platform==='win32'?'.exe':''}`));
  let program; for (const candidate of candidates) if (await access(candidate).then(()=>true,()=>false)) { program = candidate; break; }
  if (!program) return null;
  const key = `${program}:${modelFile}:${backend}`;
  // One persistent model per process; bounded pool avoids retaining several multi-GB models.
  if (!workers.has(key)) { closeWorkers(); workers.set(key, new WhisperWorker(program,modelFile,backend === 'cpu')); }
  const worker = workers.get(key);
  try {
  let terms = prompt;
  while (terms && (await worker.request({ type:'tokenize', text:terms },signal)).tokens > 96) terms = terms.slice(0, Math.floor(terms.length * .8)).replace(/\s+\S*$/, '');
  const useVad=vad===true;
  const result=await worker.request({ file:wav, language, prompt:terms, threads:threadCount || 1, vad:useVad, ...(useVad?{vadModelPath}: {}) },signal);
  if(typeof result.vadApplied!=='boolean'||result.vadApplied!==useVad||!Number.isInteger(result.vadSegments)||result.vadSegments<0) throw new Error('Native worker does not report applied voice detection.');
  if(!Array.isArray(result.segments)||result.segments.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.end<s.start||typeof s.text!=='string')) throw new Error('Invalid native transcript.');
  return { ...result, build: backend === 'cpu' ? 'cpu' : 'native', persistent:true }; }
  catch(e) { worker.close(); workers.delete(key); if (signal?.aborted) throw e; return null; }
}
export function closeWorkers() { for (const worker of workers.values()) worker.close(); workers.clear(); }
