import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
let gpuCache;
async function gpuInfo() {
  if(gpuCache) return gpuCache;
  try { const {stdout} = await execute('nvidia-smi',['--query-gpu=name,memory.total,memory.free,driver_version','--format=csv,noheader,nounits'],{timeout:3000,windowsHide:true});
    return gpuCache=stdout.trim().split('\n').map(line=>{const [name,total,free,driver]=line.split(',').map(x=>x.trim());return {name,driver,dedicated:true,totalBytes:Number(total)*1024**2,availableBytes:Number(free)*1024**2,source:'nvidia-smi'};});
  } catch { return []; }
}
import { readFile } from 'node:fs/promises';
export async function capabilities() {
  let effective = os.availableParallelism?.() || os.cpus().length;
  if (process.platform === 'linux') {
    const quota = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => '')).trim().split(/\s+/);
    if (quota[0] && quota[0] !== 'max' && +quota[1] > 0) effective = Math.min(effective, Math.max(1, Math.floor(+quota[0] / +quota[1])));
  }
  let available = os.freemem(), total = os.totalmem();
  if (process.platform === 'linux') {
    const [limit, used] = await Promise.all(['memory.max', 'memory.current'].map(n => readFile(`/sys/fs/cgroup/${n}`, 'utf8').then(Number).catch(() => NaN)));
    if (Number.isFinite(limit) && Number.isFinite(used)) { total = Math.min(total, limit); available = Math.min(available, Math.max(0, limit - used)); }
  }
  return { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, gpus: await gpuInfo(), logical: os.cpus().length, effective, total, available };
}
export function inferenceExecutionLimit({ chunked, persistentWorkerAvailable = false, availableChunks = 1 } = {}) {
  if (!chunked) return { maxWorkers: 1, reason: 'Unchunked inference runs one request at a time.' };
  if (persistentWorkerAvailable) return { maxWorkers: 1, reason: 'The persistent native worker processes requests serially.' };
  const chunks = Math.max(1, Math.floor(Number(availableChunks) || 1));
  return { maxWorkers: chunks, reason: `The CLI path has ${chunks} available chunks.` };
}
export function resourcePlan(cap, options = {}, modelBytes = 874188075, executionLimit = null) {
  const policy = options.resourcePolicy || 'auto';
  if (!['auto', 'background', 'maximum'].includes(policy)) throw new Error('Unknown resource policy.');
  const limit = policy === 'background' ? Math.max(1, Math.floor(cap.effective / 2)) : policy === 'maximum' ? cap.effective : Math.max(1, cap.effective - (cap.effective > 2 ? 1 : 0));
  const threads = Math.min(limit, Math.max(1, Number(options.threads) || limit));
  const budget = Math.max(0, cap.available - Math.max(2 * 1024 ** 3, cap.total * .2));
  // CLI workers duplicate model/context allocations. Extra workers are explicit until benchmarked.
  const workerBytes = modelBytes * 1.5 + 512 * 1024 ** 2;
  const requestedWorkers = Math.max(1, Number(options.workers) || 1);
  const caps = [
    { max: threads, reason: 'CPU thread budget' },
    { max: Math.max(1, Math.floor(budget / workerBytes) || 1), reason: 'available memory budget' },
  ];
  if (executionLimit?.maxWorkers !== undefined) caps.push({ max: Math.max(1, Math.floor(Number(executionLimit.maxWorkers) || 1)), reason: executionLimit.reason || 'execution path limit' });
  const workerLimit = Math.max(1, Math.min(...caps.map(cap => cap.max)));
  const workers = Math.max(1, Math.min(requestedWorkers, workerLimit));
  const workerLimitReasons = requestedWorkers > workerLimit ? caps.filter(cap => cap.max === workerLimit).map(cap => cap.reason) : [];
  return { policy, cpuBudget: threads, threads: Math.max(1, Math.floor(threads / workers)), workers, requestedWorkers, workerLimit, workerLimitReasons,
    executionLimit: executionLimit ? { maxWorkers: executionLimit.maxWorkers, reason: executionLimit.reason } : null,
    memoryBudget: budget, estimatedWorkerBytes: workerBytes, insufficientMemory: budget < workerBytes, preparedQueueLimit: workers * 2 };
}
export async function boundedMap(items, limit, fn, signal) {
  const out = new Array(items.length); let next = 0, failure;
  const workers=Array.from({ length: Math.min(Math.max(1,limit), items.length) }, async () => {
    try { for (;;) { if(failure) return; signal?.throwIfAborted(); const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }
    catch(error) { failure ||= error; }
  });
  await Promise.all(workers); if(failure) throw failure; return out;
}
