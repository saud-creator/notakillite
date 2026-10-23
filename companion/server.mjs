import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { processAudio, safeName } from './audio.mjs';
import { availableEngines, requireEngine, settings } from './engines.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = process.env.NOTAKILLITE_DATA_DIR || root;
const outputRoot = path.join(dataRoot, 'exports');
const uploadRoot = path.join(dataRoot, '.local', 'uploads');
const PORT = Number(process.env.NOTAKILLITE_PORT || 43188);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('Invalid local processor port.');
const MAX_AUDIO = 2 * 1024 ** 3;
const token = randomBytes(32).toString('hex');
const jobs = new Map();
const engines = await availableEngines();
let queue = Promise.resolve();
await mkdir(uploadRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });
// Incomplete uploads from a previous run are disposable; exported lectures are retained.
for (const name of await readdir(uploadRoot)) {
  if (/^[a-f0-9-]{36}\.audio$/.test(name)) await rm(path.join(uploadRoot, name), { force: true });
  if (/^denoise-[a-zA-Z0-9]+$/.test(name) && (await stat(path.join(uploadRoot, name))).isDirectory()) await rm(path.join(uploadRoot, name), { recursive: true, force: true });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request exceeds the allowed size.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function authorized(req) {
  const value = req.headers['x-notakillite-token'];
  return typeof value === 'string' && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

function view(job) {
  return { id: job.id, status: job.status, title: job.metadata.title, recordingName: job.metadata.recordingName, engine: job.metadata.engine, bytes: job.offset, processedSeconds: job.processedSeconds, phase: job.phase, fraction: job.fraction, error: job.error, files: job.files };
}

async function run(job) {
  job.status = 'processing';
  try {
    const manifest = await processAudio({ ffmpeg, input: job.input, destination: job.destination, metadata: job.metadata, onProgress: seconds => { job.processedSeconds = seconds; }, onStage: stage => { job.phase = stage.phase; job.fraction = stage.fraction; } });
    job.files = manifest.files.map(file => ({ ...file, url: `http://127.0.0.1:${PORT}/files/${job.id}/${encodeURIComponent(file.name)}` }));
    job.status = 'done';
  } catch (error) {
    job.status = 'error';
    job.error = error.message;
    await rm(job.destination, { recursive: true, force: true });
  } finally {
    await rm(job.input, { force: true });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) return json(res, 403, { error: 'Invalid host.' });
    const origin = req.headers.origin;
    const extension = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    if (origin && !extension) return json(res, 403, { error: 'Only the browser extension can access the processor.' });
    if (extension) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Notakillite-Token, X-Chunk-Offset');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' });
      return res.end(readFileSync(new URL('./welcome.html', import.meta.url)));
    }
    if (['GET', 'POST'].includes(req.method) && url.pathname === '/health') {
      if (!extension) return json(res, 200, { ready: true, app: 'Notakillite' });
      return json(res, 200, { ready: true, token, version: '0.3.0', engines });
    }
    // Download links contain an unguessable job ID; no filesystem paths come from requests.
    const download = url.pathname.match(/^\/files\/([a-f0-9-]{36})\/(lecture(?:-\d+)?\.mp3)$/);
    if (req.method === 'GET' && download) {
      const job = jobs.get(download[1]);
      if (!job || job.status !== 'done' || !job.files.some(file => file.name === download[2])) return json(res, 404, { error: 'File not found.' });
      const filename = path.join(job.destination, download[2]);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': (await stat(filename)).size, 'Content-Disposition': `attachment; filename="${download[2]}"`, 'Cache-Control': 'no-store' });
      return createReadStream(filename).on('error', () => res.destroy()).pipe(res);
    }
    if (!authorized(req)) return json(res, 401, { error: 'Connect through the Notakillite extension.' });
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const data = JSON.parse((await readBody(req, 8192)).toString());
      if (typeof data.title !== 'string' || typeof data.recordingName !== 'string' || typeof data.clean !== 'boolean' || ![0, 10, 20, 30].includes(data.splitMinutes)) return json(res, 400, { error: 'Invalid export settings.' });
      const options = settings(data);
      await requireEngine(options.engine);
      if ([...jobs.values()].filter(job => ['uploading', 'queued', 'processing'].includes(job.status)).length >= 8) return json(res, 429, { error: 'Wait for the current exports to finish.' });
      const id = randomUUID();
      const job = { id, metadata: { ...options, source: data.source === 'Local audio file' ? 'Local audio file' : 'Notability web account' }, offset: 0, status: 'uploading', processedSeconds: 0, input: path.join(uploadRoot, `${id}.audio`), destination: path.join(outputRoot, `${safeName(data.title)} - ${safeName(data.recordingName)} - ${id.slice(0, 8)}`) };
      await appendFile(job.input, Buffer.alloc(0), { flag: 'wx' });
      jobs.set(id, job);
      return json(res, 201, view(job));
    }
    const match = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})(?:\/(audio|process))?$/);
    const job = match && jobs.get(match[1]);
    if (match && !job) return json(res, 404, { error: 'Export not found. Restart the export if the companion was restarted.' });
    if (job && req.method === 'GET' && !match[2]) return json(res, 200, view(job));
    if (job && req.method === 'PUT' && match[2] === 'audio') {
      if (job.status !== 'uploading' || job.writing) return json(res, 409, { error: 'This export is not accepting audio.' });
      const offset = Number(req.headers['x-chunk-offset']);
      if (!Number.isSafeInteger(offset) || offset !== job.offset) return json(res, 409, { error: 'Audio transfer is out of order. Please restart the export.' });
      job.writing = true;
      try {
        const bytes = await readBody(req, 1024 * 1024);
        if (job.offset + bytes.length > MAX_AUDIO) throw new Error('Recordings larger than 2 GB are not supported.');
        await appendFile(job.input, bytes);
        job.offset += bytes.length;
      } finally { job.writing = false; }
      return json(res, 200, { offset: job.offset });
    }
    if (job && req.method === 'POST' && match[2] === 'process') {
      if (job.status !== 'uploading' || job.writing || !job.offset) return json(res, 409, { error: 'Finish transferring audio first.' });
      job.status = 'queued';
      queue = queue.then(() => run(job)).catch(() => {});
      return json(res, 202, view(job));
    }
    if (job && req.method === 'DELETE' && !match[2] && job.status === 'uploading' && !job.writing) {
      await rm(job.input, { force: true });
      jobs.delete(job.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/open-output') {
      const program = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(program, [outputRoot], { windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Unknown operation.' });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error.message || 'Request failed.' });
    else res.destroy();
  }
});
server.requestTimeout = 120000;
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Notakillite is already running on port 43188.' : error.message);
  process.exitCode = 1;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Notakillite audio processor is ready: http://127.0.0.1:${PORT}`);
  console.log(`Audio exports are saved in: ${outputRoot}`);
  console.log('Open Notability in Chrome or Edge with the Notakillite extension enabled.');
});
