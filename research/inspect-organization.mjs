import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const page = browser.contexts()[0].pages().find(page => page.url().startsWith('https://notability.com/app'));
  if (!page) throw new Error('Open the signed-in Notability library.');
  const result = await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/app\/assets\/sentry-[\w-]+\.js$/.test(new URL(url).pathname));
    const module = await import(resource);
    const services = Object.values(module).find(value => typeof value?.getPersistenceManager === 'function' && typeof value?.getNoteManager === 'function');
    const result = await services.getPersistenceManager().getLibrary();
    const library = result.library;
    const workspace = library.privateWorkspace;
    const storeUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/app\/assets\/store-[\w-]+\.js$/.test(new URL(url).pathname));
    const storeModule = storeUrl ? await import(storeUrl) : {};
    let candidates = Object.entries(storeModule).filter(([key, value]) => value && typeof value.getState === 'function');
    for (const element of [document.getElementById('render_root'), document.getElementById('root'), document.getElementById('app'), document.body.firstElementChild].filter(Boolean)) {
      const rootKey = Object.keys(element).find(key => key.startsWith('__reactContainer$'));
      const root = rootKey && element[rootKey];
      const pending = root ? [root.stateNode?.current || root] : [];
      const visited = new Set();
      while (pending.length && visited.size < 10000) {
        const fiber = pending.pop();
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        const store = fiber.memoizedProps?.store || fiber.memoizedProps?.value?.store;
        if (store && typeof store.getState === 'function') { candidates.push(['react-provider', store]); break; }
        pending.push(fiber.child, fiber.sibling);
      }
    }
    const stores = candidates.map(([key, value]) => {
      const state = value.getState();
      return { key, noteSort: state.notes?.sortOrder, librarySort: state.libraryPersisted?.notesSortMode, expandedOrganizers: state.libraryPersisted?.expandedOrganizers, language: state.settings?.language, libraryList: state.library?.allNotesList, notesCount: Object.keys(state.notes?.notes || {}).length };
    });
    return {
      libraryKeys: Object.keys(library), workspaceKeys: Object.keys(workspace),
      noteKeys: Object.keys(workspace.notes[0] || {}),
      notePlacement: workspace.notes.slice(0, 2).map(note => Object.fromEntries(Object.entries(note).filter(([key]) => /id|order|index|position|subject|folder/i.test(key)))),
      organizerCount: workspace.organizers.length,
      organizers: workspace.organizers.map(item => ({ id: item.id, title: item.title, type: item.organizerType, order: item.siblingOrder, childCount: item.children?.length })),
      metadataMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(services.getMetadataManager())),
      moduleExports: Object.entries(module).filter(([key, value]) => value && (typeof value.getState === 'function' || typeof value.dispatch === 'function')).map(([key, value]) => ({ key, methods: Object.getOwnPropertyNames(value).filter(name => typeof value[name] === 'function') })),
      sortPreferenceKeys: Object.keys(localStorage).filter(key => /sort|library|notes|organizer/i.test(key)),
      stores,
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }

