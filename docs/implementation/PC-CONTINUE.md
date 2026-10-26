# Continue on a Windows PC

Repository: https://github.com/saud-creator/notakillite
Branch: codex/desktop-lecture-pipeline-20261026-8c9fb91

## Current physical-PC state, 26 October 2026

Resume from the [Windows report](WINDOWS-2026-10-26.md) and [delivery receipt](benchmarks/windows-delivery-acceptance.json). Dependencies, pinned models, SDK and engines are already installed in this checkout; do not repeat the initial setup or reset user data. Clean production source `a12a008` built the current `release/Notakillite.exe` (210,741,760 bytes; SHA-256 `78df0321a60192134f72a05ea8d62bfd0d875638eb675a2c31290113ac4585c8`). Later reporting-only commits do not change that code. Draft PR: https://github.com/saud-creator/notakillite/pull/1.

CI run 40369164103 passed regression/native/Unicode/full-package acceptance: 109 passed, zero failed, one missing-Brave skip. The installed-Brave synthetic case passed locally. Final local CPU/MX350 native tests and eight headless jobs from the extracted EXE passed. Models Tiny/turbo are verified in both `.local/models` and the ordinary application cache. Checksums, license/component inventory and QA JSON are beside the EXE. It remains unsigned.

The user requested background tests while using the computer. Do not resume foreground interaction until the desktop is available. The isolated fault-test app may remain minimized; it uses `.local/windows-20261026/fault-data`, not the normal user profile. A slow/failing-save/close scenario was interrupted by manual activity and is inconclusive. Finish that scenario, owner shutdown, navigation, candidates/export and retry cancellation when interaction is possible.

The original 41:55 local recording/PDF has not undergone full turbo transcription in this continuation. Available RAM fell to about 1.3–2.2 GB; the configured policy requires about 5.2 GB available. Do not bypass readiness or close unrelated apps. Once sufficient memory is available, review and run the prepared ignored `.local/windows-20261026/measure-process-tree.ps1` with `.local/windows-20261026/run-private-case.mjs`/`private-case.json`. They use RNNoise, turbo, 4 threads, 60-second chunks, Vulkan and PDF bias off, block network access, support resumption and create five review exports plus SRT/VTT sidecars. Keep all private inputs/text/exports ignored. The sampler covers the owned CoreService/worker tree, excluding WPF and VRAM; do not call it a complete application memory measurement. CPU thread calibration, final NVIDIA turbo quality/performance screening, real-account Brave, Narrator/DPI, power/upgrade and signing gates remain open.

## First checkout (PowerShell)

Install Git, GitHub CLI, Node.js 24 LTS and .NET 10 SDK. For native compilation, install Visual Studio 2022 Build Tools with Desktop development with C++, CMake, and the Windows SDK. Vulkan compilation additionally needs the Vulkan SDK version specified in .github/workflows/windows.yml. Reopen PowerShell after installing tools.

```powershell
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
git clone --branch codex/desktop-lecture-pipeline-20261026-8c9fb91 https://github.com/saud-creator/notakillite.git
Set-Location notakillite
git status
node --version
dotnet --version
npm ci
npm run install:engines
npm test
dotnet build desktop/Notakillite.Desktop.csproj -c Release
```

These commands download public dependencies/models, not upload recordings. Use the real PC's authentication; never paste tokens into a prompt. Do not reset or replace an existing working checkout; clone into a new directory when in doubt.

For native worker build and packaging, follow USER-GUIDE.md and .github/workflows/windows.yml. The installer currently provides the upstream CLI; the new worker must also be built/copied beside the matching backend before testing model reuse. Do not count CLI-only tests as persistent-worker tests.

## Copy this prompt into your PC coding agent

You are continuing an existing implementation of Notakillite Windows desktop. Work in https://github.com/saud-creator/notakillite on branch codex/desktop-lecture-pipeline-20261026-8c9fb91. Preserve existing local changes and user data. Inspect repository instructions and git status before edits. Fetch the branch, record its exact HEAD, and read docs/implementation/PLAN.md, FEATURES.md, HANDOFF.md, VERIFICATION.md, USER-GUIDE.md, EVALUATION.md, benchmarks/RESULTS.md and PC-CONTINUE.md. Those files, committed benchmark JSON and logs are the durable context. Do not restart or rewrite the application.

Architecture: WPF/.NET 10 Windows x64, Node 24 CoreService, SQLite, FFmpeg/RNNoise/DeepFilterNet3, whisper.cpp, optional Groq, Brave/Notability connector. Desktop/Core protocol v2 is separate from browser protocol v1. The historical base was 4057da59ce4a6be8857a1f78fa90d4a0bba7dff9; the initial implementation commit was 8c9fb91fca13772af472962e6a153229c12fcb43. The transferred branch contains that implementation plus this handoff. Record the current branch SHA; remote transfer may use a different commit identity with equivalent content.

Already implemented: unique owned output folders including long titles; separate retry generations retaining old exports; publication records with hashes; final-audit gating; clear-completed fix; narrow welcome settings; bounded archive extraction; cached-model hash verification and resumable transfers; SQLite migration backup and FTS; effective CPU/quota/RAM planning; bounded ordered chunk dispatch, 60-second default windows with acoustic overlap; compatible per-chunk checkpoints and pause/resume; finding-centered recovery capped by attempts and total retry audio; native persistent whisper worker with actual tokenizer budget and per-worker memory/timing metrics; PDF embedded-text extraction/rendering, optional Tesseract OCR, glossary/page references; review window with original/cleaned playback, waveform/timeline, revision-safe editing/history, explicit passage retry acceptance; TXT/MD/SRT/VTT/JSON export; course vocabulary and local search; native build/package smoke/CI gate; offline benchmark and public FLEURS importers.

Evidence: Linux regression suite 100 tests, 96 passed, zero failed, four Windows/Brave-specific skips. WPF cross-build passed with zero errors/warnings. Native worker and CLI compiled and actual CPU inference ran. A short end-to-end CLI test processed public audio with a private 20-page anatomy PDF; only count/status evidence was committed. Four public English/Arabic FLEURS clips at pinned dataset revision 70bb2e84b976b7e960aa89f1c648e09c59f894dd were run three times with turbo CPU (12 runs). Six additional PDF-context screenings were recorded. These are small screening samples, not representative medical accuracy or whole-lecture benchmarks.

Critical measured decision: matching PDF vocabulary worsened one clip's WER from 10.5% to 47.4%. Therefore automatic PDF bias defaults OFF (pdfBias:false). Attached PDFs supply terms/references and explicit reviewed passage retries. Never silently enable automatic bias. The CLI --experimental-pdf-bias flag is experimental. Preserve raw ASR, timestamps, review findings, user edits and candidate acceptance guards. Never fill inaudible speech from slides or silently replace numbers, doses, negation, laterality, or nerve levels. A passed structural audit does not verify lexical accuracy. Tiny/Arabic CLI crashed in upstream whisper.cpp, including a no-VAD retry; turbo CPU completed the four-clip screening. Investigate rather than hide that failure.

Your next work, in order:
1. Reproduce the committed tests/builds on actual Windows, recording OS, hardware, commit, commands and results. Install public dependencies/pinned assets; use real local authentication. Diagnose failures rather than disabling tests. Windows-specific tests previously skipped must now execute when their prerequisites exist.
2. Build the native worker against whisper.cpp commit d1be6fde11ac6e0407606b4e42fe72d34add8037. Validate CPU, Vulkan, and optional compatible NVIDIA CUDA separately. Check actual offload and worker/model reuse, Unicode paths, cancellation, restart, deadlines, OOM/fallback and memory accounting. Use the pinned CMake/workflow configuration. Do not infer GPU use from a filename or configuration flag.
3. Build the actual EXE using npm run build:exe; run npm run test:packaged, native bridge and UI smoke commands where available. Verify bundled PDF/canvas dependencies and actual ASR in the extracted payload. Exercise review editing/autosave/conflicts, delayed retry safety, waveform, split-file seek offsets, history restore, PDF preview, search, all exports, narrow windows, high DPI, keyboard/Narrator, and original/cleaned switching. Fix findings with behavioral regressions.
4. Run controlled CPU/thread/worker/chunk experiments and GPU comparisons using the offline benchmark runner. Keep settings/model/quality constant, distinguish cold and warm runs, repeat shortlisted cases three times, and measure the whole process tree plus VRAM/UI latency. Add missing instrumentation rather than substituting Node-only RSS. Target 2x end-to-end improvement and at least 50% less recovery work, but report unmet targets honestly.
5. Run authorized 45–120-minute recordings, crash/resume, low disk, sleep/resume and upgrade/rollback acceptance. Build a representative human-reviewed Arabic/English/code-switching medical evaluation set. Public FLEURS references support initial testing only. Private proposed terminology corrections are not ground truth.
6. Complete remaining roadmap items: calibrated resource policies and memory supervision, full resource-based localization/accessibility, installer/update integrity/signing when credentials exist, storage retention, and other explicitly unfinished requirements. Keep study generation, translation, diarization and multi-GPU as later milestones.

User-specific recordings/PDFs, large models, SDKs, caches, node_modules and compiled binaries were deliberately not committed. Locate authorized local files on the PC; do not assume cloud /workspace or /tmp paths exist. Missing private inputs must not prevent independent public-fixture testing. Never upload private audio/PDF/transcripts or credentials by default. Model/dependency downloads are distinct from content uploads.

Maintain docs/implementation/VERIFICATION.md with passed/failed/unverified requirements and exact evidence, and keep PLAN.md updated. Commit focused fixes and push progress to the continuation branch after reviewing the staged diff for secrets/private content. Do not force-push, merge main, publish releases, incur charges or introduce cloud uploads without appropriate authorization. Finish each milestone with code, reproducible tests and measured results. Do not claim the entire roadmap is complete from compiler checks or the existing small benchmark.
