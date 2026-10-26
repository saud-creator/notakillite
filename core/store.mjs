import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync } from 'node:fs';
export class Store {
  constructor(directory) {
    this.directory = directory;
    this.db = new DatabaseSync(path.join(directory, 'library.sqlite'));
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) { this.db.close(); throw new Error('This library needs a newer Notakillite version.'); }
    if (version === 1 && !existsSync(path.join(directory, 'library-before-v2.sqlite'))) this.db.exec("VACUUM INTO '" + path.join(directory, 'library-before-v2.sqlite').replaceAll("'", "''") + "'");
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,value TEXT NOT NULL); ');
    this.db.exec('BEGIN IMMEDIATE; CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search USING fts5(job UNINDEXED, segment UNINDEXED, text, start UNINDEXED); PRAGMA user_version=2; COMMIT;');
  }
  get(key, fallback) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  saveJob(job) { this.db.prepare('INSERT INTO jobs(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(job.id, JSON.stringify(job)); }
  jobs() { return this.db.prepare('SELECT value FROM jobs ORDER BY rowid DESC').all().map(row => JSON.parse(row.value)); }
  removeJob(id) { this.db.prepare('DELETE FROM jobs WHERE id=?').run(id); }
  indexTranscript(id, doc) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM transcript_search WHERE job=?').run(id); const insert = this.db.prepare('INSERT INTO transcript_search VALUES(?,?,?,?)'); for (const s of doc.segments) if (!s.marker) insert.run(id, s.id, s.text, s.start); this.db.exec('COMMIT'); } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  search(text) { const query = String(text).match(/[\p{L}\p{N}]+/gu)?.map(t => '"' + t + '"').join(' AND '); return query ? this.db.prepare('SELECT job,segment,text,start FROM transcript_search WHERE transcript_search MATCH ? LIMIT 100').all(query) : []; }
  close() { this.db.close(); }
}
