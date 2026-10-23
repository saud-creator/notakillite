# Observed Notability web adapter

Public scripts inspected 2026-10-20, followed by authenticated testing with the user's permission. This is an interoperability adapter for the production application, not a supported third-party API. Live library enumeration and one full original audio read followed by local MP3 export succeeded.

## Provenance

- Official entry: https://notability.com/app
- Login: https://notability.com/login
- Production build SHA from HTML: `942a2eee50ae95415da7985f89b7d966de2d1f85`.
- Public scripts downloaded by `research/fetch-public.ps1` into `research/notability-public/`.
- Relevant module: `/app/assets/sentry-zBhOYSzV.js`. Despite its name it contains the application service factory, model types, persistence bridge and audio playback implementation.
- Offsets below are zero-based JavaScript UTF-16 character offsets in that file, not byte offsets. Module names and aliases are build-specific.

| Local evidence | SHA-256 |
| --- | --- |
| app.html | FC65B1251E4678D48BCD5CAC5E7F05762416ED008FE03B89ADA26FB87CA1DB08 |
| sentry-zBhOYSzV.js | 601E02622357333E9AAD364C9B8E35978494C717E3E368248092914A67EEFF6D |
| App-YcOgtQwd.js | D9F8D9E4C46348E7CBA00C0DF1405613529DC7F9F1091B437BD62F365F7A97AF |
| SharedWorkerEntrypoint-D2wjn_E1.js | 740C5AF2289EF2F3C546768A114AA19F8BB747D7A9DE06B93317096A0CD541B0 |

## Read adapter

Import the already loaded, same-origin service module inside the page's MAIN execution world. Identify an exported class with `getPersistenceManager`, `getNoteManager`, and `getRecordingAssetManager` functions; in this build the class is `Q9`, exported as `r` (factory offset 2189409; export alias offset 2198835). This reuses the running app's singleton and authentication. Do not copy authentication into the extension or invoke mutation methods.

The functional call chain is:

```js
const state = await services.getPersistenceManager().getLibrary();
const session = await services.getNoteManager().openNote(noteId);
const recordings = session.getModel().getRecordingEntities();
const bytes = await services.getRecordingAssetManager().getAsset(recording.assetHash(), noteId);
```

| Observation | Character offset / behavior |
| --- | --- |
| Persistence `getLibrary()` | 2174578. Worker request returns `{status: 'ready', sequenceId, library}` or `{status: 'unavailable', reason}`. Reasons observed: `invalid-credentials`, `connect-failed`. |
| Worker readiness implementation | 2095430. Waits for persisted library readiness; cached IndexedDB data can be ready before the current remote connection succeeds. |
| Library shape | 2085279. `{privateWorkspace, sharedNotes, sharedWorkspaces}`. Each workspace has `{id,title,notes,organizers,...}`. Workspace `notes` includes filed and unfiled records; organizers refer to note IDs. |
| Note record | `id`, `title`, `hasRecordings`, `createdAt`, `updatedAt`, `deletedAt`, `workspaceId`, `subjectId` / `folderId`, `userPermission` and sharing metadata. Filter deleted notes. |
| Open note | 1171966. Returns cached session after subscribing, or opens persistence bundle and constructs a session. Opening does not write note content. |
| Model recording getter | 1048709. `getRecordingEntities()` returns an ordinary JS array and excludes deleted entities through model enumeration. |
| Recording metadata | 412666. `id().toString()`, `name()`, `startTime()`, `endTime()`, `initialDuration()` (milliseconds), `assetHash()`, `fileSize()`, `recordingAsset().metadata().mimeType()`. |
| Ordering | Raw `session.getModel().getRawNote().recordings().toArray()` explicitly sorts by `zIndex()`, then entity ID. The convenience recording getter does not promise sorted order. |
| Asset reader | 1663086. `getAsset(hashObject, noteId?)` delegates to persistence by hash and returns a Blob. The app's own audio player uses this reader with the recording asset hash. MIME metadata is available separately. |

No playback/capture is necessary for original audio export. Filename and duration must come from recording metadata, not URL guessing. Support missing/empty blobs as failures. An audio export can succeed while a particular browser cannot decode that codec for filtering; preserve a download of the original.

## Session ownership

`closeNote(noteId)` at 1172228 delegates to `unsubscribeFromNote`. Worker subscriptions use a Set of client session holders, **not** a reference count: an extra open/close in the same page can unsubscribe the note already being edited.

There is no public `getSession` or `getOpenSessions` method in this build. The observed plain field `noteManager._sessionStorage` is an object with a `get(noteId)` method (class `TV`, offset 1124504); `get` reads its Map. The implementation checks for a pre-existing session, then opens it to refresh possibly stale cached data. It never closes a pre-existing session, preserving any app subscription. This can retain an additional subscription until the tab closes. For a new session, enumeration is lazy and closes it when finished only if it has not become the visible note. The observed app route is `/app/note/<noteId>` (router pattern `/note/:noteId` relative to app base). Do not destroy app sessions or invoke `evictNote`.

Library listing should read metadata only. Open one note when the user requests its recordings/export, rather than subscribing to the entire account.

## Authentication and compatibility

Fetch mechanism `O5` at 1924460 keeps an app-managed token and adds `nb-auth-token` to authenticated requests. The adapter does not need to inspect this token. The normal app services and SharedWorker handle authenticated network access.

Recordings `segments()` can describe trims/splits; `getAsset` returns the original backing audio. A full-source export must label that behavior. Producing exactly the edited playback requires interpreting segment timestamps and applying trims, not just downloading/concatenating blobs. Filtering improves speech clarity; it does not isolate a lecturer from other speakers.

Discover the current service module from the running app's scripts/preload links, validate method shapes, and report an incompatible-build error if unavailable. Avoid hardcoding an export alias or claiming a permanent official connection. In the authenticated validation, the library returned 266 notes flagged with recordings. A complete recording of approximately 114 seconds was exported as a 911,511-byte MP3 and decoded successfully (duration 113.88 seconds). No login credentials or authentication tokens were copied into the adapter or logs.

## Official product facts

### Library organization follow-up

The live workspace `organizers` field is a nested tree. Nodes carry `id`, `organizerType` (`Divider`, `Subject`, `Folder`), `siblingOrder`, `subjectHexColor`, `noteIds` and `children`. The adapter now exposes every non-deleted note and its containing folder and workspace, with unfiled notes separately retained.

The publicly loaded `store-xsR9WFU1.js` module contains `KU` (recursive sibling order, then ID), `KW` (note comparison), `vU` (numeric, case-insensitive `Intl.Collator`) and `DU` (the modern library's created/edited timestamp selection). The current Redux store is read from the existing React provider, using only `libraryPersisted.notesSortMode` and note timestamp overrides. No actions are dispatched. If the provider is unavailable the default is explicitly marked. Live parity checks passed for 115 folders and all 1,143 notes.

- [Notability Cloud sync](https://support.gingerlabs.com/en-us/articles/16300145-syncing-notes-across-devices-with-notability-cloud) states audio recordings sync to other devices, including web.
- [Web sync](https://support.gingerlabs.com/en-us/articles/16635694-syncing-notes-web-app) requires the same Notability Cloud account; iCloud-only notes do not sync to web.
- [Cloud version history](https://support.gingerlabs.com/en-us/articles/16300010-notability-cloud-version-history) documents web playback of attached audio, including recordings removed from the current note.
- [Web PDF export](https://support.gingerlabs.com/en-us/articles/16634431-pdf-export-web-app) documents PDF export, not a supported external audio API.
