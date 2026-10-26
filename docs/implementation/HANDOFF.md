# Implementation handoff

Base: 4057da59ce4a6be8857a1f78fa90d4a0bba7dff9. Apply the accompanying patch to a clean checkout or inspect the provided source archive. The implementation branch is desktop/lecture-pipeline. Private recordings, PDFs, derived transcripts, credentials, models, caches, node_modules and build outputs are excluded from the source delivery.

Start with USER-GUIDE.md, VERIFICATION.md and benchmarks/RESULTS.md. The native worker builds against pinned upstream whisper.cpp without modifying it. Windows CI builds its Vulkan variant and now gates publication on packaged audio, actual ASR, PDF dependencies and durable history checks. That workflow was configured but not run remotely here. Run actual Windows and GPU acceptance before distributing an executable.

Important measured decision: default PDF assistance provides glossary/page references and reviewed retry suggestions. Automatic prompt bias is developer opt-in after a screening regression. It must not become the default merely because the pipeline completes successfully.

Known limitations: no full Windows UI execution, GPU measurements, representative medical/code-switching corpus, complete localization, signed update system, or full-length before/after ASR benchmark in this environment. The earlier target of 2× whole-job speedup is not established. Tiny/Arabic failed an upstream CLI case; turbo CPU passed the four-clip screening.

The continuation branch is codex/desktop-lecture-pipeline-20261026-8c9fb91. See PC-CONTINUE.md for checkout commands and the complete continuation prompt. No release or private-content upload is included.
