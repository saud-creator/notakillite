# Notakillite: Brave desktop rebuild

Status: superseded on 21 October 2026 by [the product redesign and reliability plan](PRODUCT-REDESIGN-PLAN.md). A native v0.4.0 candidate exists, but its real-account authentication and visual release gates have not passed. The document below is retained as the earlier architecture proposal.

## Intended result

One Windows app owns the library, audio controls, previews, export queue and updates. Brave handles the normal Notability website and its saved sign-in. The desktop app connects directly to its dedicated Brave session; it does not open an Edge extension page or require a Brave extension or browser Developer mode.

Brave is already installed at `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe` (observed version 155.1.97.59). The reported Edge failure is confirmed in the app's extension registration: disable reason `16777216`, corresponding to a developer extension disabled while Developer mode is off. Registration alone was incorrectly treated as readiness by the launcher.

The central acceptance rule is: **installing a new app build must never replace, reset, rename or delete the user's Brave profile.**

## Decisions

| Area | Decision | Reason |
| --- | --- | --- |
| Desktop interface | Native WPF Windows app, self-contained .NET 10 LTS | A normal resizable Windows window, accessible native controls, and no Edge/WebView2 dependency for the interface. |
| Website connection | Installed Brave, dedicated persistent profile, DevTools Protocol over a private inherited pipe where supported | The connector can use the running Notability app's services without depending on an extension being installed or enabled. Prove pipe support in the first milestone. |
| Sign-in | Normal Notability sign-in in visible Brave; Brave keeps its own login state | No password form in Notakillite and no cookie/token extraction or cross-browser credential copying. |
| Core ownership | A local core service owns connection state, cached library and durable export jobs | Closing or reopening the UI must not duplicate work or turn an active job into an apparent disconnection. |
| Audio | Reuse and harden the tested Node/FFmpeg/RNNoise/DeepFilterNet pipeline | Preserve working codec support, models, licenses, original-audio export and duration checks. |
| Local transport | Narrow commands over Windows named pipes or inherited stdio | Remove the UI's dependency on a fixed localhost HTTP port. Port 43188 remains only for the legacy build during migration. |
| Distribution | One Windows x64 EXE with staged version directories and a stable launcher | Program replacement is separate from user data. Updates switch versions only after verification. |

The WPF host and the local core service have explicit responsibilities. The core is the single authority for connection and export state; the interface displays that state and sends commands. A small persistence module owns the SQLite metadata/job database and schema migrations. Audio workers report progress to the core, not directly to individual windows. Browser and file operations stay off the UI thread.

The .NET SDK is not currently available on PATH in this workspace. The build step must provision a pinned SDK in a project tool directory or CI, then publish a self-contained Windows app. End users do not install a development SDK.

## Permanent user data and sign-in

Use the same root as the existing EXE, `%LOCALAPPDATA%\Notakillite`, with these independent locations:

```text
Notakillite/
  launcher/                  stable launcher and installed-version pointer
  versions/<app-version>/    replaceable, verified program files only
  browser/brave/            permanent Brave user-data directory
  data/library.sqlite      cached metadata, preferences and export queue
  exports/                  completed exports; retain existing exports here
  temp/                     disposable, job-owned intermediate files
  logs/                     bounded diagnostics with no authentication data
  .local/notability-browser/ existing Edge profile retained during migration
```

The Brave executable remains in its normal installed location. The app version, EXE filename, download location and payload hash never become part of the Brave profile path. Routine upgrades never run an uninstall/reset operation against user data. A future uninstall keeps sign-in data and exports by default; explicit reset is a separate action.

Authentication contract:

1. The first Brave-connected launch opens the official Notability site for normal sign-in.
2. Subsequent launches reuse `browser/brave` on the same Windows account and computer.
3. App updates preserve that exact directory and all Brave-managed session state.
4. A network outage, browser crash or adapter failure produces a reconnect state, not a request to sign in again.
5. Show a sign-in request only after the website indicates that the session actually ended.
6. Signing out, changing the Windows account/computer, or Notability expiring/revoking a session can still require authentication. Saving a browser profile cannot override those events.

The current saved account is in Edge. Moving it to Brave may require one final normal sign-in. Do not promise that encrypted Edge session data can be transferred to Brave. Keep the old profile intact and preserve library navigation/export preferences independently. The guarantee being built is persistence across **future app builds using Brave**, not indefinite immunity from website session expiry.

## Connection and synchronization

Use a connection state machine with distinct states: Starting, Sign-in required, Connecting, Connected, Offline cache, Reconnecting, and Integration update required. Retain the last library and folder selection during transient failures.

On launch, acquire a single-instance lock, load user data, discover Brave and start or reconnect to the app-owned browser session. Use an explicit executable path and the permanent profile path. If the profile is already busy, reconnect through the existing app instance or show an actionable recovery; never create a temporary replacement profile and never terminate unrelated Brave windows.

Prefer a private browser debugging pipe. If the installed Brave cannot support that reliably, evaluate a short-lived loopback-only endpoint as an explicit fallback with ownership checks and no fixed public debugging port. Never attach to the user's everyday Brave profile. The connector should retain one app-owned Notability tab, validate its origin, and recover after reloads or tab loss.

Port the existing adapter behind a transport-independent interface:

```text
getConnectionState()
getLibrary()
getRecordings(noteId)
startRecordingCapture(noteId, recordingId)
getCaptureStatus(captureId)
readRecordingChunk(captureId, offset, maximumBytes)
releaseCapture(captureId)
```

Keep binary transfers bounded. Do not serialize an entire lecture through one message or rely on a long-running request from a UI window. Correlate commands, bound timeouts, and make retries idempotent. Keep existing protections for note-session ownership, account switches and Blob release.

The library still follows Notability's nested dividers, subjects, folders, note membership, saved sibling order and current available sort preference. Start with a complete snapshot, then compare metadata changes on a bounded refresh cadence while connected. Label cached content and show the last successful synchronization time. Clear account-specific caches when the signed-in account changes. Never rearrange or rename the library in Notability.

The existing adapter uses Notability's internal web services. A Brave connection does not remove that compatibility dependency. Probe capabilities and show an integration-specific error when their shape changes; retain cached metadata and provide local file import while the connector needs updating.

## Interface and everyday workflow

The main layout has a folder tree on the left, a virtualized note list in the center, and a recording inspector on the right. Smaller windows collapse the inspector into a detail view. Use breadcrumbs, global search, an optional audio-only filter, keyboard navigation and correct Arabic/RTL text rendering. Persist the folder, search/filter settings, preferred engine, window size and export destination.

Selecting a note loads its recording list. The inspector provides recording selection, duration, source information and one **Export for AI** action. Advanced cleanup settings fold away. Always display the selected engine and strength in the export summary.

Support RNNoise, DeepFilterNet3, combined mode, light cleanup and unchanged original export. Use balanced strength by default. Combined mode is an explicit option with a concise explanation that it takes longer and can soften quiet speech. Keep processed output as predictable AI-ready MP3 initially; expanding output formats is a separate requirement.

Provide a local-file drop area and picker using the same queue and audio pipeline. Accept formats based on decodable contents, not a filename whitelist. Show a clear error for damaged, protected or audio-free files. For completed jobs, offer MP3 preview, reveal-in-folder, copy path and retry with a different engine. The app does not upload audio to an AI provider automatically.

The queue stays visible below the library. Each item shows the note/recording, engine, actual processing stage, elapsed time and completed output. Use indeterminate progress when duration/progress is unknown. Separate download, decode, denoise and encode stages. Offer cancel, retry and remove-completed. Closing the main window during a job offers a background/tray continuation; a full quit handles running processes explicitly.

## Durable audio processing

Keep the pinned RNNoise model, official DeepFilterNet runtime/model, FFmpeg, licenses and checksum verification. Validate required runtimes at startup and report an engine-specific failure without silently changing the chosen engine.

Preserve the existing two-minute DeepFilterNet chunks, neighboring context, tail padding, delay compensation and exact sample-count checks. Retain original audio and verify the final decodable output before marking a job complete. Check free disk space before large jobs and clean only files owned by that job.

Persist each job's ID, account/note/recording references, source fingerprint, engine/options, temporary paths, completed stages and output manifest. Use atomic state changes and a defined recovery policy: resume verified local processing stages, redownload incomplete remote captures when safe, and require a retry when a source changed. Never append a second transfer blindly to an incomplete upload. Start with one heavy denoise job at a time; measure CPU, memory and responsiveness before increasing concurrency.

## Updates and migration

Preserve the released v0.3.0 EXE and existing data while building the replacement. Migrate ordinary settings and cached metadata with backups and a schema version. Do not import browser credentials. Point existing completed exports at their current location, including an optional user-selected legacy source-project export folder; do not silently move lecture files.

An update is downloaded or extracted into a new program-only directory, checked for completeness and artifact integrity, and smoke-tested before the active-version pointer changes. Plan for publisher signing of the distributable and a signed update manifest; hashes alone are not publisher authentication. Defer the version switch while a job is actively processing. Roll back the app version on startup failure while leaving the Brave profile and exports untouched. Do not roll back the installed Brave browser or attempt to downgrade its profile format.

## Implementation sequence and release gates

| Phase | Concrete work | Must pass before proceeding |
| --- | --- | --- |
| 1. Brave connection proof | Exercise the installed Brave with a temporary dedicated test profile, private pipe, normal sign-in flow and adapter calls; test a locked profile and browser restart. | A synthetic fixture connects without any browser extension or Developer mode. A real Brave sign-in and selected recording export are verified before final cutover. |
| 2. Persistent profile and updater contract | Add one path resolver, single-instance ownership, data/schema separation, staged updates and rollback behavior. | Three consecutive distinct builds reuse the exact same Brave profile. Upgrades do not remove stored session state, settings or exports. |
| 3. Transport-independent core | Extract extension orchestration into the core; add bounded capture streaming, explicit connection states, durable jobs and cancellation. | Closing/reopening the UI and restarting a worker do not duplicate exports; a failed connection preserves the last library. |
| 4. Native desktop interface | Build WPF navigation, virtualized library, inspector, presets, file import, preview and queue. | The existing library fixture retains its hierarchy and sort; Arabic and keyboard flows work; large libraries remain responsive. |
| 5. Audio hardening | Integrate the existing neural engines, dependency checks, progress, manifests and recovery with the new core. | Existing codec/noise tests pass, plus cancel/restart, low-space and long-lecture checks. No source audio is modified. |
| 6. First-run and legacy migration | Detect Brave, guide the first normal sign-in, import non-auth settings, preserve all old data and explain reconnect states. | A fresh Windows account and an existing v0.3.0 install both complete onboarding without extension settings or unexpected profile resets. |
| 7. Release validation | Publish a self-contained EXE, test its extracted payload, perform the upgrade matrix and run the real-account smoke check. | Deliver only after the criteria below pass on the packaged build. |

The first two phases establish the architecture and sign-in guarantee before investing in the full interface rewrite. Keep the current passing tests for audio and adapter behavior; add tests for changed ownership, persistence and upgrade behavior rather than rewriting assertions around the new code.

## Final acceptance matrix

| Scenario | Required result |
| --- | --- |
| Fresh launch | A native app opens; the user signs in normally in the app-owned Brave session. No extension URL is opened. |
| Upgrade A → B → C | Same account remains available without a new sign-in when the website session is still valid; profile path, settings and exports are unchanged. |
| App rollback | Previous compatible app build opens with existing user data; no browser/profile downgrade occurs. |
| Browser closed/crashed | Connection state explains what happened, offers reconnect, and keeps the library visible. |
| Offline | Cached notes are clearly labeled; local file cleanup continues to work. |
| Genuine logout/expired session | One clear sign-in action; no automatic clearing of unrelated preferences or exports. |
| Multiple app launches | One instance and one owner of the Brave profile; no second profile or duplicate export. |
| Library | Exact nested membership/order for supported Notability sort preferences; notes without recordings and empty folders remain accessible. |
| Audio | AAC/ALAC M4A and the existing eight-format matrix pass through both engines and combined mode where applicable. |
| Long lecture | Test a representative 45–90 minute recording, including speech near chunk boundaries and the end; verify duration, output decoding, bounded memory and cleanup. |
| Close during export | Background processing or an explicit quit decision; reopening shows the same job and outputs. |
| Interrupted update | Old version remains runnable; no partial active install, profile loss or export deletion. |
| Delivery | Packaged EXE tested from a clean path with spaces/Unicode, with no development SDK or project checkout required. |

## Reference checks

- [Brave command-line flags](https://support.brave.com/hc/en-us/articles/360044860011-How-Do-I-Use-Command-Line-Flags-in-Brave) and [DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/): basis for the direct browser connector. Pipe behavior and login compatibility must be verified with the installed Brave in phase 1.
- [Chromium extension disable reasons](https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/disable_reason.h): identifies the observed Edge disable reason.
- [Chromium remote debugging profile changes](https://developer.chrome.com/blog/remote-debugging-port): supports using a dedicated custom profile and keeping ordinary browser profiles outside the connector.
- [WPF overview](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/) and [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core): the planned Windows interface and current .NET 10 LTS choice.
