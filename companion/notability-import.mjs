// Expands what the user imports (audio files, Notability .note exports, ZIPs and folders)
// into an ordered list of recordings. A .note export is a ZIP archive whose Recordings
// folder holds the audio; "PDF + Recording" exports are plain ZIPs with .m4a files.
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import path from 'node:path';

const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.aac', '.alac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.caf', '.aif', '.aiff', '.wma', '.amr', '.mp4', '.3gp', '.audio']);
const ARCHIVE_EXTENSIONS = new Set(['.note', '.zip']);
const MAX_ENTRIES = 20000;

export const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Reads a ZIP central directory. Supports stored and deflated entries (all Notability exports). */
export async function zipEntries(file) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let i = tailLength - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('This file is not a Notability note or ZIP archive.');
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('This archive is too large to import. Export the note again with fewer recordings.');
    if (count > MAX_ENTRIES || directoryOffset + directorySize > size) throw new Error('This archive is damaged.');
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const entries = [];
    for (let offset = 0, index = 0; index < count; index++) {
      if (directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('This archive is damaged.');
      const flags = directory.readUInt16LE(offset + 8), method = directory.readUInt16LE(offset + 10);
      const compressedSize = directory.readUInt32LE(offset + 20), uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28), extraLength = directory.readUInt16LE(offset + 30), commentLength = directory.readUInt16LE(offset + 32);
      const localOffset = directory.readUInt32LE(offset + 42);
      const raw = directory.subarray(offset + 46, offset + 46 + nameLength);
      const name = (flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')).replaceAll('\\', '/');
      offset += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/') || name.startsWith('__MACOSX/') || path.posix.basename(name).startsWith('._')) continue;
      entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset });
    }
    return entries;
  } finally { await handle.close(); }
}

async function entryDataOffset(file, entry) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('This archive is damaged.');
    return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally { await handle.close(); }
}

async function readEntryStart(file, entry, length = 16) {
  if (entry.method !== 0) return null;
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(length, entry.compressedSize));
    await handle.read(bytes, 0, bytes.length, await entryDataOffset(file, entry));
    return bytes;
  } finally { await handle.close(); }
}

/** Extracts one archive entry to `destination`, never trusting the entry's own path. */
export async function extractEntry(file, entry, destination, { signal } = {}) {
  if (entry.flags & 0x1) throw new Error('This note is password protected. Export it again without a password.');
  if (![0, 8].includes(entry.method)) throw new Error('This archive uses an unsupported compression method.');
  if (!entry.compressedSize) throw new Error('The recording inside this note is empty.');
  const start = await entryDataOffset(file, entry);
  const stages = [createReadStream(file, { start, end: start + entry.compressedSize - 1 })];
  if (entry.method === 8) stages.push(createInflateRaw());
  stages.push(createWriteStream(destination));
  await pipeline(stages, { signal });
  const written = (await stat(destination)).size;
  if (written !== entry.uncompressedSize) throw new Error('The recording inside this note is incomplete. Export the note again.');
}

/** Recognises audio by its first bytes, so ".audio" or extension-less recordings still import. */
export function looksLikeAudio(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const ascii = (start, end) => bytes.toString('latin1', start, end);
  return ascii(4, 8) === 'ftyp' || ascii(0, 4) === 'caff' || ascii(0, 4) === 'RIFF' || ascii(0, 3) === 'ID3' || ascii(0, 4) === 'FORM'
    || ascii(0, 4) === 'fLaC' || ascii(0, 4) === 'OggS' || bytes.readUInt32BE(0) === 0x1a45dfa3 || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
}

function isAudioEntry(entry, startBytes) {
  const extension = path.posix.extname(entry.name).toLowerCase();
  if (['.plist', '.pdf', '.png', '.jpg', '.jpeg', '.heic', '.json', '.txt', '.xml', '.gif', '.zip'].includes(extension)) return false;
  if (AUDIO_EXTENSIONS.has(extension)) return true;
  return /(^|\/)recordings\//i.test(entry.name) && looksLikeAudio(startBytes);
}

/** Lists the recordings inside a .note/.zip export, in Notability's order when it can be read. */
export async function archiveRecordings(file) {
  const entries = await zipEntries(file);
  const audio = [];
  for (const entry of entries) if (entry.uncompressedSize > 0 && isAudioEntry(entry, await readEntryStart(file, entry))) audio.push(entry);
  // Notability lists recordings in Recordings/library.plist. Binary plists store strings in
  // object order, so the first mention of each file name gives the saved recording order.
  const library = entries.find(entry => /(^|\/)recordings\/library\.plist$/i.test(entry.name));
  let order = new Map();
  if (library && library.uncompressedSize < 4 * 1024 * 1024) {
    const text = await entryText(file, library).catch(() => '');
    for (const entry of audio) { const at = text.indexOf(path.posix.basename(entry.name)); if (at >= 0) order.set(entry.name, at); }
  }
  audio.sort((a, b) => (order.has(a.name) && order.has(b.name) ? order.get(a.name) - order.get(b.name) : 0) || naturalCompare(a.name, b.name));
  return audio;
}

async function entryText(file, entry) {
  const chunks = [];
  const start = await entryDataOffset(file, entry);
  const stream = createReadStream(file, { start, end: start + Math.max(0, entry.compressedSize - 1) });
  const source = entry.method === 8 ? stream.pipe(createInflateRaw()) : stream;
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks).toString('latin1');
}

const titleOf = file => path.basename(file, path.extname(file)).normalize('NFC').trim() || 'Lecture';

/**
 * Turns imported paths into ordered recording items:
 *   { kind: 'file', file, title, recordingName } or
 *   { kind: 'archive', archive, entry, title, recordingName }
 */
export async function expandImports(paths, { depth = 3 } = {}) {
  const items = [];
  const visit = async (target, level) => {
    const info = await stat(target).catch(() => null);
    if (!info) throw new Error(`Could not find ${path.basename(target)}. It may have been moved.`);
    if (info.isDirectory()) {
      if (level >= depth) return;
      const names = (await readdir(target)).filter(name => !name.startsWith('.')).sort(naturalCompare);
      for (const name of names) {
        const child = path.join(target, name), extension = path.extname(name).toLowerCase();
        const childInfo = await stat(child).catch(() => null);
        if (childInfo?.isDirectory() || AUDIO_EXTENSIONS.has(extension) || ARCHIVE_EXTENSIONS.has(extension)) await visit(child, level + 1);
      }
      return;
    }
    if (!info.isFile() || !info.size) return;
    if (info.size > 2 * 1024 ** 3) throw new Error(`${path.basename(target)} is larger than 2 GB.`);
    const extension = path.extname(target).toLowerCase();
    if (ARCHIVE_EXTENSIONS.has(extension)) {
      const recordings = await archiveRecordings(target);
      if (!recordings.length) throw new Error(`${path.basename(target)} has no audio recordings. In Notability, export the note in "Note" format (or "PDF + Recording") so recordings are included.`);
      recordings.forEach((entry, index) => items.push({ kind: 'archive', archive: target, entry: entry.name, title: titleOf(target), recordingName: recordings.length > 1 ? `Recording ${index + 1}` : 'Recording', fingerprint: `${info.size}:${info.mtimeMs}` }));
      return;
    }
    items.push({ kind: 'file', file: target, title: titleOf(target), recordingName: path.basename(target) });
  };
  for (const target of paths) await visit(path.resolve(target), 0);
  return items;
}
