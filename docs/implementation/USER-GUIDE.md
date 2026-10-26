# Updated desktop workflow

1. Open import settings using the details/settings button, including on the welcome screen. Choose Fast, Balanced, Accuracy or Custom and check readiness. Existing cleanup choices remain available.
2. Attach lecture PDFs or select audio and PDFs together. All selected PDFs apply to the recordings in that import; review the attachment count and use Clear PDFs to reset it. Local audio processing does not require Brave.
3. Choose Automatic, Background or Maximum resource policy. Automatic leaves one effective CPU available on larger allocations. More workers can duplicate model memory and are advanced CLI controls, not a guaranteed speedup. The current persistent native model processes requests serially, so its effective worker count is one and it receives the full permitted thread budget. CLI-only chunk processing can use multiple workers up to the available chunks/CPU/RAM budget. Diagnostics retain the requested worker count and explain a limit.
4. Import the recording. Pause waits for the next stage/chunk checkpoint; Cancel aborts owned processing. Resume reuses verified compatible chunks, while cleanup may rerun. Changing model, audio, context or processing settings invalidates incompatible checkpoints.
5. Open Review from a completed or needs-review job. Select a passage to seek, switch original/cleaned source, adjust speed, seek on the waveform/timeline, inspect revision history and PDF pages and approximate references, and edit text. Edits autosave; Ctrl+Z/Ctrl+Y provide editor undo/redo. Raw text and revision history remain intact.
6. Retry passage produces a candidate, optionally guided by the attached PDF glossary. Listen before accepting with Save. Candidates do not autosave and must be saved or discarded before export, navigation or closing. No slide sentence fills inaudible audio.
7. Export the selected revision to text, Markdown, captions or JSON. Caption exports have a review sidecar. Existing automatic Markdown remains unchanged by review edits, so export the revised version explicitly.

PDF bias is disabled by default because a controlled experiment increased WER. The PDF still supplies suggested terms, preview pages and approximate text matches. `--experimental-pdf-bias` enables unvalidated initial prompt bias for developer comparisons only.

Scanned PDFs can use optional local Tesseract with `ara` and `eng` language packs. Enable OCR before import. Missing OCR produces a warning and audio-only operation. This change does not bundle Tesseract or claim scanned-PDF accuracy.

CLI example:

```sh
node scripts/transcribe.mjs lecture.m4a --pdf slides.pdf --cleanup rnnoise --model turbo --language auto --resources auto --chunk-seconds 60 --out results
```

Advanced options: `--threads N`, `--workers N`, `--backend auto|cpu|vulkan|cuda`, `--ocr`. CUDA requires a separately compiled compatible backend. Native worker build:

```sh
cmake -S native/worker -B .local/native-build -DWHISPER_SOURCE=/path/to/pinned/whisper.cpp -DCMAKE_BUILD_TYPE=Release
cmake --build .local/native-build --config Release --target notakillite-worker whisper-cli
```

Pin whisper.cpp to `d1be6fde11ac6e0407606b4e42fe72d34add8037`. Test a developer worker using `NOTAKILLITE_WORKER`; packaged builds discover workers beside their backend executables. The worker keeps one model loaded and uses its tokenizer to bound vocabulary to 96 tokens. CPU fallback retains the selected model.

For a CPU-only Windows build, explicitly add `-A x64 -DBUILD_SHARED_LIBS=ON -DGGML_VULKAN=OFF -DGGML_CUDA=OFF -DGGML_NATIVE=OFF -DWHISPER_SDL2=OFF` to configuration. Use the installed Visual Studio CMake executable if CMake is not on PATH. Keep the resulting worker, matching CLI and DLLs together; do not mix DLLs from different builds. With the pinned Tiny model already downloaded, run the offline native acceptance check:

```powershell
$env:NOTAKILLITE_MODELS_DIR = "$PWD\.local\models"
node scripts/test-native-worker.mjs .local/native-cpu/bin/Release/notakillite-worker.exe .local/native-worker-report.json
```

This checks actual inference, retained model reuse, Unicode paths, the tokenizer budget, cancellation and restart. Its memory measurement covers the worker alone. It does not establish Arabic/medical accuracy or GPU support. If a project-local SDK exists under `.tools/dotnet`, restore the desktop project with that SDK before its first build; a runtime-only system `dotnet` cannot build WPF. Low available memory can intentionally reject a processing job; finish idle development builds before comparing memory-sensitive runs.

The packaged launcher accepts `--no-connect` and an explicit `--data-dir` for isolated local-only use. For example, `release\Notakillite.exe --data-dir "$PWD\.local\desktop-qa" --no-connect` uses separate QA data and does not prepare the Brave connector. Without an explicit data directory, the existing `%LOCALAPPDATA%\Notakillite` location is retained. The build requires Windows x64 Node.js 24 so it cannot silently bundle a different runtime. `npm run test:packaged` includes ordinary launcher startup and repair of a cached extraction missing its Node executable, in addition to audio/ASR/PDF checks.

Keep API keys local; no private recording was uploaded during development. A passed automated audit does not mean every spoken word or critical number was verified. Tiny/Arabic had an upstream crash in public screening; use the tested turbo profile until that combination is resolved.
