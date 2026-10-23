import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { open, access } from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION, EXTENSION_ID, PROTOCOL_VERSION, ConnectionError } from './connector-info.mjs';
import { regularProfiles, openRegularBrave, findRegularBrave, connectorInstallation } from './browser-profiles.mjs';

const error = (code, message) => new ConnectionError(code, message);
export class NativeConnector extends EventEmitter {
  constructor({ store, onDisconnect = () => {}, launch = openRegularBrave, profileRoot, timeout = 45000 } = {}) {
    super(); Object.assign(this, { store, onDisconnect, launch, profileRoot, timeout }); this.pending = new Map(); this.sequence = 0; this.closed = false;
  }
  async init() {
    this.profileChoices = await regularProfiles(this.profileRoot);
    this.binding = this.store.get('braveBinding', null);
    if (!this.binding) {
      const chosen = this.profileChoices.profiles.find(profile => profile.lastUsed) || this.profileChoices.profiles[0];
      this.binding = { extensionId: EXTENSION_ID, profileDirectory: chosen.directory, profileLabel: chosen.label, userDataRoot: this.profileChoices.root, profileId: null, verifiedAccountId: null };
      this.store.set('braveBinding', this.binding);
    }
    try { this.binding.executable = await findRegularBrave(this.binding.executable); this.store.set('braveBinding', this.binding); } catch { /* Local file processing is available without Brave. */ }
    return this;
  }
  get context() { return this.connectionId ? true : undefined; }
  info() { return { ...this.binding, extensionId: EXTENSION_ID, connected: !!this.connectionId, profiles: this.profileChoices?.profiles || [], connectorPath: path.join(path.dirname(this.store.directory || '.'), 'connector', 'extension'), protocol: PROTOCOL_VERSION }; }
  async configure(directory) {
    this.profileChoices = await regularProfiles(this.profileRoot);
    const profile = this.profileChoices.profiles.find(profile => profile.directory === directory);
    if (!profile) throw error('PROFILE_UNAVAILABLE', 'Choose a Brave profile from the list.');
    if (directory !== this.binding.profileDirectory) {
      this.detach(this.connectionId);
      this.binding = { ...this.binding, profileDirectory: directory, profileLabel: profile.label, profileId: null, verifiedAccountId: null };
      this.store.set('braveBinding', this.binding); this.store.set('bravePairing', null);
    }
    return this.info();
  }
  async accept(connectionId, hello) {
    if (this.closed || hello.protocol !== PROTOCOL_VERSION || !/^[\da-f-]{36}$/i.test(hello.profileId || '') || hello.extensionId !== EXTENSION_ID) return { accepted: false, code: 'PROTOCOL_MISMATCH', message: 'Update the Notakillite Brave connector.' };
    const pairing = this.store.get('bravePairing', null);
    if (!this.binding.profileId) {
      if (!pairing || pairing.expires < Date.now() || hello.pairingNonce !== pairing.nonce || pairing.profileDirectory !== this.binding.profileDirectory) return { accepted: false, code: 'PAIRING_REQUIRED', message: 'In Notakillite, choose Connect to pair this Brave profile once.' };
      this.binding.profileId = hello.profileId; this.binding.connectorVersion = hello.version; this.store.set('braveBinding', this.binding); this.store.set('bravePairing', null);
    } else if (hello.profileId !== this.binding.profileId) return { accepted: false, code: 'PROFILE_MISMATCH', message: 'Open the Brave profile paired with Notakillite, or choose a different profile in Settings.' };
    if (this.connectionId && this.connectionId !== connectionId) this.detach(this.connectionId);
    this.connectionId = connectionId; this.emit('attached');
    return { accepted: true, version: APP_VERSION, profileLabel: this.binding.profileLabel };
  }
  detach(connectionId) {
    if (!connectionId || this.connectionId !== connectionId) return;
    this.connectionId = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.cleanup?.(); request.reject(error('CONNECTOR_UNAVAILABLE', 'The Brave connector disconnected. Your browser sign-in is retained. Reconnect to continue.')); }
    this.pending.clear(); this.onDisconnect();
  }
  receive(connectionId, message) {
    if (connectionId !== this.connectionId || typeof message.id !== 'string') return;
    const request = this.pending.get(message.id); if (!request) return;
    if (message.type === 'responseChunk') {
      const bytes = typeof message.data === 'string' && message.data.length <= 256000 ? Buffer.from(message.data, 'base64') : null;
      if (!bytes || message.index !== request.chunks.length || !Number.isInteger(message.total) || message.total < 1 || message.total > 256 || request.total && request.total !== message.total || request.bytes + bytes.length > 32 * 1024 ** 2) {
        this.finish(message.id, error('INVALID_RESPONSE', 'The connector returned an invalid library transfer. Reconnect and retry.')); return;
      }
      request.total = message.total; request.chunks.push(bytes); request.bytes += bytes.length;
      if (request.chunks.length === message.total) {
        try { const response = JSON.parse(Buffer.concat(request.chunks).toString('utf8')); if (response.id !== message.id || response.type !== 'response') throw new Error('Invalid assembled response.'); this.receive(connectionId, response); }
        catch { this.finish(message.id, error('INVALID_RESPONSE', 'The connector response could not be read.')); }
      }
      return;
    }
    if (message.type !== 'response') return;
    this.finish(message.id, message.error ? error(message.error.code || 'SITE_UNAVAILABLE', message.error.message || 'Notability could not complete this action.') : null, message.result);
  }
  finish(id, failure, result) { const request = this.pending.get(id); if (!request) return; this.pending.delete(id); clearTimeout(request.timer); request.cleanup?.(); failure ? request.reject(failure) : request.resolve(result); }
  request(operation, args = [], timeout = this.timeout, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.connectionId) return Promise.reject(error('CONNECTOR_UNAVAILABLE', 'Open your paired Brave profile and enable the Notakillite connector. Your sign-in has not been reset.'));
    const id = `${Date.now().toString(36)}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(id, error('SITE_TIMEOUT', 'Notability did not respond in time. Keep its tab open and retry.')), timeout);
      const onAbort = () => this.finish(id, signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, chunks: [], bytes: 0, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      this.emit('command', { connectionId: this.connectionId, type: 'request', id, operation, args });
    });
  }
  async connect({ interactive = false } = {}) {
    if (this.connectionId) return;
    if (!this.binding.profileId && !interactive) throw error('CONNECTOR_SETUP_REQUIRED', 'Connect your usual Brave profile once. Future launches reuse its saved Notability session.');
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const installation = await connectorInstallation(this.binding);
      if (!this.connectionId && ['missing', 'disabled'].includes(installation)) {
        throw error('CONNECTOR_SETUP_REQUIRED', installation === 'disabled'
          ? 'Enable Notakillite Brave Connector in brave://extensions in the selected profile, then press Connect. Your Notability sign-in is retained.'
          : 'The connector is not installed in this Brave profile. Type brave://extensions in Brave’s address bar, enable Developer mode, choose Load unpacked, and select the connector folder shown in Set up Brave. Then press Connect.');
      }
      if (this.connectionId) return;
      let suffix = '';
      if (!this.binding.profileId) {
        const pairing = { nonce: randomBytes(24).toString('hex'), expires: Date.now() + 15 * 60000, profileDirectory: this.binding.profileDirectory };
        this.store.set('bravePairing', pairing); suffix = `#pair=${pairing.nonce}`;
      }
      await this.launch(this.binding, `chrome-extension://${EXTENSION_ID}/connect.html${suffix}`);
      if (this.connectionId) return;
      await new Promise((resolve, reject) => {
        const onAttached = () => { clearTimeout(timer); this.cancelConnect = undefined; resolve(); };
        const timer = setTimeout(() => { this.off('attached', onAttached); this.cancelConnect = undefined; reject(error('CONNECTOR_UNAVAILABLE', 'The Brave connector is not available yet. Install or enable it using Set up Brave, then connect again. Your saved sign-in is retained.')); }, 16000);
        this.cancelConnect = () => { clearTimeout(timer); this.off('attached', onAttached); reject(error('CONNECTOR_UNAVAILABLE', 'The app is closing. Your saved profile is retained.')); };
        this.once('attached', onAttached);
      });
    })();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }
  async state() { return this.request('state'); }
  async recordings(noteId) { return this.request('load', [noteId]); }
  async show() { await this.connect({ interactive: true }); return this.request('show'); }
  async manualSignIn() { return this.show(); }
  async openExtensions() { await this.launch(this.binding, 'brave://extensions/'); }
  async capture(noteId, recordingId, filename, { signal, onProgress = () => {} } = {}) {
    const task = await this.request('startCapture', [noteId, recordingId]);
    let capture, file;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const status = await this.request('captureStatus', [task.id], this.timeout, signal);
        if (status.status === 'error') throw error('CAPTURE_FAILED', status.error);
        if (status.status === 'done') { capture = status.capture; break; }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (!Number.isSafeInteger(capture.size) || capture.size < 1 || capture.size > 2 * 1024 ** 3) throw error('INVALID_CAPTURE', 'The recording has an unsupported size.');
      file = await open(filename, 'wx');
      for (let offset = 0; offset < capture.size; offset += 192 * 1024) {
        signal?.throwIfAborted(); const count = Math.min(192 * 1024, capture.size - offset);
        const value = await this.request('readChunk', [capture.url, offset, count], this.timeout, signal);
        const bytes = typeof value === 'string' && value.length <= 270000 ? Buffer.from(value, 'base64') : Buffer.alloc(0);
        if (bytes.length !== count) throw error('TRANSFER_INCOMPLETE', 'The recording transfer was incomplete. Please retry.');
        await file.writeFile(bytes); onProgress((offset + count) / capture.size);
      }
      await file.sync(); return capture;
    } finally {
      await file?.close();
      await this.request('forgetCaptureTask', [task.id], 3000).catch(() => {});
      if (capture) await this.request('release', [capture.url], 3000).catch(() => {});
    }
  }
  rememberAccount(id) { if (id && this.binding.verifiedAccountId !== id) { this.binding.verifiedAccountId = id; this.store.set('braveBinding', this.binding); } }
  async close() { this.closed = true; this.cancelConnect?.(); this.detach(this.connectionId); }
}
