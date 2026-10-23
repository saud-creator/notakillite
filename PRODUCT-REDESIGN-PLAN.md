# Notakillite: product redesign and reliability plan

21 October 2026 · Implemented local candidate · Supersedes BRAVE-REBUILD-PLAN.md

The next release should feel like a dependable audio tool: open the app, browse the same library as Notability, select a lecture, and receive an audio file ready to upload to an AI. Connection problems must be understandable and recoverable. App upgrades must preserve the browser session, library preferences, and completed exports.

The native redesign and regular-Brave connector are implemented. The findings and work breakdown below record the original plan; [VERIFICATION.md](VERIFICATION.md) records completed checks and remaining release gates. The local connector still needs one-time installation in the user's usual Brave profile. Real-account sign-in/export and a physical Windows power cycle remain unverified; synthetic tests do not establish either.

The accompanying [interactive design preview](design/index.html) uses sample data only. It demonstrates layout, themes, navigation, recording selection, export progress, and failure states; it neither connects to Notability nor processes audio. The [preview verification record](design/review/REVIEW.md) documents 12 passed checks and 10 captured layouts/states.

## 1. Findings that change the plan

| Observed problem | Evidence and consequence | Required change |
| --- | --- | --- |
| Nearly invisible text on white surfaces | `desktop/App.xaml:4` defines an implicit Window style, while MainWindow is a derived type with no explicit style. TextBlocks separately receive light text. The real native capture reproduces the white window and pale headings. | Apply the window theme explicitly. Theme every control and popup through one resource system. Test the rendered result. |
| Unreadable dropdowns | ComboBox uses an OS template while its content inherits separate light-text styling. | Use complete, consistent templates for fields, items, dropdowns, selection, focus, and disabled states. |
| Library squeezed into a small region | `desktop/MainWindow.xaml:6` always reserves 230 pixels for the queue, even with zero jobs. | Use a compact queue bar; expand history on demand. Allocate most vertical space to the library. |
| Conflicting connection controls | Sign in, Connect, Open Brave, and Account expose overlapping actions. Errors are in a narrow footer. | Show one primary action for the current connection state and an explanation beside it. Put occasional account actions in Settings. |
| Blank and duplicate Brave tabs | `core/brave.mjs:30–33` creates another page when it cannot find an `/app` tab and suppresses navigation errors. | Reuse an eligible Notability tab, expose navigation failures, and create at most one new tab per explicit connection attempt. Never close unrelated tabs. |
| Browser failure reported as profile busy | The connector groups broad browser/target closure errors with profile-lock errors. | Introduce typed failure codes. Distinguish an actual lock, browser exit, site navigation failure, provider rejection, and adapter incompatibility. |
| Sign-in still fails outside automation | The user reported the same Google rejection in regular Brave. | Treat authentication as unproven. Do not keep repeating the same sign-in experiment or claim that removing automation has solved it. |
| A green smoke test misses obvious defects | The latest native capture opens 1,144 synthetic notes and exits cleanly, but still renders the broken theme. | Separate process health, functional correctness, visual quality, and real-account integration gates. All must pass. |

Microsoft documents that implicit WPF styles match the actual element type, including the derived-type distinction. This explains the theme failure; it does not require replacing the Windows UI framework. [WPF property precedence](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/properties/dependency-property-value-precedence)

## 2. Product decisions

| Area | Proposed decision |
| --- | --- |
| Desktop application | Keep the self-contained WPF host. Replace its view composition, themes, and state handling. Keep Windows resizing, file dialogs, keyboard support, and accessibility. |
| Brave connection | Use a minimal Manifest V3 connector in a user-selected, regular Brave profile, connected to a local native messaging host. Prove this on installed Brave before committing the release to it. |
| Authentication | Sign in on Notability's official website in regular Brave. The browser owns the session. The app observes connection readiness through the connector. |
| Library | Preserve Notability IDs, hierarchy, memberships, folder colors and saved sibling/note order. Never reorganize the remote account. |
| Audio | Retain the existing real FFmpeg, RNNoise, DeepFilterNet3, and combined processing implementations. Improve their orchestration, quality checks, and presentation. |
| Local state | One core owns SQLite metadata, settings, connection state, jobs, and worker processes. The view displays typed state and issues narrow commands. |
| Distribution | One desktop EXE containing its runtimes and models, plus a one-time Brave connector installation. Keep its identity stable across desktop updates. |

The connector is a communication component; all library browsing, audio settings, progress, and playback live in the Windows app. Its site permission is restricted to the required Notability origin. No Edge integration is included in the new release.

Why change the browser transport: a regular Brave extension can communicate with a native app without switching one browser profile between manual and automation ownership. This removes that ownership handoff from the proposed workflow. **It does not prove that Google sign-in will succeed.** First establish whether the official site works in the user's chosen regular Brave profile, then test the connector there. Google lists software-controlled and embedded browsers among possible reasons for refusing sign-in, but that alone does not diagnose this regular-Brave failure. [Google sign-in guidance](https://support.google.com/accounts/answer/7675428?hl=en)

Brave documents installing Chromium-compatible extensions through Add to Brave. Native messaging provides a documented extension-to-local-process transport. Brave-specific host registration and lifecycle behavior still need a Windows proof; do not assume that Chrome examples alone prove Brave compatibility. [Brave extension installation](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave), [native messaging protocol](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

**Distribution constraint:** the production connector needs a legitimate installation/update route and user browser consent. Prepare a store-ready package with a stable ID. Store publication/review and a publisher signing certificate are external dependencies, not completed work. A development-only unpacked installation is an engineering test, not the finished installation experience. The EXE must not silently enable Developer mode, force an extension through enterprise policy, or promise a zero-step connector install. Chromium's documented Windows distribution flow requires store hosting and user confirmation; verify the final route in Brave. [Extension installation requirements](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)

If the regular Brave sign-in proof fails, diagnose the official site's supported sign-in flow before doing another production browser rewrite. Retain the current private-pipe connector for isolated engineering tests only while evaluating the proposed replacement. Do not ship two confusing connection modes as a workaround.

## 3. Everyday experience

The normal path is **Open → choose folder → choose note → Export for AI → Open output**. With one available recording, the note's quick export action uses the saved preset. Multiple recordings open a clear selection before queuing. No extra Load recordings step is needed in the normal path; recording discovery has its own loading and retry states.

### Window composition

- A restrained header contains the product name, a readable connection status, and Settings. A connection failure expands a contextual banner with one action.
- A 220–260 DIP sidebar shows the original nested library. Preserve expansion, selected folder, scroll position, and membership. Show direct-note and descendant counts accurately if both are used.
- The main region contains breadcrumbs, a labeled search field, the Audio only filter, a sort label, and compact note rows. Titles, audio duration/count, and update metadata have a clear hierarchy. Avoid oversized cards that show only four notes at a time.
- A 320–360 DIP inspector appears for a selected note. It contains recording checkboxes, durations, a cleanup preset, an export summary, and one prominent Export for AI button.
- An idle queue occupies approximately 48–56 DIP. Active work can show one compact progress row; expanded history is user controlled. Playback appears only when an output is loaded.
- Below approximately 1,100 DIP, the inspector becomes a dismissible detail pane; below approximately 820 DIP, the sidebar becomes a drawer. Resizing must preserve selection and work in progress.

The disconnected first-run view provides one Connect Notability action and an equally discoverable Import audio option. It explains the one-time connector setup without showing an empty three-column shell. Offline users see their cached library and the time of the last successful observation, with local processing available.

### Visual system and accessibility

Use neutral surfaces with a lavender accent reserved for primary actions, focus, and selection. Provide Dark, Light, and System preferences; respect Windows high contrast through an explicit resource override. Pair foregrounds and backgrounds in shared semantic tokens rather than scattering hex colors through views.

Body and field text should generally be 14–15 DIP, metadata at least 12 DIP, and headings 18–24 DIP. Use Segoe UI, predictable 4/8 DIP spacing increments, and 36–40 DIP primary controls. Theme buttons, text inputs, checkboxes, dropdowns, tree rows, selected rows, menus, scrollbars, tooltips, progress, dialogs, and focus indicators together.

Target at least 4.5:1 for ordinary text and 3:1 for large text and meaningful control boundaries. Test the actual chosen states, not only a palette swatch. Provide text labels with status colors, visible keyboard focus, logical Tab order, screen-reader names, and keyboard export/navigation. Preserve mixed Arabic/English titles using per-text direction without reversing the whole application. [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

### Audio controls

| Preset | Engine | Presentation |
| --- | --- | --- |
| Balanced cleanup · default | DeepFilterNet3, balanced | A useful starting point; always show the actual engine in the summary. |
| Faster cleanup | RNNoise, balanced | Suitable when processing speed matters; measure performance before making speed claims. |
| Original audio | No denoising | Export the source unchanged when no conversion/splitting is selected. |
| Custom | Any supported engine/strength, including RNNoise → DeepFilterNet3 | Advanced controls disclose extra processing cost and possible effects on quiet speech. |

Keep splitting and engine details under Advanced, while displaying a concise summary beside the main action. Disable export when no recording is selected and say why. Keep file import and drag-and-drop available without a Notability connection. Batch exports enter the same durable queue.

Provide a short original/processed A/B preview before a full export, with a shared playback position and a clearly labeled engine. This is a feature to implement, not present functionality. Use the same processing settings and enough neighboring context to make the preview representative. Cache previews by source fingerprint and engine/options/version; do not overwrite completed exports.

## 4. Connection behavior and saved sign-in

| State | What the user sees | Primary action |
| --- | --- | --- |
| Connector not installed/enabled | One-time setup guidance; local import remains available | Set up Brave connector |
| No eligible Notability tab | Explain that the official site is needed | Open Notability in Brave |
| Waiting for sign-in | Waiting screen; no claim that a session has been saved yet | Show Notability |
| Loading account/library | A bounded loading state; no repeated new tabs | Show progress; retry after a real failure |
| Connected | Last observed library time, account identity when verified, and normal browsing | Refresh in the status menu |
| Website/provider rejected sign-in | The rejection is retained and explained; another automatic attempt is not launched | Show official sign-in page/help |
| Browser/connector unavailable | Cached library remains visible; downloads pause/fail recoverably; local cleanup continues | Reconnect |
| Integration incompatible | Explain the adapter problem separately from sign-in | Check integration status/update |
| Export failed | Error is attached to the job, with the source and chosen settings retained | Retry or change settings |

Repeated Connect clicks must coalesce into one attempt. Retain a stable eligible tab ID and rediscover it after reload. An OAuth navigation is not a reason to create another app tab. Never close pre-existing user tabs or unrelated Brave windows.

Use explicit state and error enums with recovery actions; replace regex classification of exception text. Each operation has a request ID, cancellation, a bounded timeout, and one owner. Reconnection uses bounded backoff with a visible retry option, not an endless spinner or repeated sign-in prompts. Adapter capability checks run before claiming that the connection is ready.

For future builds, preserve the selected Brave profile reference, extension ID, native-host registration, account-specific preferences, SQLite data, and exports. Browser session storage stays in Brave and is never copied between profiles. Keep the existing Notakillite profile intact even if a different normal Brave profile is selected. A sign-in survives updates while Notability considers the session valid; explicit sign-out, expiry, or provider revocation can still require authentication.

The upgrade proof must use three distinct program builds with the same selected browser profile and connector identity. A browser storage fixture proves file/session persistence only; it must be supplemented with a real Notability session check.

## 5. Core and connector implementation

```text
Official Notability page in regular Brave
  ↕ narrow page adapter, account/capture ownership
Brave Manifest V3 connector
  ↕ native messaging, stable extension identity
Small native bridge host
  ↕ current-user-only local pipe
Single local core ─ SQLite + preferences + durable job queue
  ↕ typed commands/events             ↕ isolated audio worker
WPF desktop views                    FFmpeg / RNNoise / DeepFilterNet3
```

The bridge must not start a second core for each message. It finds the current-user instance or starts the normal application when explicitly requested. Closing the visible window during a job offers background continuation in the tray; full Quit cancels workers cleanly and records recoverable state. No administrator service is necessary.

Use a transport-neutral connector interface for status, library snapshot/deltas, recording discovery, capture start/status/read/release, and cancellation. Bind every capture to account/note/recording ownership. Keep audio chunks bounded, verify byte counts, and acknowledge progress; never send a full lecture in one JSON message. Keep native-host responses below the protocol's 1 MB limit. Test a maximum-size frame and interrupted chunk explicitly. [Native messaging limits](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

Register only the known extension origin. The extension cannot issue arbitrary shell commands, choose arbitrary export paths, or read other websites. Validate origin/frame, schema, message size, operation, request correlation, and capture ownership at the appropriate boundary. Do not expose an unauthenticated local HTTP control server. Logs exclude authentication, page bodies, and audio.

Refactor the current all-in-one MainWindow handlers into small view models and components: Connection, Library, NoteDetail, ExportOptions, Jobs, Playback, and Settings. Read-only progress bindings are explicitly OneWay. Selection and command availability update from observable state. Keep browser/audio work off the dispatcher; apply library changes incrementally and avoid replacing the entire list on every progress event.

## 6. Library fidelity and synchronization

Use Notability's IDs as stable keys. Preserve workspaces, dividers, subjects/folders, empty folders, unfiled notes, shared libraries, note membership, folder colors, and saved sibling order. Follow the available Notability note-sort setting, including stable tie-breaking. If it cannot be read, label the fallback accurately rather than claiming an exact match.

Verify the full graph: IDs, parent IDs, ordered child arrays, note membership, and note ordering. A count-only comparison is insufficient. Include moved/renamed notes, deleted notes, duplicate titles, empty parents, Arabic text, shared notes, unknown recording metadata, and recording-free notes.

Cache per account. Preserve expanded branches, selected note, search/filter, and scroll position across refresh and restart. On an actual account switch, stop mismatched remote captures and isolate the previous account's cached metadata. Do not label every successful cached read as fresh cloud synchronization; distinguish last browser observation from a confirmed server-sync signal when available.

Use relevant page/metadata events where reliable, plus a conservative refresh fallback. Bound polling, diff updates, and prevent overlapping refreshes. The web adapter remains an unofficial dependency on Notability internals; capabilities/version diagnostics and local import must survive a site change.

## 7. Audio integrity, performance, and recovery

Bundle pinned RNNoise and DeepFilterNet3 assets, FFmpeg, runtimes, licenses, and integrity hashes. A missing engine gives an engine-specific error; never silently substitute another algorithm. Retain bounded DeepFilterNet chunks, neighboring context, padding, delay compensation, and exact decoded sample-count checks.

Decode by content, not extension. AAC M4A and ALAC M4A are mandatory release cases, along with WAV, MP3, FLAC, OGG, WebM, AIFF, CAF, and raw AAC as supported by bundled FFmpeg. Explain corrupt/protected/no-audio inputs. Treat “any file type” as accepting a file for inspection, not a promise to decode every codec or DRM scheme.

Run one heavy denoising task at a time initially. Persist the source fingerprint, settings, runtime/model versions, job stage, source completeness, and output manifest. Resume/retry only verified inputs; reject changed sources. Check available disk space before decoding and during long work. Decode the final output and verify duration before showing Ready for AI.

Publish completed outputs atomically. Partial files stay in job-owned staging and cannot appear as completed exports. Cancellation waits for the owned child process to exit, removes incomplete generated outputs, and retains a complete verified source for retry. Never delete unrelated files or modify source audio. Retrying must not create a second completed export for the same job ID.

Default processed output remains MP3, mono, 24 kHz, 64 kbps, with optional 10/20/30-minute splitting. Original export remains byte-for-byte when unchanged. Provide Open folder, Copy path, preview, and Retry with different settings; do not upload lectures to an AI automatically.

Measure a licensed speech/noise fixture and listen to representative lecture excerpts, including quiet speech, silence, music, and multiple speakers. Check chunk boundaries and the final seconds. A valid MP3 alone does not demonstrate good denoising. Combined mode is optional and must not be marketed as invariably better than either individual engine.

Initial engineering targets, to be measured on this computer: cached interface interactive within 2 seconds warm/5 seconds cold; folder selection and search p95 within 150 ms with 10,000 synthetic notes; no repeated UI-thread stalls over 100 ms during export. Report desktop/core memory separately from Brave and audio workers, and measure long-lecture peak usage before setting a published memory claim.

## 8. Delivery sequence and stop conditions

| Order | Work package and concrete deliverable | Exit gate |
| --- | --- | --- |
| 0 | Preserve the last candidates, data locations, and a reproducible baseline. Record the current visual/auth failures. Set up tracked source changes before another rewrite. | Existing user profile and exports untouched; baseline tests and defect list recorded. |
| 1 | Prove the regular-Brave sign-in and proposed native bridge on installed Windows/Brave. Prepare the connector's stable identity and installation route. | A real account library and one full recording export work without manual/automation profile handoff. Installation is honestly classified as development or production. **Stop release work here if authentication remains blocked.** |
| 2 | Implement typed core state, connector ownership, bounded transfer, durable queue/recovery, and versioned data migrations. | Browser exit, tab reload, expired session, account switch, repeated Connect, core restart, and transfer interruption produce the intended recoverable state. |
| 3 | Implement the redesigned native shell and shared theme components from the preview, then responsive inspector/queue and empty/error views. | Native screenshots, keyboard and screen-reader flows pass in both themes, high contrast, supported DPI and window sizes. |
| 4 | Connect full library fidelity, recording selection, presets, A/B preview, batch export, history, and output actions. | Snapshot graph/order matches; selection survives sync; export availability follows selection; local import works disconnected. |
| 5 | Complete audio format/quality/integrity, long-lecture, disk/cancellation, and worker recovery checks. | All supported engines produce verified outputs for required codecs; interruption cannot expose partial results as finished. |
| 6 | Build the self-contained EXE and store-ready connector, verify migration/upgrades/rollback, and perform a real packaged-account test. | Every release criterion below has an artifact/result. External publication/signing requirements are explicit; no unsigned or unpacked candidate is described as a completed signed release. |

No calendar promises until the first connection gate passes. Core, theme, and audio work have separate acceptance results so one passing subsystem cannot conceal another's failure.

## 9. Packaged release checklist

| Test | Required evidence |
| --- | --- |
| Normal user journey | On the packaged build: real sign-in, exact library navigation, selected recording export, successful playback, output found in Explorer. |
| Installation | Fresh-user install with a normal Brave installation; expected browser consent; no Edge, development SDK, or source checkout required. |
| Theme/rendering | Screenshots at 1024×768, 1280×800, and 1920×1080 equivalents; 100/125/150/200% DPI, dark/light/high contrast; dropdowns, selected rows, disabled controls, long titles, errors and queue states reviewed. |
| Layout | Empty queue collapses; controls remain reachable; library stays useful at small widths; no unexpected horizontal clipping. |
| Accessibility | Keyboard-only connect/browse/select/export/retry; visible focus; meaningful UI Automation names; Arabic/English mixed titles render correctly. |
| Browser ownership | Ten repeated/retried connections do not accumulate blank tabs or spawn competing owners; existing unrelated tabs remain untouched. |
| Library accuracy | Full ordered graph comparison, including empty/unfiled/shared/renamed/moved notes; explicit fallback-sort labeling. |
| Codec/engine matrix | AAC and ALAC M4A through RNNoise, DeepFilterNet3 and combined mode; full existing decoder matrix; corrupt input and unavailable-engine cases. |
| Long lecture | Representative 45–90-minute lecture with end/boundary speech, exact duration/sample checks where appropriate, output decode, memory/disk measurements. |
| Interruption | Cancel during capture/denoise/encode; Brave exit; core crash; app close/background/full quit; restart/retry has no duplicated or falsely completed output. |
| Upgrade A → B → C | Three distinct payloads retain the real valid Brave session, connector identity, account preferences, jobs, and exports. |
| Failed update/rollback | Incomplete extraction leaves the old version runnable; compatible data backup/recovery works; browser profiles are never downgraded or reset. |
| Packaging | Run from a path containing spaces/Arabic, with no SDK available; no user accounts, browser data, sample private notes, or test audio inside the EXE. |
| Distribution | Connector route and signing status are stated accurately; hashes/licenses/dependency inventory included; EXE startup checked after extraction. |

Produce a concise release report with passed, failed, and unverified items. “No known blocker in the tested matrix” is a defensible conclusion; “no errors under any circumstances” is not.

## 10. Deliverables and boundaries

Planning deliverables: this implementation plan, an interactive visual prototype, reviewed preview screenshots, and a verification record. These are ready for implementation review, not a substitute for the final app.

Implementation deliverables: native desktop EXE, stable Brave connector package and setup flow, bundled offline audio engines, account-safe migration, meaningful tests, updated user/developer documentation, dependency/license inventory, and a packaged release report. Retain the previous EXE and completed exports throughout migration. Keep `%LOCALAPPDATA%\Notakillite` separate from replaceable program versions; migrate ordinary data with a schema version and backup.

Publisher signing/store publication require an available signing identity and developer distribution account. Preparing reviewable packages is local work; claiming external approval or signing without those resources is not. Authentication remains a first-class release gate. No automatic AI upload, transcription service, video reconstruction, or changes to the remote Notability library are added to this audio-focused rebuild.
