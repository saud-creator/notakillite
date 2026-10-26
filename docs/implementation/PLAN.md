# Desktop implementation tracking

Starting commit: 4057da59ce4a6be8857a1f78fa90d4a0bba7dff9. Isolated branch: desktop/lecture-pipeline. Existing processing files/data outside this checkout are preserved. No remote publication is implied.

Current continuation branch: `codex/desktop-lecture-pipeline-20261026-8c9fb91`, transferred at `0d3f760be920d196d3a5c7acb3e2e2bb626d5eba`. The [Windows continuation report](WINDOWS-2026-10-26.md) records the current baseline, fixes and remaining gates separately from the historical handoff below.

26 October Windows M1 follow-up: final merged recovery findings now produce merged timed review markers before export; raw ASR and trusted neighboring text remain available. The related Windows recovery/desktop suite passed 29/29 without skips. Complete packaged/UI acceptance remains separate.

Windows packaging follow-up: the outer launcher now forwards explicit local-only/isolated-data options with correct Windows argument quoting and repairs cached payloads missing required files. A focused launcher test passed extraction repair, readiness/current-pointer publication, Unicode paths, real WPF capture and clean exit. The build now requires Windows x64 Node 24 before writing outputs; the full package test asserts that embedded runtime.

Windows M2 follow-up: execution planning now reflects the single synchronous persistent model worker and the actual number of CLI chunks. A serial worker receives the full allowed thread budget; requested workers and limiting reasons remain in diagnostics. The complete desktop/pipeline file passed 24/24. RAM estimates/reserve and defaults were retained; calibration and process-tree supervision remain open.

Windows M4 follow-up: direct testing of the CI Vulkan worker exposed missing dynamic backend initialization (`devices=0`, `backends=0`, assertion before inference), which CLI fallback could hide. The wrapper now loads pinned ggml backends before model initialization. Actual direct GPU-required and dynamic CPU worker checks passed on this PC, including model retention/cancellation. CI now requires a direct CPU worker check using its dynamic Vulkan bundle; this is distinct from packaged CLI success. Final committed-source GPU timing and broader device/failure coverage remain open.

Windows M5 follow-up: actual review-window interaction exposed selected source/PDF values rendered as record details instead of labels. The shared ComboBox selection template now honors the item template selector/string format; review selectors have bounded widths and seven controls have bilingual accessibility names. SDK build passed with zero warnings/errors; final package interaction recheck follows. A real synthetic-job edit autosaved as revision 2 with history and raw text retained.

A second observed M5 issue left the review label at `unreviewed` after a successful edit had been saved as `edited`. The label now refreshes from the server document after save/history restore/candidate discard; error and retry-pending messages remain intact. Compiler verification passed; actual rebuilt UI interaction is required before closing the gate.

Passage retry now joins processed split files before applying global transcript timestamps when a retained/local original is unavailable. Regression coverage verifies a cross-file passage, a passage wholly in part two, original-source preference, stale revisions and a missing part without transcript mutation; the related Windows suite passed 25/25. ASR still receives only the selected interval; assembling processed parts can require decoding the full recording first.

Windows native follow-up: real retained-worker tests now exercise VAD off/on, actual GPU selection and bounded cancellation. The current GPU smoke selected NVIDIA MX350 (`Vulkan1`); earlier `Vulkan0` measurements used Intel UHD 750. The CLI UTF-8 manifest passes Arabic/Japanese model, input and output paths. CI builds pinned CPU and Vulkan bundles and tests the standalone selection policy. Actual VAD state/device names are retained in diagnostics and checkpoint version 3.

Windows review durability follow-up: pending edits/history mutations now participate in serialized save and owner-close barriers; failed saves retain text, newer edits are saved after the pending request, selection tokens prevent stale navigation, and passage retries have job-scoped cancellation registered before asynchronous validation. These paths require rebuilt-window interaction/fault testing in addition to compiler and core regressions. The package now contains the user guide and an embedded source/runtime receipt, with verification links pointing to that source revision.

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
