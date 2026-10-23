import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Read-only comparison: never changes Notability's folders, sort preferences or notes.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const context = browser.contexts()[0];
  const app = context.pages().find(page => page.url().endsWith('/popup.html'));
  const source = context.pages().find(page => page.url().startsWith('https://notability.com/app'));
  if (!app || !source) throw new Error('Open Notakillite and its signed-in Notability library.');
  const actual = await app.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  assert.equal(actual.connected, true, actual.error);
  assert.equal(actual.busy, false, 'Wait for the active audio export.');
  const expected = await source.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/app\/assets\/sentry-[\w-]+\.js$/.test(new URL(url).pathname));
    const module = await import(url);
    const service = Object.values(module).find(value => typeof value?.getPersistenceManager === 'function' && typeof value?.getNoteManager === 'function');
    const result = await service.getPersistenceManager().getLibrary();
    return result.library;
  });
  let folders = 0;
  const actualNotes = new Map(actual.notes.map(note => [note.id, note]));
  const rawNotes = new Map([...expected.privateWorkspace.notes, ...expected.sharedNotes, ...expected.sharedWorkspaces.flatMap(workspace => workspace.notes)].filter(note => !note.deletedAt).map(note => [note.id, note]));
  assert.equal(actual.notes.length, rawNotes.size);
  const compareFolders = (a, b) => (a.siblingOrder || 0) - (b.siblingOrder || 0) || (a.id < b.id ? -1 : 1);
  function verifyTree(original, mirrored, workspaceId) {
    const sorted = original.filter(folder => !folder.deletedAt).toSorted(compareFolders);
    assert.deepEqual(mirrored.map(folder => folder.id), sorted.map(folder => folder.id), 'Folder positions must match Notability.');
    for (let i = 0; i < sorted.length; i++) {
      const before = sorted[i];
      const after = mirrored[i];
      folders++;
      assert.equal(after.title, before.title);
      assert.equal(after.type, before.organizerType);
      const ids = (before.noteIds || []).filter(id => rawNotes.has(id));
      assert.deepEqual([...after.noteIds].sort(), [...ids].sort(), 'Every note must stay in its original folder.');
      const mode = actual.library.sort.mode;
      if (['created', 'edited'].includes(mode)) {
        const sortedIds = [...ids].sort((a, b) => Number(rawNotes.get(b)[mode === 'created' ? 'createdAt' : 'updatedAt'] || 0) - Number(rawNotes.get(a)[mode === 'created' ? 'createdAt' : 'updatedAt'] || 0));
        assert.deepEqual(after.noteIds, sortedIds, 'Note ordering must follow the saved Notability setting.');
      }
      for (const id of after.noteIds) {
        assert.equal(actualNotes.get(id).folderId, before.id);
        assert.equal(actualNotes.get(id).workspaceId, workspaceId);
      }
      verifyTree(before.children || [], after.children, workspaceId);
    }
  }
  for (const workspace of [expected.privateWorkspace, ...expected.sharedWorkspaces]) {
    verifyTree(workspace.organizers || [], actual.library.workspaces.find(item => item.id === workspace.id).children, workspace.id);
  }
  console.log(JSON.stringify({ connected: true, allNotes: actual.notes.length, audioNotes: actual.notes.filter(note => note.hasRecordings).length, folders, exactFolderPlacement: 'passed', siblingOrder: 'passed', sort: actual.library.sort, noteOrder: 'passed' }, null, 2));
} finally { await browser.close(); }
