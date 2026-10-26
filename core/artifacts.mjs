import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function hashFile(file) { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); }
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.partial`;
  try { await writeFile(temp, JSON.stringify(value, null, 2)); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
export async function claimDirectory(directory, owner) {
  await mkdir(directory, { recursive: true }); const marker = path.join(directory, '.notakillite-owner.json');
  try { await writeFile(marker, JSON.stringify({ owner }), { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST' || JSON.parse(await readFile(marker, 'utf8')).owner !== owner) throw new Error('The output folder belongs to another export.'); }
}
export async function loadCheckpoint(file, key) { try { const data = JSON.parse(await readFile(file, 'utf8')); return data.key === key ? data.result : null; } catch { return null; } }
