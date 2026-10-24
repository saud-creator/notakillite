# Notakillite 0.7.0

Turn Notability lecture recordings into **clean audio and AI-ready transcripts**. Import a Notability note export (`.note`), audio files or a whole folder; Notakillite removes background noise such as air conditioning, transcribes the speech, and writes **one Markdown file per lecture** that you can upload to ChatGPT or Claude ("what did the doctor say is on the exam?").

- **Windows app** (this folder): native WPF app with local RNNoise / DeepFilterNet3 noise cleanup and Whisper speech-to-text.
- **iPhone app** ([`ios/`](ios/README.md)): the same import → clean → transcribe → Markdown flow on the phone.

## Quick start: from Notability to ChatGPT

1. In Notability, open the note → **Share / Export** → choose the **Note** format (it includes the recordings) or **PDF + Recording**, and save it to this PC. Plain audio files (M4A, MP3, WAV…) work too.
2. In Notakillite, choose **Import lectures…**, drag the files or a folder onto the window, or copy them in File Explorer and press **Ctrl+V** in the app.
3. Each import becomes one folder in your exports:

   ```text
   2026-10-23 14.05 - Anatomy week 3/
     00 - Index.md              list of lectures, lengths and word counts
     01 - Abdominal wall.md     transcript with [hh:mm:ss] timestamps
     01 - Abdominal wall.mp3    cleaned audio
     02 - Inguinal canal.md
     ...
   ```

4. Upload the `.md` files to ChatGPT or Claude, or press **Copy text** on a finished job and paste it. Each file starts with a short suggested request (exam hints, quizzes, key points, summary) that you can delete in the transcript settings.

Five lectures in → five transcripts out, numbered in the order you imported them (natural name order for folders; Notability's own order for recordings inside a note).

## Speech-to-text: what it uses and why

| Engine | Cost | Where audio goes | Speed (1-hour lecture) | When to use |
| --- | --- | --- | --- | --- |
| **Whisper on this PC** (default) — [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with **large-v3-turbo** | Free | Never leaves the PC | About 1 minute with the Vulkan GPU build (measured on a Radeon RX 9070 XT); about 13 minutes on a 6-core CPU | Everyday use; private lectures |
| Whisper **large-v3** ("Best" accuracy) | Free | Never leaves the PC | Several times slower than turbo | Hard-to-hear or heavily Arabic lectures |
| **Groq cloud** — `whisper-large-v3-turbo` / `whisper-large-v3` | Free tier with daily limits; needs your own key from [console.groq.com/keys](https://console.groq.com/keys) | Uploaded to Groq | Under a minute | When the PC is busy or you want it instantly |

- **Mixed Arabic/English lectures:** language **Auto** samples the beginning, middle and end of the lecture to pick the main language (Whisper otherwise decides from the first 30 seconds only), and a short bilingual prompt keeps English terms in Latin script. You can force Arabic or English, and add **course vocabulary** (drug names, anatomy terms) to improve spelling.
- A **Silero voice detector** skips silence so Whisper doesn't invent text during pauses.
- The model (874 MB for turbo, 3.1 GB for large-v3) downloads **once** on first use from the pinned [whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp) and is SHA-256-verified. Settings → **Download Whisper model now** fetches it ahead of time.
- The CPU build of whisper.cpp is bundled; CI also compiles the **Vulkan** build (AMD, NVIDIA and Intel GPUs) into the released EXE. If the GPU can't be used, the app falls back to the CPU automatically.
- Transcripts are made from the **cleaned** audio by default. Noise removal can occasionally soften quiet words; if a transcript misses things, export again with **Original audio** for comparison.
- The Groq key is stored encrypted for your Windows account (DPAPI) and is only sent to Groq.
- **Automatic quality check** (since 0.8): every transcript is audited for repetition loops, invented text and missing speech. Failing parts are re-transcribed automatically from the source audio; anything that still can't be transcribed reliably is marked `⚠` in the file and the lecture shows **Needs review** instead of "Ready for AI". Background: [transcription reliability report](docs/transcription-reliability.md).

## Command line

```powershell
npm run transcribe -- "D:\Lectures\Week 3" --out "D:\Lectures\Week 3 text"
npm run transcribe -- lecture1.note lecture2.m4a --language ar --model large-v3
$env:GROQ_API_KEY = "gsk_..." ; npm run transcribe -- lecture.m4a --engine groq
```

Run `node scripts/transcribe.mjs --help` for all options. The command line shares downloaded models with the desktop app.

## Launch

Double-click **Notakillite.exe**. The EXE contains the Windows desktop runtime, Node, FFmpeg, both neural engines/models, and the Brave connector files. No development SDK, terminal, Python, or GPU is needed for normal use.

Use **your usual Brave profile**. Account authentication stays on Notability's official website in regular Brave. The app does not collect passwords, extract cookies/tokens, or move authentication between profiles.

### One-time Brave connection

This is a **local build with an unpacked connector**. Store distribution is pending.

1. In Notakillite, choose **Connect Notability**, select your usual Brave profile, then **1. Open Brave extensions**.
2. If Brave shows a blank tab, type `brave://extensions` in its address bar. Enable Developer mode, choose **Load unpacked**, and select the folder displayed in the setup dialog: `%LOCALAPPDATA%\Notakillite\connector\extension`. The app provides Copy folder path. Verify **Notakillite Brave Connector** is visible and enabled.
3. Return to the setup dialog and press **2. Connect**. Complete Notability sign-in in regular Brave if needed. Keep its Notability tab open while browsing/downloading recordings.

The app does not enable Developer mode or force-install an extension. Once paired, future launches reconnect automatically. The connector is a communication component; the main interface is the Windows app.

App exits, closing Brave, Windows shutdown/restart, and EXE updates do not delete your session. Session renewal stays with Notability's website in Brave. Provider expiry/revocation, explicit sign-out, deleting browser site data, or browser settings that clear that data on exit can require sign-in again. Use a normal, non-private Brave profile.

The old app-owned Brave/Edge profiles remain intact. Their authentication is not copied into your usual Brave profile.

## Browse and export

- Folders/dividers/subjects, empty folders, unfiled notes, shared libraries, colors, saved sibling order, and available Notability sorting are retained. Unsupported sort metadata is labeled as a fallback.
- Search titles, folders, and loaded recording names with **Ctrl+F**. Arabic/English titles are supported. Audio only filters notes without changing the library.
- Select a note to load recordings. Select the recordings, choose a cleanup preset, and press **Export for AI**.
- Balanced cleanup uses **DeepFilterNet3**; Faster cleanup uses **RNNoise**; Original audio keeps the source unchanged when splitting is off. Advanced exposes both engines together, light cleanup, strength, and 10/20/30-minute splitting.
- Processed output is mono MP3, 24 kHz, 64 kbps. Combined cleanup takes more processing and may soften quiet speech. Denoising does not isolate a lecturer from other speakers.
- The export queue supports cancellation, retry, preview, Open folder, Copy path, and completed-history cleanup. Unverified output stays in a job-owned temporary folder. Completed source transfers are retained for retry after cancellation/failure; successful temporary work is removed.
- Import or drop local audio without a Notability connection. The current preset applies to imported files. Audio is never uploaded to an AI automatically.
- Dark, Light, and Windows themes, responsive recording panes, selected notes/folders, expanded branches, window size, cleanup choices, and output location are remembered.
- Closing during a job offers background processing in the system tray or a full quit with recoverable job state.

AAC M4A and Apple Lossless/ALAC M4A, WAV, MP3, FLAC, OGG/Vorbis, WebM/Opus, AIFF, CAF/PCM, and raw AAC are tested. Input is decoded by content, including sources with a generic `.audio` extension. Other unprotected formats depend on the bundled FFmpeg decoders. Corrupt/protected/audio-free inputs fail explicitly. Source size is limited to 2 GB.

DeepFilterNet's upstream runtime requires Microsoft Visual C++ v14. It is already available on this computer. Startup checks whether DeepFilterNet actually starts; Settings → **Repair audio runtime** downloads the installer from Microsoft's official endpoint, verifies its Microsoft signature, and opens it with automatic restart disabled. No global runtime is changed merely by launching Notakillite. The other presets remain explicit choices; an unavailable engine is never silently substituted.

This exports complete underlying recordings, including audio hidden by Notability playback trims. It does not recreate edited playback segments or export note text/video. Transcripts are produced locally (or by Groq when you choose it); nothing is uploaded to ChatGPT or Claude automatically.

## Storage, privacy, and updates

```text
%LOCALAPPDATA%\Notakillite\
  versions\<version>-<payload-hash>\   replaceable program files
  launcher\                          verified active-version pointer
  data\library.sqlite                metadata, profile pairing, preferences, jobs
  connector\extension\               stable local connector files
  bridge\                            native host and its restricted manifest
  exports\                           completed audio
  temp\                              job-owned intermediate files
  logs\                              bounded startup diagnostics
```

The selected ordinary Brave profile remains in Brave's normal data directory. It is never extracted from or embedded in the EXE. Browser profile labels/directories are used for selection; authentication contents are not copied.

The app registers its own native-messaging host for the current Windows user. Browser messages pass through a Windows pipe restricted to that user; audio processing does not require a localhost HTTP server. Only the fixed connector origin can invoke the native host, and the connector's website permission is restricted to `https://notability.com/*`.

Installing another build stages new program files and switches versions after native startup succeeds. Profile pairing, ordinary Brave session data, preferences, jobs, and exports are separate. An old compatible program version can be retained for rollback. Browser profiles are not downgraded or reset.

## Verification status

See [the current verification report](VERIFICATION.md). Synthetic tests prove local transfer/persistence behavior; they do not establish real Google/Notability authentication. Real-account sign-in/export, Windows power-cycle verification, store publication, and publisher signing are separately identified in that report.

Notability's internal web services can change. This independent adapter observes the running web app's services and preserves cached metadata when the connector is unavailable. It does not modify your Notability library. Web access requires Notability Cloud; iCloud-only notes cannot be retrieved through this adapter.

## Development

```powershell
npm ci
npm run install:engines   # pinned RNNoise, DeepFilterNet3, whisper.cpp and the voice detector
npm test
npm run build:exe
npm start
npm run test:native-ui
npm run test:native-bridge
npm run test:packaged
node scripts/brave/long-lecture-check.mjs
```

The EXE builder uses the pinned local .NET SDK in `.tools/dotnet` and verifies downloaded audio assets against pinned SHA-256 hashes. Development checks use isolated test profiles and synthetic libraries. The native-bridge check briefly registers only an app-specific QA host, then removes it.

`npm run start:legacy` and the old extension/browser scripts are retained for historical regressions; normal launch uses the native Brave app. [Legacy verification](VERIFICATION-LEGACY.md) records the earlier Edge implementation and must not be interpreted as real-account verification of the new connector.

The [design preview](design/index.html) remains a sample-data planning artifact; it does not connect or process audio. The Windows app contains the actual workflow.

## Sources and notices

- [Notability Cloud synchronization](https://support.gingerlabs.com/en-us/articles/16300145-syncing-notes-across-devices-with-notability-cloud)
- [Brave extension installation](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave)
- [Native messaging protocol](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Microsoft Visual C++ runtime](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)
- [REA repository](https://github.com/morluto/rea), [REA analysis](research/REA-NOTES.md), [adapter evidence](research/NOTABILITY-ADAPTER.md)

Notability is a Ginger Labs trademark. The app is independent. Audio runtimes/models, Node, .NET, and FFmpeg retain their upstream licenses and notices in the payload. Playwright is used for isolated engineering tests, not to control your regular Brave session.
