import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as fixture from './fixtures/services.mjs';

const source = await readFile(new URL('../core/notability-adapter.js', import.meta.url), 'utf8');
const moduleUrl = 'https://notability.com/app/assets/sentry-zBhOYSzV.js';
const note = (id, extras = {}) => ({ id, title: `Note ${id}`, hasRecordings: true, createdAt: 1000, updatedAt: 2000, ...extras });
const library = (notes = [], extras = {}) => ({ privateWorkspace: { id: 'account-a', notes, organizers: [] }, sharedNotes: [], sharedWorkspaces: [], ...extras });
const plain = value => JSON.parse(JSON.stringify(value));

function setup({ online = true, pathname = '/app/notes', resources = [moduleUrl], scripts = [], preferences, ...configuration } = {}) {
  const runtime = fixture.configure(configuration);
  const objectUrls = new Map();
  const revoked = [];
  const imported = [];
  const timers = [];
  let nextUrl = 0;
  class BrowserURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:https://notability.com/test-${++nextUrl}`;
      objectUrls.set(url, blob);
      return url;
    }
    static revokeObjectURL(url) { revoked.push(url); objectUrls.delete(url); }
  }
  const context = {
    Blob,
    URL: BrowserURL,
    location: { origin: 'https://notability.com', pathname },
    navigator: { onLine: online },
    performance: { getEntriesByType: () => resources.map(name => ({ name })) },
    document: {
      scripts: scripts.map(src => ({ src })),
      documentElement: { lang: 'en' },
      getElementById: () => preferences ? { __reactContainer$fixture: { memoizedProps: { store: { getState: () => preferences } } } } : null,
    },
    setInterval(callback, milliseconds) { timers.push({ callback, milliseconds }); return timers.length; },
  };
  vm.runInNewContext(source, context, {
    filename: 'extension/adapter.js',
    importModuleDynamically: async specifier => { imported.push(specifier); return fixture; },
  });
  return { runtime, adapter: context.__notakilliteAdapter, context, objectUrls, revoked, imported, timers };
}

test('discovers only the current same-origin module and lists all library notes without opening them', async () => {
  const privateNotes = [note('private'), note('duplicate'), note('plain', { hasRecordings: false }), note('deleted', { deletedAt: 4000 })];
  const { adapter, runtime, imported } = setup({
    resources: ['https://elsewhere.test/app/assets/sentry-evil.js', 'https://notability.com/app/assets/other.js', moduleUrl],
    scripts: [moduleUrl],
    library: library(privateNotes, {
      sharedNotes: [note('shared'), note('duplicate', { title: 'Duplicate from shared' })],
      sharedWorkspaces: [{ id: 'team', title: 'Study group', notes: [note('team'), note('team-deleted', { deletedAt: 1 })], organizers: [] }],
    }),
  });
  const state = await adapter.state();
  assert.equal(state.connected, true);
  assert.deepEqual(plain(state.notes).map(item => item.id).sort(), ['duplicate', 'plain', 'private', 'shared', 'team']);
  assert.equal(state.notes.find(item => item.id === 'duplicate').title, 'Note duplicate');
  assert.equal(state.notes.find(item => item.id === 'plain').hasRecordings, false);
  assert.ok(state.notes.every(item => item.recordings.length === 0));
  assert.deepEqual(runtime.calls.open, []);
  assert.deepEqual(runtime.calls.assets, []);
  assert.deepEqual(imported, [moduleUrl]);
});

test('concurrent state reads reuse one discovery and ready cached notes remain readable offline', async () => {
  const { adapter, imported } = setup({ online: false, library: library([note('cached')]) });
  const [first, second] = await Promise.all([adapter.state(), adapter.state()]);
  assert.equal(first.online, false);
  assert.equal(second.notes[0].id, 'cached');
  assert.deepEqual(imported, [moduleUrl]);
});

test('loads recordings lazily, refreshes existing sessions, and never closes a borrowed app session', async () => {
  const later = fixture.recording({ id: 'later', start: 4000, duration: 2000 });
  const earlier = fixture.recording({ id: 'earlier', start: 1000, duration: 5000 });
  const { adapter, runtime } = setup({ library: library([note('lecture')]), recordingsByNote: { lecture: [later, earlier] } });
  runtime.manager._sessionStorage.set('lecture', runtime.makeSession('lecture'));
  await adapter.state();
  assert.deepEqual(runtime.calls.open, []);
  assert.deepEqual(plain(await adapter.load('lecture')), [
    { id: 'earlier', name: 'Lecture', duration: 5, available: true },
    { id: 'later', name: 'Lecture', duration: 2, available: true },
  ]);
  await adapter.load('lecture');
  assert.deepEqual(runtime.calls.open, ['lecture', 'lecture']);
  assert.deepEqual(runtime.calls.close, []);
  assert.equal((await adapter.state()).notes[0].recordings.length, 2);
});

test('closes a temporary note read but preserves a newly visible note subscription', async () => {
  const { adapter, runtime, context } = setup({ library: library([note('temporary'), note('visible')]) });
  await adapter.load('temporary');
  assert.deepEqual(runtime.calls.close, ['temporary']);
  context.location.pathname = '/app/note/visible';
  await adapter.load('visible');
  assert.deepEqual(runtime.calls.close, ['temporary']);
});

test('does not close a temporary note when user navigates to it while the read is pending', async () => {
  const { adapter, runtime, context } = setup({ library: library([note('arrived')]) });
  runtime.afterOpen = () => { context.location.pathname = '/app/note/arrived'; };
  await adapter.load('arrived');
  assert.deepEqual(runtime.calls.close, []);
});

test('captures exact recording bytes with the note-scoped asset reader and recorded MIME type', async () => {
  const entry = fixture.recording({ id: 'lecture-1', name: 'Cell biology', mimeType: 'audio/mp4' });
  const original = new Blob([new Uint8Array([0, 1, 255, 7])], { type: 'application/octet-stream' });
  const { adapter, runtime, objectUrls, revoked } = setup({ library: library([note('n-1')]), recordingsByNote: { 'n-1': [entry] }, bytes: original });
  const capture = await adapter.capture('n-1', 'lecture-1');
  assert.equal(runtime.calls.assets.length, 1);
  assert.equal(runtime.calls.assets[0].hash, entry.assetHash());
  assert.equal(runtime.calls.assets[0].noteId, 'n-1');
  assert.equal(capture.mimeType, 'audio/mp4');
  assert.equal(capture.name, 'Cell biology');
  assert.equal(capture.size, original.size);
  const captured = objectUrls.get(capture.url);
  assert.equal(captured.type, 'audio/mp4');
  assert.deepEqual(new Uint8Array(await captured.arrayBuffer()), new Uint8Array(await original.arrayBuffer()));
  adapter.release(capture.url);
  assert.equal(objectUrls.has(capture.url), false);
  adapter.release(capture.url);
  assert.deepEqual(revoked, [capture.url]);
});

test('library updates invalidate stale recording lists and removed recordings cannot be captured', async () => {
  const { adapter, runtime } = setup({ library: library([note('changing')]), recordingsByNote: { changing: [fixture.recording({ id: 'old' })] } });
  await adapter.load('changing');
  assert.equal((await adapter.state()).notes[0].recordings[0].id, 'old');
  runtime.result.library.privateWorkspace.notes[0].updatedAt = 3000;
  runtime.records.set('changing', [fixture.recording({ id: 'new' })]);
  assert.equal((await adapter.state()).notes[0].recordings.length, 0);
  await assert.rejects(adapter.capture('changing', 'old'), /no longer attached/);
  assert.deepEqual(runtime.calls.assets, []);
  assert.equal((await adapter.load('changing'))[0].id, 'new');
});

test('switching accounts clears cached recording lists and object URLs', async () => {
  const entry = fixture.recording({ id: 'private-audio' });
  const { adapter, runtime, revoked } = setup({ library: library([note('account-note')]), recordingsByNote: { 'account-note': [entry] } });
  const capture = await adapter.capture('account-note', 'private-audio');
  runtime.result.library = library([note('new-note')], { privateWorkspace: { id: 'account-b', notes: [note('new-note')], organizers: [] } });
  const nextState = await adapter.state();
  assert.deepEqual(plain(nextState.notes).map(item => item.id), ['new-note']);
  assert.equal(nextState.notes[0].recordings.length, 0);
  assert.deepEqual(revoked, [capture.url]);
  await assert.rejects(adapter.capture('account-note', 'private-audio'), /no longer available/);
  assert.equal(runtime.calls.assets.length, 1);
});

test('an unavailable account clears cached recordings and refuses both listing and capture', async () => {
  const entry = fixture.recording();
  const { adapter, runtime, revoked } = setup({ library: library([note('lecture')]), recordingsByNote: { lecture: [entry] } });
  const capture = await adapter.capture('lecture', 'r-1');
  const ready = runtime.result;
  runtime.result = { status: 'unavailable', reason: 'invalid-credentials' };
  await assert.rejects(adapter.state(), /Sign in/);
  await assert.rejects(adapter.capture('lecture', 'r-1'), /Sign in/);
  assert.deepEqual(revoked, [capture.url]);
  runtime.result = ready;
  assert.equal((await adapter.state()).notes[0].recordings.length, 0);
});

test('a note removed from the live account is never opened or fetched', async () => {
  const { adapter, runtime } = setup({ library: library([note('allowed')]) });
  await assert.rejects(adapter.load('missing'), /no longer available/);
  await assert.rejects(adapter.capture('missing', 'any'), /no longer available/);
  assert.deepEqual(runtime.calls.open, []);
  assert.deepEqual(runtime.calls.assets, []);
});

test('changed session schemas fail explicitly before accessing notes', async () => {
  const { adapter, runtime } = setup({ library: library([note('lecture')]) });
  runtime.manager._sessionStorage = {};
  await assert.rejects(adapter.load('lecture'), /note-session interface.*update/);
  assert.deepEqual(runtime.calls.open, []);
});

test('an invalid opened session is rejected and its temporary subscription is released', async () => {
  const { adapter, runtime } = setup({ library: library([note('lecture')]) });
  runtime.openResult = {};
  await assert.rejects(adapter.load('lecture'), /could not open this note/);
  assert.deepEqual(runtime.calls.close, ['lecture']);
});

test('missing application module fails with integration guidance instead of inventing a connection', async () => {
  const { adapter, runtime } = setup({ resources: [], scripts: [], library: library([note('lecture')]) });
  await assert.rejects(adapter.state(), /interface is not ready or its integration has changed/);
  assert.equal(runtime.calls.library, 0);
});

test('rejects missing or empty audio bytes before creating a download URL', async () => {
  const entry = fixture.recording();
  const { adapter, runtime, objectUrls } = setup({ library: library([note('lecture')]), recordingsByNote: { lecture: [entry] } });
  for (const bytes of [undefined, null, new Blob([])]) {
    runtime.bytes = bytes;
    await assert.rejects(adapter.capture('lecture', 'r-1'), /empty|missing|invalid|recording|audio/i);
    assert.equal(objectUrls.size, 0);
  }
});

test('recording downloads return a pollable task while the audio is still loading', async () => {
  const { adapter, runtime, objectUrls } = setup({ library: library([note('lecture')]), recordingsByNote: { lecture: [fixture.recording()] } });
  let complete;
  runtime.assets.getAsset = () => new Promise(resolve => { complete = resolve; });
  const task = await adapter.startCapture('lecture', 'r-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.captureStatus(task.id).status, 'pending');
  complete(new Blob(['lecture bytes']));
  await new Promise(resolve => setImmediate(resolve));
  const result = adapter.captureStatus(task.id);
  assert.equal(result.status, 'done');
  assert.equal(await objectUrls.get(result.capture.url).text(), 'lecture bytes');
  adapter.forgetCaptureTask(task.id);
  assert.equal(adapter.captureStatus(task.id).status, 'error');
  adapter.release(result.capture.url);
  assert.equal(objectUrls.size, 0);
});

test('clearing a pending recording download releases its eventual Blob', async () => {
  const { adapter, runtime, objectUrls, revoked } = setup({ library: library([note('lecture')]), recordingsByNote: { lecture: [fixture.recording()] } });
  let complete;
  runtime.assets.getAsset = () => new Promise(resolve => { complete = resolve; });
  const task = await adapter.startCapture('lecture', 'r-1');
  await new Promise(resolve => setImmediate(resolve));
  adapter.clear();
  complete(new Blob(['lecture bytes']));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.captureStatus(task.id).status, 'error');
  assert.equal(objectUrls.size, 0);
  assert.equal(revoked.length, 1);
});

test('mirrors nested dividers, subjects, empty folders and saved sibling order', async () => {
  const data = library([
    note('early', { folderId: 'subject', createdAt: 10 }),
    note('new', { folderId: 'subject', createdAt: 30, hasRecordings: false }),
    note('membership', { createdAt: 20 }),
    note('unfiled'),
    note('orphan', { folderId: 'removed-folder' }),
  ]);
  data.privateWorkspace.organizers = [
    { id: 'divider', title: 'Level', organizerType: 'Divider', siblingOrder: 3, children: [
      { id: 'subject', title: 'Lectures', organizerType: 'Subject', siblingOrder: 2, subjectHexColor: '#FF8D00', noteIds: ['early', 'new', 'membership'], children: [] },
      { id: 'empty', title: 'Empty', organizerType: 'Folder', siblingOrder: -1, children: [] },
    ] },
    { id: 'first', title: 'First', organizerType: 'Folder', siblingOrder: -4, children: [] },
    { id: 'deleted-folder', title: 'Deleted', deletedAt: 1, children: [] },
  ];
  const { adapter, runtime } = setup({ library: data, preferences: { libraryPersisted: { notesSortMode: 'created' } } });
  const state = await adapter.state();
  const workspace = state.library.workspaces[0];
  assert.deepEqual(plain(workspace.children).map(folder => folder.id), ['first', 'divider']);
  assert.deepEqual(plain(workspace.children[1].children).map(folder => folder.id), ['empty', 'subject']);
  const subject = workspace.children[1].children[1];
  assert.equal(subject.type, 'Subject');
  assert.equal(subject.color, '#FF8D00');
  assert.deepEqual(plain(subject.noteIds), ['new', 'membership', 'early']);
  assert.deepEqual(plain(workspace.noteIds), ['unfiled', 'orphan']);
  assert.deepEqual(plain(state.notes.find(note => note.id === 'early').path), [{ id: 'divider', title: 'Level' }, { id: 'subject', title: 'Lectures' }]);
  assert.equal(state.notes.find(note => note.id === 'new').hasRecordings, false);
  assert.equal(state.library.sort.matched, true);
  assert.deepEqual(runtime.calls.open, []);
});

test('follows live Notability sort changes, numeric alphabetical comparison, and local edits', async () => {
  const preferences = { libraryPersisted: { notesSortMode: 'created' }, notes: { notes: { old: { localUpdatedAt: 999 } } } };
  const { adapter } = setup({ preferences, library: library([
    note('old', { title: 'Lecture 2', createdAt: 1, updatedAt: 3 }),
    note('new', { title: 'Lecture 10', createdAt: 3, updatedAt: 5 }),
    note('middle', { title: 'lecture 3', createdAt: 2, updatedAt: 7 }),
  ]) });
  assert.deepEqual(plain((await adapter.state()).library.workspaces[0].noteIds), ['new', 'middle', 'old']);
  preferences.libraryPersisted.notesSortMode = 'edited';
  assert.deepEqual(plain((await adapter.state()).library.workspaces[0].noteIds), ['old', 'middle', 'new']);
  delete preferences.libraryPersisted.notesSortMode;
  preferences.notes.sortOrder = 'sortOptionAlphabetical';
  assert.deepEqual(plain((await adapter.state()).library.workspaces[0].noteIds), ['old', 'middle', 'new']);
  assert.equal((await adapter.state()).library.sort.mode, 'name');
});

test('keeps shared libraries separate and folder identities scoped to their workspace', async () => {
  const data = library([note('mine', { folderId: 'folder' })]);
  data.privateWorkspace.organizers = [{ id: 'folder', title: 'Private', children: [], noteIds: ['mine'] }];
  data.sharedNotes = [note('mine'), note('shared')];
  data.sharedWorkspaces = [{ id: 'team', title: 'Team', notes: [note('team-note', { folderId: 'folder' })], organizers: [{ id: 'folder', title: 'Team folder', children: [], noteIds: ['team-note'] }] }];
  const { adapter } = setup({ library: data });
  const state = await adapter.state();
  assert.equal(state.notes.length, 3);
  assert.equal(state.library.workspaces.length, 3);
  assert.deepEqual(plain(state.library.workspaces[0].children[0].noteIds), ['mine']);
  assert.deepEqual(plain(state.library.workspaces[1].noteIds), ['shared']);
  assert.deepEqual(plain(state.library.workspaces[2].children[0].noteIds), ['team-note']);
  assert.equal(state.notes.find(note => note.id === 'mine').workspaceId, 'account-a');
});

test('reports default sort when Notability preferences cannot be read and handles ISO dates', async () => {
  const { adapter } = setup({ library: library([
    note('a', { createdAt: '2026-01-01T00:00:00Z' }),
    note('b', { createdAt: '2026-02-01T00:00:00Z' }),
    note('missing', { createdAt: undefined }),
  ]) });
  const state = await adapter.state();
  assert.deepEqual(plain(state.library.workspaces[0].noteIds), ['b', 'a', 'missing']);
  assert.deepEqual(plain(state.library.sort), { mode: 'created', matched: false });
});
