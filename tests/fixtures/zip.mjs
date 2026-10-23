// Minimal ZIP writer for building synthetic Notability .note exports in tests.
import { crc32, deflateRawSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

export async function writeZip(file, entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data, store = false } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const body = store ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(store ? 0 : 8, 8);
    header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(store ? 0 : 8, 10);
    record.writeUInt32LE(crc32(raw), 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, body); central.push(record, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  await writeFile(file, Buffer.concat([...locals, directory, end]));
}
