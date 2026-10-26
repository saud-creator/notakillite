# Feature compatibility and implementation inventory

| Feature | Treatment in this change |
|---|---|
| WPF/.NET desktop, themes, high contrast, virtualization | Preserved; settings accessible on narrow welcome view |
| Audio, .note/.zip, folders, clipboard and drag/drop | Preserved; PDF files separated from recordings; expanded archive bounds |
| Classic/RNNoise/DeepFilterNet3/hybrid/original | Preserved; Windows engines remain Windows-tested separately |
| Local Whisper, optional Groq, model selection and language | Preserved; no automatic cloud fallback; request deadlines |
| Brave connector, account/session handling | Preserved; independent browser protocol v1 |
| Numbered Markdown, batch index and audio exports | Preserved; unique owned folders and separate retry generations |
| Saved queue and interrupted jobs | Improved; chunk checkpoints and queued/active pause/resume |
| CPU and RAM policy | Quota-aware budgets, bounded dispatch, explicit controls and readiness; effective workers capped by actual serial native execution or CLI chunk count, with requested count and limiting reasons retained |
| GPU | Native CPU and dynamic backend startup verified on Windows; direct retained-worker Vulkan offload observed on one local device; CUDA and broader hardware/failure coverage remain unverified |
| Model downloads | Resume, per-process locking, cached-content hash verification and cancellation API |
| PDF assistance | Local page extraction/rendering, optional local OCR, glossary and approximate lexical references |
| PDF vocabulary bias | Experimental opt-in after measured accuracy regression; reviewed passage candidates available |
| Review/edit/export | New player/text/PDF window; autosave, raw text/history, undo/redo and manual candidate acceptance; TXT/MD/SRT/VTT/JSON; final merged recovery findings also receive timed review markers |
| Course glossary and transcript search | Added local dictionaries and timestamped FTS search |
| Language/accessibility | New controls bilingual; named review selectors/editor/timeline/list and corrected selected-item labels; existing RTL behavior retained; complete resource-based localization and Narrator QA remain pending |
| Performance and accuracy | Offline runner, public pinned corpus importer, strict/normalized WER/CER and recorded short-clip experiments |
| Packaging | Native worker build, PDF/native canvas payload, actual packaged ASR smoke and CI package gate; Windows local-only launcher forwarding/cache repair now tested; full current payload verification tracked separately |
| Study generation/translation/diarization/multi-GPU | Intentionally deferred after core acceptance |

See [Windows continuation evidence](WINDOWS-2026-10-26.md) for the hardware, actual checks, failures and acceptance limits. Windows worker cancellation/restart coverage now runs without a POSIX-only skip. The public FLEURS importer writes its Arabic manifest explicitly as UTF-8 on Windows.
