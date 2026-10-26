# Desktop implementation verification

Historical starting commit: `4057da59ce4a6be8857a1f78fa90d4a0bba7dff9`. The original development environment was Linux x86-64 with an effective CPU quota of 2 and no supported physical GPU exposed. Publication had not occurred during those historical tests; the implementation was subsequently transferred to GitHub as `0d3f760be920d196d3a5c7acb3e2e2bb626d5eba` on `codex/desktop-lecture-pipeline-20261026-8c9fb91`. No private audio/PDF was uploaded. The full roadmap is not complete and this is not a verified Windows release.

Windows continuation results are recorded separately in [the 26 October 2026 report](WINDOWS-2026-10-26.md). The sections below preserve the original Linux evidence and its limitations.

The current unsigned Windows candidate was built from clean `a12a008`; its [delivery receipt](benchmarks/windows-delivery-acceptance.json) links the actual EXE hash, native CI artifacts and physical CPU/MX350 checks. [Source CI](https://github.com/saud-creator/notakillite/actions/runs/40369164103) passed 109 tests with zero failures and one missing-Brave skip, then passed actual packaged ASR/audio/PDF/cache-repair/WPF startup checks. The final local extracted EXE passed eight headless codec/engine jobs and native-file identity checks. The local full suite's memory rejection, private full-lecture processing, interrupted foreground fault testing and remaining account/accessibility/power/signing gates are documented explicitly in the Windows report.

## Passed and measured

- Node regression suite: 100 tests; 96 passed; zero failed; four explicitly skipped Windows/Brave runtime cases. Includes actual local tiny/English transcription, audio/container processing, final quality gating, checkpoint reuse/invalidation, output ownership and long-title collisions, preserved prior exports on retry, SQLite migration/backup, revision races, cancellation/restart, actual PDF extraction/rendering, and default-off PDF bias. Synthetic worker cancellation uses local child processes; this sandbox requires the local networking allowance for Node subprocess tests.
- WPF/.NET 10 cross-build: succeeded with zero errors and zero warnings. This checks C#/XAML compilation; it does not execute Windows UI interactions.
- Native worker and whisper-cli CMake targets: compiled successfully against pinned upstream source. Actual CPU inference and model tokenization ran locally. An initial worker smoke and short-sample comparison produced transcripts; metrics are in the benchmark directory.
- Public corpus acquisition: four English/Arabic FLEURS test clips, pinned dataset revision and source hashes. Twelve turbo CPU runs completed. Six PDF-context screening runs completed. See [measured results](benchmarks/RESULTS.md).
- End-to-end CLI smoke: a public audio clip plus the private 20-page lecture PDF completed RNNoise, native tiny CPU inference, structured transcript and verified publication. Only count/status evidence is retained; the PDF and its extracted text are excluded.
- No model-generated text was used as ground truth. Strict and normalized metrics are reported separately. Private lecture corrections remain outside the repository.

## Implemented with limited validation

- M1: isolated output ownership, retry generations preserving prior exports, final merged-audit gating, clear-completed fix, welcome-screen settings access, archive extraction limits, disk/source checks, migration backups and final publication records with hashes.
- M2: effective CPU/memory policies, bounded ordered chunk processing, source/settings/context checkpoints, pause/resume and narrow bounded recovery. Single-job processing remains the default. This does not establish optimal thread counts on all hardware, a hard native allocator limit, or 2× whole-lecture acceleration.
- M3: embedded PDF text, page rendering, suggested glossary and approximate references; optional local Tesseract OCR integration. Automatic PDF vocabulary bias is experimental and disabled by default after an observed WER regression. Reviewed passage retry is implemented; accuracy improvement is not established.
- M4: persistent native model worker, tokenizer-based context budget, backend discovery paths, conservative actual-device reporting and CLI fallback. The Windows build workflow includes the Vulkan worker. CUDA is a compile-time optional backend, not a tested distributed package. Native per-worker RSS/inference instrumentation is available; whole-process-tree peak RAM and VRAM instrumentation remains incomplete.
- M5: compiled review workspace with playback, PDF preview, editing/history, explicit retry acceptance, multiple export formats, course vocabulary, local text search and readiness/resource dialogs. New controls are bilingual. Full application localization, automated Windows accessibility verification remain unfinished. Waveform seeking and revision restore are implemented and compiler-checked, but have not been exercised on Windows.
- M6: actual packaged ASR/PDF-dependency smoke and package CI gate configured. The workflow has not been executed remotely in this session.

## Failed or unverified gates

- PDF-guided accuracy improvement failed the small screening case. Do not enable automatic bias by default. A broader human-reviewed domain/code-switching corpus is still required.
- Tiny/Arabic CLI crashed in upstream whisper.cpp on a public clip. A retry without VAD also failed. Turbo CPU completed the four-clip screening; that is not a blanket support statement for all models/languages.
- No physical Windows GUI, packaged EXE execution, Narrator/DPI usability session, Brave account workflow, update/rollback exercise, sleep/resume test, or 45–120-minute actual ASR soak was performed here.
- No GPU acceleration/VRAM benchmark, cross-vendor validation, automatic backend calibration, multi-device scheduling or signing test was possible. No 2× end-to-end speedup claim is established.
- Optional OCR engine/language packs were not installed or exercised; warnings/fallback and embedded-text PDFs were tested.
- Source validation and full publication atomicity are application-level: consumers must use the final per-job completion record, not infer success from individual files appearing during publication.
- Signed installer/update distribution, extensive retention controls, a full adapter-based UI/core refactor and optional study tools remain roadmap work.

## Reproduction

Install dependencies with `npm ci`, install pinned audio/Whisper assets, and provide the required models. Run `npm test` on Windows. For this Linux sandbox use:

```sh
NOTAKILLITE_MODELS_DIR=/path/to/models node --experimental-vm-modules --test --test-isolation=none --test-concurrency=1 tests/*.test.mjs
```

Use `dotnet build desktop/Notakillite.Desktop.csproj -p:EnableWindowsTargeting=true` for a compiler-only cross-check. Build the native targets as described in USER-GUIDE.md. Run the benchmark importer/runner from EVALUATION.md. Logs accompanying the delivery provide the executed commands' output; repeat Windows/GPU gates on the actual target hardware before release.
