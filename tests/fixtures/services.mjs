/* Native ES module fixture for the live app singleton discovered by adapter.js.
 * Shapes below follow research/NOTABILITY-ADAPTER.md; no account data is used. */
let current;

export function recording({ id = 'r-1', name = 'Lecture', start = 1000, duration = 30_000, mimeType = 'audio/mp4', hash = `hash-${id}` } = {}) {
  const assetHash = { hexString: () => hash };
  return {
    id: () => ({ toString: () => id }),
    name: () => name,
    startTime: () => start,
    endTime: () => start + duration,
    initialDuration: () => duration,
    assetHash: () => assetHash,
    recordingAsset: () => ({ metadata: () => ({ mimeType: () => mimeType }) }),
  };
}

export function configure({ library, result, recordingsByNote = {}, bytes = new Blob(['fixture-audio'], { type: 'application/octet-stream' }) } = {}) {
  const runtime = {
    result: result || {
      status: 'ready',
      sequenceId: 12,
      library: library || { privateWorkspace: { id: 'account-a', notes: [], organizers: [] }, sharedNotes: [], sharedWorkspaces: [] },
    },
    records: new Map(Object.entries(recordingsByNote)),
    bytes,
    calls: { library: 0, open: [], close: [], assets: [] },
    openError: undefined,
    openResult: undefined,
    assetError: undefined,
    afterOpen: undefined,
  };
  const storage = new Map();
  runtime.makeSession = noteId => ({ getModel: () => ({ getRecordingEntities: () => runtime.records.get(noteId) || [] }) });
  runtime.manager = {
    _sessionStorage: storage,
    async openNote(noteId) {
      runtime.calls.open.push(noteId);
      if (runtime.openError) throw runtime.openError;
      if (runtime.openResult !== undefined) return runtime.openResult;
      let session = storage.get(noteId);
      if (!session) { session = runtime.makeSession(noteId); storage.set(noteId, session); }
      await runtime.afterOpen?.(noteId);
      return session;
    },
    async closeNote(noteId) {
      runtime.calls.close.push(noteId);
      // Production close releases the tab's worker subscription, not its cache.
    },
  };
  runtime.persistence = { async getLibrary() { runtime.calls.library++; return runtime.result; } };
  runtime.assets = {
    async getAsset(hash, noteId) {
      runtime.calls.assets.push({ hash, noteId });
      if (runtime.assetError) throw runtime.assetError;
      return runtime.bytes;
    },
  };
  current = runtime;
  return runtime;
}

// Alias intentionally differs from production's current `r`: discovery should
// identify this export by observed method shape, not minified symbol name.
export class ObservedServices {
  static getPersistenceManager() { return current.persistence; }
  static getNoteManager() { return current.manager; }
  static getRecordingAssetManager() { return current.assets; }
}
