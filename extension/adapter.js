/* Runs in Notability's page world. Never reads tokens, cookies, passwords, or note text. */
(() => {
  const version = '0.4.0';
  if (globalThis.__notakilliteAdapter?.version === version) return;
  globalThis.__notakilliteAdapter?.dispose?.();
  globalThis.__notakilliteAdapter?.clear?.();
  const sessions = new Map();
  const blobs = new Map();
  const blobContent = new Map();
  const captures = new Map();
  let captureSequence = 0;
  let services;
  let workspaceId;
  let resolving;
  let libraryStore;

  function preferences() {
    if (!libraryStore) {
      for (const element of [document.getElementById?.('render_root'), document.getElementById?.('root'), document.getElementById?.('app')].filter(Boolean)) {
        const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactContainer$'));
        const root = key && element[key];
        const pending = root ? [root.stateNode?.current || root] : [];
        const visited = new Set();
        while (pending.length && visited.size < 10000) {
          const fiber = pending.pop();
          if (!fiber || visited.has(fiber)) continue;
          visited.add(fiber);
          const store = fiber.memoizedProps?.store || fiber.memoizedProps?.value?.store;
          if (typeof store?.getState === 'function' && store.getState()?.libraryPersisted) { libraryStore = store; break; }
          pending.push(fiber.child, fiber.sibling);
        }
        if (libraryStore) break;
      }
    }
    const state = libraryStore?.getState();
    const savedMode = state?.libraryPersisted?.notesSortMode;
    const legacyMode = state?.notes?.sortOrder;
    const modes = { sortOptionAlphabetical: 'name', sortOptionCreatedDate: 'created', sortOptionRecent: 'edited', sortOptionModifiedDate: 'edited' };
    const mode = ['created', 'edited'].includes(savedMode) ? savedMode : modes[legacyMode] || 'created';
    return { mode, matched: Boolean(savedMode || modes[legacyMode]), language: document.documentElement?.lang || navigator.language || 'en', localNotes: state?.notes?.notes || {} };
  }

  function organize(data) {
    const preference = preferences();
    const notes = new Map();
    const folders = new Map();
    const membership = new Map();
    const workspaces = [];
    const workspaceInputs = [
      ...(data.privateWorkspace ? [{ ...data.privateWorkspace, kind: 'private' }] : []),
      ...(data.sharedNotes?.length ? [{ id: '__shared_with_me__', title: 'Shared with me', kind: 'shared', notes: data.sharedNotes, organizers: [] }] : []),
      ...(data.sharedWorkspaces || []).map(workspace => ({ ...workspace, kind: 'workspace' })),
    ];
    const compareFolders = (a, b) => (Number(a.siblingOrder) || 0) - (Number(b.siblingOrder) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let collator;
    try { collator = new Intl.Collator(preference.language, { sensitivity: 'base', numeric: true }); }
    catch { collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true }); }
    const timestamp = (note, type) => {
      const value = type === 'created' ? note.createdAt ?? 0 : preference.localNotes[note.id]?.localUpdatedAt ?? note.updatedAt ?? note.createdAt ?? 0;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : Date.parse(value) || 0;
    };
    const compareNotes = (a, b) => preference.mode === 'name' ? collator.compare(notes.get(a)?.title || '', notes.get(b)?.title || '') : timestamp(notes.get(b), preference.mode) - timestamp(notes.get(a), preference.mode);
    for (const input of workspaceInputs) {
      if (input.deletedAt) continue;
      const id = String(input.id);
      const workspace = { id, kind: input.kind, title: input.kind === 'private' ? 'My Library' : input.title || 'Shared library', noteIds: [], children: [] };
      const walk = (items, path, ancestors = new Set()) => {
        const nodes = [];
        for (const item of items || []) {
          if (!item?.id || item.deletedAt || ancestors.has(String(item.id))) continue;
          const folderId = String(item.id);
          const key = `${id}/${folderId}`;
          if (folders.has(key)) continue;
          const node = { id: folderId, workspaceId: id, title: item.title || 'Untitled folder', type: item.organizerType || 'Folder', color: /^#[0-9a-f]{6}$/i.test(item.subjectHexColor) ? item.subjectHexColor : undefined, siblingOrder: item.siblingOrder, noteIds: [], children: [], path };
          folders.set(key, node);
          for (const noteId of item.noteIds || []) if (!membership.has(`${id}/${noteId}`)) membership.set(`${id}/${noteId}`, folderId);
          node.children = walk(item.children, [...path, { id: folderId, title: node.title }], new Set([...ancestors, folderId]));
          nodes.push(node);
        }
        return nodes.sort(compareFolders);
      };
      workspace.children = walk(input.organizers, []);
      workspaces.push(workspace);
      for (const note of input.notes || []) {
        if (!note?.id || note.deletedAt) continue;
        const noteId = String(note.id);
        // A shared shortcut to an owned note should not replace its library location.
        if (notes.has(noteId)) continue;
        const requestedFolder = note.folderId ?? note.subjectId ?? membership.get(`${id}/${noteId}`);
        const folder = requestedFolder && folders.get(`${id}/${requestedFolder}`);
        notes.set(noteId, { ...note, id: noteId, workspaceId: id, folderId: folder?.id, path: folder ? [...folder.path, { id: folder.id, title: folder.title }] : [] });
        (folder?.noteIds || workspace.noteIds).push(noteId);
      }
    }
    for (const node of [...workspaces, ...folders.values()]) node.noteIds.sort(compareNotes);
    return { notes: [...notes.keys()].sort(compareNotes).map(id => notes.get(id)), library: { accountId: workspaceId, privateWorkspaceId: data.privateWorkspace?.id ? String(data.privateWorkspace.id) : undefined, sort: { mode: preference.mode, matched: preference.matched }, workspaces } };
  }

  async function discoverServices() {
    if (services) return services;
    if (resolving) return resolving;
    resolving = (async () => {
      const resources = performance.getEntriesByType('resource').map(entry => entry.name);
      resources.push(...Array.from(document.scripts, script => script.src).filter(Boolean));
      const urls = [...new Set(resources)].filter(value => {
        try {
          const url = new URL(value);
          return url.origin === location.origin && /\/app\/assets\/sentry-[\w-]+\.js$/.test(url.pathname);
        } catch { return false; }
      });
      for (const url of urls) {
        const module = await import(url);
        const match = Object.values(module).find(value => typeof value?.getRecordingAssetManager === 'function' && typeof value?.getNoteManager === 'function' && typeof value?.getPersistenceManager === 'function');
        if (match) { services = match; return match; }
      }
      throw new Error('Notability’s web interface is not ready or its integration has changed. Wait for the library, reload the tab, and try again.');
    })();
    try { return await resolving; } finally { resolving = undefined; }
  }

  function forget() {
    sessions.clear();
    captures.clear();
    for (const url of blobs.keys()) URL.revokeObjectURL(url);
    blobs.clear();
    blobContent.clear();
  }

  async function library() {
    const sdk = await discoverServices();
    const result = await sdk.getPersistenceManager().getLibrary();
    if (result?.status !== 'ready' || !result.library) {
      forget();
      throw new Error('Sign in and let Notability finish loading your Cloud library. iCloud-only notes are not available on the web.');
    }
    const data = result.library;
    const accountWorkspace = String(data.privateWorkspace?.id || '');
    if (workspaceId !== accountWorkspace) { forget(); workspaceId = accountWorkspace; }
    return organize(data);
  }

  function recordingsFor(session) {
    const model = session.getModel();
    const records = model.getRecordingEntities();
    return Array.from(records).sort((a, b) => Number(a.startTime()) - Number(b.startTime()) || a.id().toString().localeCompare(b.id().toString())).map(recording => ({
      id: recording.id().toString(),
      name: recording.name() || 'Lecture recording',
      duration: Number(recording.initialDuration()) / 1000,
      available: true,
    }));
  }

  async function state() {
    const { notes, library: organization } = await library();
    const ids = new Set(notes.map(note => String(note.id)));
    for (const [id, cached] of sessions) {
      const current = notes.find(note => String(note.id) === id);
      if (!ids.has(id) || String(current.updatedAt) !== cached.updatedAt) sessions.delete(id);
    }
    return {
      connected: true,
      online: navigator.onLine,
      library: organization,
      notes: notes.map(note => ({ id: note.id, title: note.title || 'Untitled note', hasRecordings: Boolean(note.hasRecordings), createdAt: note.createdAt, updatedAt: note.updatedAt, workspaceId: note.workspaceId, folderId: note.folderId, path: note.path, recordings: sessions.has(note.id) ? recordingsFor(sessions.get(note.id).session) : [] })),
    };
  }

  async function load(noteId) {
    const note = (await library()).notes.find(note => note.id === noteId);
    if (!note) throw new Error('This note is no longer available in the signed-in library.');
    const manager = services.getNoteManager();
    if (typeof manager._sessionStorage?.get !== 'function') throw new Error('Notability changed its note-session interface. The integration needs an update.');
    const borrowed = manager._sessionStorage.get(noteId);
    try {
      // Reopening refreshes a cached model that may have been unsubscribed earlier.
      // A pre-existing session is never closed by this extension.
      const session = await manager.openNote(noteId);
      if (!session || typeof session.getModel !== 'function') throw new Error('Notability could not open this note. Open it in the web app and try again.');
      sessions.set(noteId, { session, updatedAt: String(note.updatedAt) });
      return recordingsFor(session);
    } finally {
      // Worker subscriptions are owned by the tab, not reference-counted. Leave the
      // visible note subscribed; release only the temporary read of another note.
      const visibleId = decodeURIComponent(location.pathname.match(/^\/app\/note\/([^/]+)/)?.[1] || '');
      if (!borrowed && visibleId !== noteId) await manager.closeNote(noteId);
    }
  }

  async function capture(noteId, recordingId) {
    await load(noteId);
    const recordings = Array.from(sessions.get(noteId).session.getModel().getRecordingEntities());
    const recording = recordings.find(item => item.id().toString() === recordingId);
    if (!recording) throw new Error('This recording is no longer attached to the note. Refresh its recordings.');
    const bytes = await services.getRecordingAssetManager().getAsset(recording.assetHash(), noteId);
    if (!(bytes instanceof Blob) && !(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new Error('Notability did not return a readable recording. Wait for it to sync and retry.');
    const type = recording.recordingAsset().metadata()?.mimeType() || 'application/octet-stream';
    const blob = bytes instanceof Blob ? bytes.slice(0, bytes.size, type) : new Blob([bytes], { type });
    if (!blob.size) throw new Error('Notability returned an empty recording. Wait for it to sync and retry.');
    if (blob.size > 2 * 1024 ** 3) throw new Error('Recordings larger than 2 GB are not supported.');
    const url = URL.createObjectURL(blob);
    blobs.set(url, Date.now());
    blobContent.set(url, blob);
    return { url, size: blob.size, mimeType: blob.type || type, name: recording.name() || 'Lecture recording' };
  }

  function release(url) {
    if (blobs.has(url)) { URL.revokeObjectURL(url); blobs.delete(url); blobContent.delete(url); }
  }
  async function readChunk(url, offset, count) {
    const blob = blobContent.get(url);
    if (!blob) throw new Error('The recording is no longer available. Please retry.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > 256 * 1024) throw new Error('Invalid recording chunk.');
    const bytes = new Uint8Array(await blob.slice(offset, offset + count).arrayBuffer());
    let data = ''; for (let i = 0; i < bytes.length; i += 8192) data += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(data);
  }

  async function startCapture(noteId, recordingId) {
    // Establish account ownership before registering a task: first discovery
    // clears the previous account's cached sessions and pending downloads.
    await library();
    const id = `capture-${Date.now()}-${++captureSequence}`;
    const task = { status: 'pending' };
    captures.set(id, task);
    void capture(noteId, recordingId).then(result => {
      if (!captures.has(id)) { release(result.url); return; }
      task.status = 'done'; task.capture = result;
    }, error => { task.status = 'error'; task.error = error.message || 'Could not download this recording.'; });
    return { id };
  }
  function captureStatus(id) {
    const task = captures.get(id);
    if (!task) return { status: 'error', error: 'Notability reloaded during the recording download. Please try exporting again.' };
    return task;
  }

  const cleanupTimer = setInterval(() => {
    for (const [url, created] of blobs) if (Date.now() - created > 60 * 60 * 1000) release(url);
  }, 60000);
  globalThis.__notakilliteAdapter = { version, state, load, capture, startCapture, captureStatus, readChunk, forgetCaptureTask(id) { captures.delete(id); }, release, clear: forget, dispose() { forget(); clearInterval(cleanupTimer); } };
})();
