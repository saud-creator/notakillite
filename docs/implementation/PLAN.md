# Desktop implementation tracking

Starting commit: 4057da59ce4a6be8857a1f78fa90d4a0bba7dff9. Isolated branch: desktop/lecture-pipeline. Existing processing files/data outside this checkout are preserved. No remote publication is implied.

Current continuation branch: `codex/desktop-lecture-pipeline-20261026-8c9fb91`, transferred at `0d3f760be920d196d3a5c7acb3e2e2bb626d5eba`. The [Windows continuation report](WINDOWS-2026-10-26.md) records the current baseline, fixes and remaining gates separately from the historical handoff below.

26 October Windows M1 follow-up: final merged recovery findings now produce merged timed review markers before export; raw ASR and trusted neighboring text remain available. The related Windows recovery/desktop suite passed 29/29 without skips. Complete packaged/UI acceptance remains separate.

Windows packaging follow-up: the outer launcher now forwards explicit local-only/isolated-data options with correct Windows argument quoting and repairs cached payloads missing required files. A focused launcher test passed extraction repair, readiness/current-pointer publication, Unicode paths, real WPF capture and clean exit. The build now requires Windows x64 Node 24 before writing outputs; the full package test asserts that embedded runtime.

Windows M2 follow-up: execution planning now reflects the single synchronous persistent model worker and the actual number of CLI chunks. A serial worker receives the full allowed thread budget; requested workers and limiting reasons remain in diagnostics. The complete desktop/pipeline file passed 24/24. RAM estimates/reserve and defaults were retained; calibration and process-tree supervision remain open.

| ID | Milestone | Acceptance |
|---|---|---|
| P0 | M1 output ownership, final audit, clear completed, settings | Behavioral regressions; no cross-job overwrite or false success |
| RES | M2 bounded CPU/memory policy and ordered chunk processing | Quota-aware thread budget; cancellation, checkpoint reuse, invalidation |
| REC | M2 narrow retries | Padded finding windows, whole-job/per-window budgets |
| PDF | M3 local page extraction and vocabulary retrieval | Page provenance; wrong/missing PDF fallback; no textual gap filling |
| GPU | M4 native persistent model and backend reporting | Actual offload evidence; CPU fallback; no flag-based acceleration claims |
| UI | M5 local review, editing, attach PDF, export | Revision-safe saves; timestamp playback; narrow window access |
| QA | M0/M6 accuracy/performance harness and package gates | Reproducible JSON evidence; actual Windows tests separate from Linux |

Preserve all existing import formats (.note/zip/audio/folders/clipboard), noise engines, local/Groq options, numbered Markdown/index exports, queue, Brave connector, themes, high contrast, and virtualization. Improve these incrementally. Advanced study generation, translation, diarization and multi-GPU remain deferred. Hardware auto-calibration, full localization, OCR distribution and signed updates must not be reported done without implementations and corresponding evidence.

## Milestone status at handoff

M0: feature map, public-corpus screening and harness implemented; representative domain evaluation remains open. M1: identified P0 paths fixed and regression-tested; packaged Windows verification remains open. M2: bounded chunk scheduling, checkpoints and recovery implemented; all-core calibration and full-lecture speed targets remain open. M3: PDF extraction/rendering and reviewed vocabulary implemented; automatic bias failed screening and defaults off. M4: persistent native worker built/tested on CPU; GPU hardware and full resource instrumentation remain open. M5: review/search/dictionary/waveform/history compiled; Windows interaction and full localization remain open. M6: package gate configured; remote CI, signed distribution and upgrade QA remain open.

Implementation is an incremental development delivery, not completion of all roadmap acceptance gates. See VERIFICATION.md for specific evidence and unfinished requirements.
