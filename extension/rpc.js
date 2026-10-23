/* Addressed worker communication. Multiple app windows must not compete to reply. */
(() => {
  if (globalThis.NotakilliteWorkerClient) return;
  class WorkerClient {
    constructor({ name = 'notakillite-ui', timeout = 30000 } = {}) {
      this.name = name;
      this.timeout = timeout;
      this.pending = new Map();
      this.listeners = new Set();
      this.sequence = 0;
      this.closed = false;
      this.prefix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
    connect() {
      if (this.closed) throw new Error('This app window is closed.');
      if (this.port) return this.port;
      const port = chrome.runtime.connect({ name: this.name });
      this.port = port;
      port.onMessage.addListener(packet => {
        if (packet.type === 'STATE_UPDATED') { for (const listener of this.listeners) listener(packet); return; }
        const request = this.pending.get(packet.id);
        if (!request || request.port !== port) return;
        this.pending.delete(packet.id);
        clearTimeout(request.timer);
        if (packet.result === undefined || packet.result === null) request.reject(this.interrupted());
        else request.resolve(packet.result);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (this.port === port) this.port = undefined;
        for (const [id, request] of this.pending) {
          if (request.port !== port) continue;
          this.pending.delete(id);
          clearTimeout(request.timer);
          request.reject(this.interrupted());
        }
      });
      return port;
    }
    interrupted() {
      const error = new Error('The app connection was interrupted. Reconnecting…');
      error.transport = true;
      return error;
    }
    async request(message) {
      const id = `${this.prefix}-${++this.sequence}`;
      const command = message.type === 'EXPORT_AUDIO' ? { ...message, operationId: message.operationId || id } : message;
      const retryable = ['GET_STATE', 'REFRESH', 'LOAD_RECORDINGS', 'EXPORT_AUDIO', 'PING'].includes(message.type);
      for (let attempt = 0; ; attempt++) {
        try { return await this.send(id, command); }
        catch (error) {
          if (!error.transport || !retryable || attempt >= 1 || this.closed) throw error;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    }
    send(id, message) {
      return new Promise((resolve, reject) => {
        let port;
        try { port = this.connect(); }
        catch { reject(this.interrupted()); return; }
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(this.interrupted());
        }, message.type === 'LOAD_RECORDINGS' ? 90000 : this.timeout);
        this.pending.set(id, { resolve, reject, timer, port });
        try { port.postMessage({ id, message }); }
        catch {
          clearTimeout(timer);
          this.pending.delete(id);
          this.port = undefined;
          reject(this.interrupted());
        }
      });
    }
    dispose() {
      this.closed = true;
      const port = this.port;
      this.port = undefined;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.interrupted()); }
      this.pending.clear();
      port?.disconnect();
    }
  }
  globalThis.NotakilliteWorkerClient = WorkerClient;
})();
