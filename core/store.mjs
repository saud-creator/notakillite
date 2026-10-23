import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
export class Store {
  constructor(directory) {
    this.directory = directory;
    this.db = new DatabaseSync(path.join(directory, 'library.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1;');
  }
  get(key, fallback) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  saveJob(job) { this.db.prepare('INSERT INTO jobs(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(job.id, JSON.stringify(job)); }
  jobs() { return this.db.prepare('SELECT value FROM jobs ORDER BY rowid DESC').all().map(row => JSON.parse(row.value)); }
  removeJob(id) { this.db.prepare('DELETE FROM jobs WHERE id=?').run(id); }
  close() { this.db.close(); }
}
