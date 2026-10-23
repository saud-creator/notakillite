import { chromium } from 'playwright-core';
import { access, readFile, open, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterSource = await readFile(new URL('./notability-adapter.js', import.meta.url), 'utf8');
export async function findBrave(explicit) {
  for (const filename of [explicit, process.env.NOTAKILLITE_BRAVE, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'), path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe')].filter(Boolean)) {
    try { await access(filename); return filename; } catch {}
  }
  throw new Error('Install Brave Browser, then press Connect. Your saved Notakillite profile will be reused.');
}
export class BraveConnector {
  constructor({ profile, executable, headless = false, onDisconnect = () => {}, prepareContext } = {}) { Object.assign(this, { profile, executable, headless, onDisconnect, prepareContext }); }
  async connect() {
    if (this.context) return this.context;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const executablePath = await findBrave(this.executable);
      try {
        const context = await chromium.launchPersistentContext(this.profile, {
          executablePath, headless: this.headless, viewport: null, timeout: 30000, serviceWorkers: this.prepareContext ? 'block' : 'allow',
          ignoreDefaultArgs: ['--enable-automation', '--disable-component-update', '--disable-background-networking'],
          args: ['--no-first-run', '--window-size=1150,850'],
        });
        this.context = context;
        await this.prepareContext?.(context);
        context.on('close', () => { if (this.context === context) { this.context = undefined; this.page = undefined; this.onDisconnect(); } });
        const existing = context.pages().find(page => this.isNotability(page.url()));
        this.page = existing || await context.newPage();
        if (!existing) await this.page.goto('https://notability.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        return context;
      } catch (error) {
        if (/SingletonLock|already in use|ProcessSingleton|browser.*closed|Target.*closed/i.test(error.message)) throw new Error('The Notakillite Brave profile is busy. Close its Brave window, then press Connect. Your normal Brave windows can stay open.');
        throw new Error(`Brave could not start: ${error.message.split('\n')[0]}`);
      }
    })();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }
  isNotability(url) { try { const u = new URL(url); return u.origin === 'https://notability.com' && u.pathname.startsWith('/app'); } catch { return false; } }
  async target() {
    if (!this.context) throw new Error('Connect to Brave to read your Notability library.');
    if (!this.page || this.page.isClosed() || !this.isNotability(this.page.url())) this.page = this.context.pages().find(page => this.isNotability(page.url()));
    if (!this.page) throw new Error('Open Notability in the app’s Brave window, then reconnect.');
    return this.page;
  }
  async call(operation, ...args) {
    const page = await this.target();
    await page.evaluate(adapterSource);
    return page.evaluate(async ({ operation, args }) => {
      const adapter = globalThis.__notakilliteAdapter;
      if (!adapter || typeof adapter[operation] !== 'function') throw new Error('The Notability integration needs an update.');
      return adapter[operation](...args);
    }, { operation, args });
  }
  async state() { return this.call('state'); }
  async recordings(noteId) { return this.call('load', noteId); }
  async show() { await this.connect(); const page = await this.target(); await page.bringToFront(); }
  async capture(noteId, recordingId, filename, { signal, onProgress = () => {} } = {}) {
    const page = await this.target();
    const task = await this.call('startCapture', noteId, recordingId);
    let capture, file;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const result = await this.call('captureStatus', task.id);
        if (result.status === 'error') throw new Error(result.error);
        if (result.status === 'done') { capture = result.capture; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      file = await open(filename, 'wx');
      for (let offset = 0; offset < capture.size; offset += 192 * 1024) {
        signal?.throwIfAborted();
        const base64 = await page.evaluate(({ url, offset, count }) => globalThis.__notakilliteAdapter.readChunk(url, offset, count), { url: capture.url, offset, count: Math.min(192 * 1024, capture.size - offset) });
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length !== Math.min(192 * 1024, capture.size - offset)) throw new Error('The recording transfer was incomplete. Please retry.');
        await file.write(bytes);
        onProgress(Math.min(1, (offset + bytes.length) / capture.size));
      }
      await file.sync();
      return capture;
    } finally {
      await file?.close();
      await this.call('forgetCaptureTask', task.id).catch(() => {});
      if (capture) await this.call('release', capture.url).catch(() => {});
    }
  }
  async manualSignIn() {
    await this.close();
    const executable = await findBrave(this.executable);
    // Launch normal Brave for providers that reject an automation-controlled
    // login. The same permanent profile is used when Connect is pressed later.
    const child = spawn(executable, [`--user-data-dir=${this.profile}`, '--no-first-run', '--disable-background-mode', '--new-window', 'https://notability.com/app'], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  }
  async close() { const context = this.context; this.context = undefined; this.page = undefined; await context?.close(); }
}
