import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = process.cwd();
const data = {
  privateWorkspace: { id: 'private', title: 'Private', notes: [
    { id: 'early', title: 'Early lecture', folderId: 'lectures', createdAt: 1, updatedAt: 50, hasRecordings: true },
    { id: 'plain', title: 'Plain handout', folderId: 'lectures', createdAt: 3, updatedAt: 10, hasRecordings: false },
    { id: 'latest', title: 'Latest lecture', folderId: 'lectures', createdAt: 5, updatedAt: 20, hasRecordings: true },
    { id: 'unfiled', title: 'Unfiled note', createdAt: 4, hasRecordings: false },
    { id: 'arabic', title: 'ملاحظة المحاضرة', folderId: 'arabic-folder', createdAt: 2, hasRecordings: true },
  ], organizers: [
    { id: 'parent', title: 'Level 2', organizerType: 'Divider', siblingOrder: 2, children: [
      { id: 'lectures', title: 'Lectures', organizerType: 'Subject', siblingOrder: 1, noteIds: ['early', 'plain', 'latest'], children: [] },
      { id: 'empty', title: 'Empty folder', organizerType: 'Folder', siblingOrder: -1, noteIds: [], children: [] },
      { id: 'arabic-folder', title: 'مجلد', organizerType: 'Folder', siblingOrder: 2, noteIds: ['arabic'], children: [] },
    ] },
    { id: 'top', title: 'Top folder', organizerType: 'Folder', siblingOrder: 0, noteIds: [], children: [] },
  ] }, sharedNotes: [], sharedWorkspaces: [{ id: 'team', title: 'Study group', notes: [], organizers: [] }],
};
const module = `
  globalThis.fixtureLibrary = ${JSON.stringify(data)};
  globalThis.fixtureSort = 'created';
  const element = document.getElementById('render_root');
  element.__reactContainer$fixture = {memoizedProps:{store:{getState:()=>({libraryPersisted:{notesSortMode:globalThis.fixtureSort}})}}};
  export class Services {
    static getPersistenceManager(){return{getLibrary:async()=>({status:'ready',library:globalThis.fixtureLibrary})}}
    static getNoteManager(){throw new Error('Browsing folders must not open notes')}
    static getRecordingAssetManager(){throw new Error('Browsing folders must not download audio')}
  }
`;
const extension = path.join(root, 'extension');
const context = await chromium.launchPersistentContext(path.join(root, '.local', 'browser-library-qa'), {
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true,
  viewport: { width: 480, height: 850 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'],
});
try {
  await context.route('https://notability.com/**', route => route.fulfill({ status: 200, contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html', body: route.request().url().endsWith('.js') ? module : '<!doctype html><html lang="en"><title>Organization fixture</title><body><div id="render_root"></div><script type="module" src="/app/assets/sentry-library-fixture.js"></script></body></html>' }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  assert.equal(await worker.evaluate(() => chrome.runtime.onConnect.hasListeners()), true, 'The test profile must load the current background worker.');
  await worker.evaluate(() => chrome.storage.local.remove('libraryNavigation'));
  const source = await context.newPage();
  await source.goto('https://notability.com/app');
  const app = await context.newPage();
  const errors = [];
  app.on('pageerror', error => errors.push(error.message));
  await app.goto(`chrome-extension://${new URL(worker.url()).hostname}/popup.html`);
  await app.locator('.folder-title').first().waitFor();
  assert.deepEqual(await app.locator('.folder-title').allTextContents(), ['Top folder', 'Level 2']);
  assert.deepEqual(await app.locator('.note-title').allTextContents(), ['Unfiled note']);
  assert.equal(await app.locator('#library-sort').textContent(), 'Created date · Notability');
  await app.locator('[data-folder-id="parent"]').click();
  assert.deepEqual(await app.locator('.folder-title').allTextContents(), ['Empty folder', 'Lectures', 'مجلد']);
  await app.locator('[data-folder-id="lectures"]').click();
  assert.deepEqual(await app.locator('.note-title').allTextContents(), ['Latest lecture', 'Plain handout', 'Early lecture']);
  await app.locator('#audio-only').check();
  assert.deepEqual(await app.locator('.note-title').allTextContents(), ['Latest lecture', 'Early lecture']);
  await source.evaluate(() => { globalThis.fixtureSort = 'edited'; });
  await app.locator('#refresh').click();
  await app.waitForFunction(() => document.querySelector('#library-sort').textContent === 'Modified date · Notability');
  assert.deepEqual(await app.locator('.note-title').allTextContents(), ['Early lecture', 'Latest lecture']);
  assert.equal(await app.locator('#library-sort').textContent(), 'Modified date · Notability');
  await app.locator('#search').fill('ملاحظة');
  assert.deepEqual(await app.locator('.note-title').allTextContents(), ['ملاحظة المحاضرة']);
  await app.locator('.note-location').click();
  assert.equal(await app.locator('#search').inputValue(), '');
  assert.deepEqual(await app.locator('.breadcrumb').allTextContents(), ['My Library', 'Level 2', 'مجلد']);
  await app.reload();
  await app.locator('.note-title').waitFor();
  assert.equal(await app.locator('#audio-only').isChecked(), true);
  assert.equal(await app.locator('[aria-current="page"]').textContent(), 'مجلد');
  await app.locator('#search').fill('Empty folder');
  await app.locator('[data-folder-id="empty"]').click();
  assert.equal(await app.locator('#empty-title').textContent(), 'No recordings in this folder');
  await app.locator('#audio-only').uncheck();
  assert.equal(await app.locator('#empty-title').textContent(), 'This folder is empty');
  await app.locator('#workspace-select').selectOption('team');
  assert.deepEqual(await app.locator('.breadcrumb').allTextContents(), ['Study group']);
  await source.evaluate(() => { globalThis.fixtureLibrary.privateWorkspace.id = 'another-account'; });
  await app.locator('#refresh').click();
  await app.waitForFunction(() => document.querySelector('.breadcrumb')?.textContent === 'My Library');
  assert.deepEqual(await app.locator('.breadcrumb').allTextContents(), ['My Library']);
  assert.deepEqual(await app.locator('.folder-title').allTextContents(), ['Top folder', 'Level 2']);
  await app.screenshot({ path: path.join(root, '.local', 'organized-library-fixture.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ folders: 'passed', noteOrder: 'passed', liveSortPreference: 'passed', breadcrumbs: 'passed', searchArabic: 'passed', audioFilter: 'passed', persistedLocation: 'passed', emptyFolders: 'passed', sharedWorkspace: 'passed', accountSwitch: 'passed', errors }, null, 2));
} finally { await context.close(); }
