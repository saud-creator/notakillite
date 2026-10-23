# Verification — 2026-10-21

- **33 Node tests passed:** real FFmpeg cleanup/encoding, chunked upload, local authorization, bad-audio recovery, adapter library filtering, lazy note access, session ownership, shared notes, account changes, schema failures, folder hierarchy, live sort preference changes, addressed messaging, reconnect retries, duplicate export prevention, pending audio downloads, processor-job recovery, neural engines, codec coverage, long-file joining and Windows extraction paths.
- **Microsoft Edge:** extension-to-processor handshake, app window, popup preferences, search and errors were exercised using isolated test profiles. A fresh first install opened the app after extension registration.
- **Synthetic full browser export:** MAIN-world service access → isolated-world Blob streaming → extension worker → local processor → MP3 and manifest succeeded. This test uses a generated tone, not a real account.
- **Original browser download:** all 768,044 generated WAV bytes were preserved exactly; the Blob URL and download ownership record were released after completion.
- **REA 6.7.0 analysis:** successfully inspected 12 public files, with 1,367 application graph nodes and 3,734 edges. One script exhausted its worker heap, so static coverage is partial; see `research/rea-summary.json`.
- **Authenticated account:** after the user signed in normally, the app listed 266 notes containing recordings, loaded one note's recording metadata, and exported one complete recording. The resulting MP3 was 911,511 bytes; full decoding succeeded and duration was 113.88 seconds, matching the approximately 114-second source.

Only the selected recording was exported from the user's account. Passwords, cookies, and authentication tokens were not inspected or copied. The saved real export stays in `exports`; it is excluded from the distributable ZIP.

The adapter depends on Notability's internal web services. These checks validate the inspected build and one real recording; they do not prove compatibility with every note, future builds, or every audio codec.

## Organization update

- Read-only live comparison passed for 1,143 notes and 115 folders, including exact folder membership, names, types, sibling positions and Created date note order. The 266 notes containing recordings remain identifiable without filtering out other files from the library.
- Headless Edge browser checks passed for nested browsing, breadcrumbs, changing the synthetic Notability sort preference, Arabic search, Audio only, persisted folder location, empty folders, shared libraries and account switching, with no page errors.
- `scripts/verify-live-library.mjs` compares metadata through the existing diagnostic browser. It never changes Notability folders, note content or sort settings.

## Connection fix (0.2.1)

- App requests use addressed worker ports. Other open extension windows cannot consume their replies. The panel preserves its displayed library during transport reconnection.
- Exports acknowledge immediately and run under worker ownership. Slow Notability audio downloads run as pollable page tasks. A heartbeat keeps active export work alive when the panel closes; idle windows do not send keepalive heartbeats.
- Headless Edge passed a forced worker stop/reconnect, a 35-second synthetic audio fetch with the initiating panel closed and reopened, a competing asynchronous message listener, a repeated export request with the same operation ID, processed MP3 output and byte-exact original download. No page errors occurred.
- The existing library test profile initially retained the previous worker. A versioned worker entry point fixed that upgrade path, and the organization browser checks then passed using that same profile.
- These connection regression checks use synthetic fixtures. The user's 41:54 lecture shown in the screenshots has not been exported again during this fix.

## Offline neural cleanup (0.3.0)

- RNNoise inference uses FFmpeg's `arnndn` with the recording-oriented `cb.rnnn` model. DeepFilterNet uses the upstream Windows x64 `v0.5.6` runtime and explicit DeepFilterNet3 ONNX model. Both runtimes/models and notices are included under `vendor`; SHA-256 checks are enforced by the EXE builder. There is no Python or GPU dependency.
- Real CPU processing passed for both **AAC M4A** and **ALAC M4A** through RNNoise, DeepFilterNet3 and combined mode. The AAC/ALAC tests deliberately upload bytes with a generic `.audio` extension, matching the Notability transfer path.
- A generated spoken lecture with deterministic white noise passed non-silence, duration and a minimum 3 dB reduction in the noise-to-speech energy ratio. This checks useful suppression on a controlled fixture; it does not establish real lecture intelligibility or universal audio quality.
- WAV, MP3, FLAC, OGG/Vorbis, WebM/Opus, AIFF, CAF/PCM and raw AAC passed through both neural engines, including stereo inputs and resampling. Protected/damaged files and formats outside the bundled FFmpeg decoder set remain unsupported.
- A 121.137-second spoken fixture crossed the two-minute DeepFilterNet boundary. The output retained its expected sample count after resampling, retained speech in the final chunk, and left no temporary `denoise-` directory. Context overlap and tail padding compensate the upstream CLI's latency trimming.
- Relocating both models and the DeepFilterNet executable to a path with spaces, an apostrophe and Arabic characters passed. The test caught and fixed FFmpeg's two-stage filter-path escaping.
- Headless Edge passed local M4A import, all three neural selections, preview playback control, working MP3 download URLs, saved engine preferences and a 380-pixel layout without horizontal overflow or page errors. The existing Notability hierarchy checks and a worker restart/panel-close export also passed with the new processor.
- The updated processor uses loopback port 43188 so an older running 0.2.x processor cannot be mistaken for a processor that supports the new engines. The launcher and extension use that same port. Existing saved recordings and browser login data are not moved or deleted.
- The final **86,792,192-byte EXE** extracted successfully, ran bundled Node/FFmpeg/DeepFilterNet, and used its extracted processor and bundled models to export Apple AAC M4A through RNNoise, DeepFilterNet3 and combined mode. All three returned valid MP3 downloads. No account/profile data is included in the payload.
