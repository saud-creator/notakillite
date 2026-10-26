# Desktop implementation tracking

Starting commit: 4057da59ce4a6be8857a1f78fa90d4a0bba7dff9. Isolated branch: desktop/lecture-pipeline. Existing processing files/data outside this checkout are preserved. No remote publication is implied.

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
