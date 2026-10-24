# Transcription reliability (P0): repetition loops and silent transcript corruption

**Status:** fixed in 0.8 (Windows app). iPhone/iPad port of the quality check: pending (separate work).
**Severity:** P0 — corrupted transcripts were exported as "Ready for AI", so students could lose lecture content without noticing.

## Incident

| | |
|---|---|
| Lecture | L1 – Anatomy of Anterior Abdominal Wall – I (41 min 54 s), from the Notability web library |
| Pipeline (0.7.0, Windows) | DeepFilterNet3 → MP3 → 16 kHz WAV → whisper.cpp large-v3 (Vulkan GPU), one call for the whole file, voice detection on |
| Symptom | From 00:03:57 one sentence ("So deep membranous fascia is called fascia of the thigh.") repeats **971×** until 00:40:51 — **95 % of the 10,205 words**. The job was marked "Ready for AI". |

## Root cause (confirmed)

Investigated on the user's own export (cleaned MP3) with the installed 0.7.0 binaries. Every row is a full 42-minute run with large-v3 on the same GPU build:

| Settings | Words | Result | Words per 5-min block |
|---|---|---|---|
| 0.7.0 app run | 10,205 | sentence ×971 from 03:57 | — |
| voice detection + previous-text context (0.7.0 setting), ×2 | 7,392 (identical) | hidden corruption: 183 zero-length segments, blocks 7–8 inflated ×3 | 574 589 611 636 608 632 **1680 1675** 387 |
| context limited to 64 tokens | 8,273 | sentence ×542 | — |
| independent 5-min pieces, context on | 7,145 | sentence ×243 inside one piece | — |
| no voice detection + context, ×2 | 17,414 (identical) | sentence ×2,079 from ~05:00 | 655 1712 2344 2256 2384 … |
| **no voice detection, context off (`-mc 0`)** | 4,551 | **clean** | 520 469 599 582 589 517 522 568 185 |
| **voice detection, context off (`-mc 0`)** | 4,678 | **clean**, 96 s instead of 188–338 s | 490 502 555 595 640 495 566 644 191 |

1. **Not an audio problem.** The cleaned MP3 has speech-level loudness (−17 to −24 dB RMS) in every 30-second window of the 42 minutes, and fresh runs transcribe 04:00+ correctly.
2. **Not a chunking/merging bug.** 0.7.0 ran one whisper-cli call over the whole file (no chunks, offsets or overlap); timestamps kept advancing while the text was stuck.
3. **Cause: whisper.cpp previous-text conditioning.** It feeds the last ≤ 224 decoded tokens (`prompt_past1`, `src/whisper.cpp` at the pinned commit `d1be6fde`) into every new 30-second window. Its only loop guard (`entropy_thold`) checks outputs longer than 32 tokens, so a ~12-token sentence passes. Once a sentence repeats, the context is filled with it and re-primes every later window. With context on, 6 of 6 runs looped or were corrupted; with it off, 0 of 2. Smaller windows or independent pieces don't prevent it.
4. **Context off does not lose speech.** Per-block word counts with `-mc 0` match the healthy blocks of context runs (≈ 500–640 words per 5 minutes); the extra words in context runs were the repetition. Text quality was spot-checked equal or better. It is also 2–3× faster.
5. **Deterministic per input.** Identical input and settings give identical output; the 0.7.0 run differed from the reproductions only through resampling (ffmpeg → WAV vs. whisper-cli's MP3 decoder). Tiny input differences decide whether a loop starts — so it can hit any lecture.
6. **Secondary bug found:** whisper-cli's `-ot` offset combined with `--vad` counts time on the silence-removed timeline (asking for 14:00 returned text labelled 16:52). Never use it to re-transcribe a part; cut the audio instead.
7. **No safety net.** Quality was never checked; any finished run was "Ready for AI", and the original (pre-cleanup) audio was deleted, so nothing could be re-processed or compared.

**Not confirmed (hypotheses):** DeepFilterNet3 artifacts may raise the trigger rate — untestable on this file because its original audio wasn't kept; 0.8 keeps it and compares when a part fails. Groq (independent 10-minute requests) and WhisperKit on iPhone/iPad (no previous-text conditioning, built-in compression-ratio fallback) are structurally less exposed.

## Fix (0.8)

| Area | Change | Code |
|---|---|---|
| Decoding | Previous decoded text is never fed back: `-mc 0`; with course vocabulary the prompt is carried as a fixed prefix and the context budget is (prompt words + 1), leaving no room for decoded tokens. The default English prompt was removed. | `companion/whisper.mjs` `contextArgs`, `whisperArgs` |
| Quality audit | Repetition (identical/near-identical sentences, back-to-back or ≥ 4× in 2 min; lecturer emphasis and short phrases allowed), vocabulary diversity per 300 words, one sentence dominating a 5-min part, compression ratio, repeated phrases inside a segment, text on zero-length segments, speaking rate over 10-s windows, words per minute of speech, text over silence, speech without text, identical text from two parts. Thresholds in `QUALITY_DEFAULTS`. | `companion/transcript-quality.mjs` |
| Recovery | Only failing ~5-minute parts (cut in pauses) are re-transcribed, from cut audio with absolute timestamps: different speech detection → **original (un-cleaned) audio** → different boundaries → CPU build → large-v3-turbo (if downloaded). ≤ 4 attempts per part and at most the lecture's length re-processed in total, so it always ends. The best-validating version is kept; neighbours are untouched. | `companion/transcribe.mjs` `transcribeAudio`, `recoveryStrategies` |
| Merging | Chronological order enforced; only exact decoder duplicates (same text and time) are merged. Nothing else is removed. | `assemble` |
| Unrecoverable parts | Replaced by a visible `⚠ Not reliably transcribed (hh:mm:ss–hh:mm:ss) — check the audio` marker. Never a guessed or de-duplicated continuation. | `transcribeAudio`, `transcript-format.mjs` |
| Quality gate | "Ready for AI" only for `ok` / `repaired`. Otherwise the job ends as **Needs review** (orange ⚠) with *Retry from original* and *Copy diagnostics*; the source audio is kept for the retry. Transcript header gets `quality:`, the index a Quality column. | `core/service.mjs`, `desktop/*` |
| Diagnostics | Per-job JSON lines in `%LOCALAPPDATA%\Notakillite\logs\jobs\<job>.jsonl`: source duration/sample rate, part boundaries with SHA-256 of their audio, speech seconds, decoding settings, audit findings, every retry and its result, merges, final verdict. No audio and no transcript text. | `CoreService.jobLog` |

## Tasks

| Task | State |
|---|---|
| Root-cause analysis on the real recording | done (above) |
| Audio preprocessing reliability: keep original audio, compare on failure | done (Windows) |
| Speech activity: silence map → speech intervals; text-over-silence and missing-text checks | done |
| Chunking and timestamp correctness: cut audio (no `-ot`), absolute offsets, ordering assertion | done |
| Whisper decoding configuration: no text feedback | done |
| Hallucination/repetition detection | done |
| Automated recovery and fallback (bounded) | done (Windows) |
| Transcript quality scoring and gate | done |
| User-visible failure reporting | done (Windows); iPhone/iPad pending |
| Regression tests | done: `tests/transcript-quality.test.mjs`, `tests/transcription-recovery.test.mjs`, `shared/fixtures/quality-cases.json` |
| Performance test on the real lecture | see Verification |
| iPhone/iPad: Swift port of the audit + gate (shared fixtures) | pending |

## Regression tests

Synthetic fixtures only (`tests/fixtures/lecture.mjs`) — no lecture content in this public repository. Covered: the 971-repeat incident shape; short and long silence; lecturer repetition kept; low-volume (slow) speech; Arabic–English code-switching and medical terms; zero-length segments and 3× output (hidden corruption); text over silence and speech without text; duplicate audio/identical parts; repeated phrases inside a segment; exact-duplicate merging and ordering; no text feedback in any Whisper call; parts re-transcribed with absolute timestamps and neighbours unchanged; original-audio fallback; retry exhaustion → needs review with markers and bounded runs; random engine failures still terminate; the service-level gate and retry-from-original.

## Additional defects found while verifying

| Defect | Effect | Fix |
|---|---|---|
| Pause detection read only the last 20 KB of ffmpeg's output (`spawnLines` keeps a bounded stderr). | A 42-minute lecture lost almost all pauses; Groq uploads (since 0.6) were cut at fixed 10-minute marks instead of in pauses. | `detectSilences` parses lines as they stream (`companion/groq.mjs`). Test: 45 min of beeps → > 1,300 pauses. |
| Fixed −35 dB pause threshold. | Cleaned, loudness-normalised lectures have pauses at −37 to −42 dB with short peaks above −35 dB: zero pauses found. | Adaptive threshold: 6 dB above the recording's noise floor (10th percentile of 0.1-s levels), clamped to −60…−25 dB. On the incident lecture: 831 pauses, threshold −34.5 dB. |
| Whisper end-of-recording hallucination "Subtitles by the Amara.org community" (seen in a re-transcribed final part). | Invented credit line at 41:51. | Known Whisper artifacts are removed only when they are a *whole* segment, logged, and stated in the quality line. |
| Re-transcribing with `-ot` under `--vad` | Wrong timestamps (silence-removed timeline). | Parts are cut with ffmpeg; offsets added explicitly; test asserts absolute timestamps. |

## Verification on the real lecture

Local only (the lecture is not committed). 0.8 pipeline via `scripts/transcribe.mjs`, large-v3, Vulkan build, Radeon RX 9070 XT, source = the 0.7.0 cleaned MP3.

| | 0.7.0 | 0.8 |
|---|---|---|
| Quality verdict | none ("Ready for AI") | **ok** on the first pass; no retries needed |
| Audit of the 0.7.0 export / of the deterministic loop reproduction | — | both **failed**, every 5-minute part flagged |
| Audit of a clean `-mc 0` run | — | only a genuine 9× back-to-back mini-loop ("This is the gluteal muscle.") flagged |
| Words | 10,205 (95 % one sentence) | 4,696; most-repeated sentence of ≥ 5 words: 2× |
| Words per 5-min block | — | 634 472 665 493 677 471 514 585 185 |
| Timestamps | — | chronological, 56 paragraphs |
| Pauses / parts | — | 831 pauses (−34.5 dB); parts cut at 5:01, 10:00, 14:59, 19:59, 24:58, 29:58, 34:58, 39:58 |
| Time, 42-min lecture | ~7 min | **2 min 17 s** (incl. language detection, pause map, audit) |

An earlier 0.8 run (before the adaptive pauses) flagged the final part, re-transcribed it once with different speech detection, and finished as `repaired` — the recovery path working on real audio.

## Remaining limitations

- The audit catches repetition, timing and coverage failures; it cannot know whether individual words are right (e.g. medical terms misheard). Course vocabulary helps; a human or the AI step should still sanity-check key terms.
- Original-vs-cleaned comparison happens only when a part fails; whether DeepFilterNet3 raises the loop rate is still unmeasured.
- iPhone/iPad: the Swift port of the audit and gate is pending (shared fixtures are ready in `shared/fixtures/quality-cases.json`).

Reproduce the investigation: see the experiment table above; commands use `whisper-cli` from `%LOCALAPPDATA%\Notakillite\versions\<version>\vendor\whisper\vulkan` with `-mc 0` vs. default and `--vad` on/off.
