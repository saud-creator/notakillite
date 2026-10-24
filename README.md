# Mentality for iPad

Turn Notability lecture recordings into **clean, checked, exam-ready transcripts**, entirely on your iPad.
Built for **iPadOS 18** and tuned for **iPad Pro M4**.

Import → remove noise → skip silence → transcribe Arabic, English or mixed speech with Whisper on the Neural Engine → automatic quality check → **one Markdown (or TXT) file per lecture** that you give to an AI to write exam questions.

| Step | How |
| --- | --- |
| Import | Notability → open a note → **Share** → **Note** format → **Open in Mentality**. Or **Import lectures…** from Files (`.note`, `.zip`, audio, whole folders, many at once), **paste**, or **drag** files onto the window. |
| Noise | **Apple Voice Isolation** (on-device machine learning, removes air conditioning, fans and chatter) plus a rumble/hum filter. If cleanup ever removes too much of the voice, the original audio is used automatically. |
| Silence | Pauses are found with a threshold that adapts to each recording, and only speech is sent to Whisper (it invents text on silence). |
| Speech-to-text | **Whisper large-v3** or **large-v3 turbo** through [WhisperKit](https://github.com/argmaxinc/argmax-oss-swift), on the Neural Engine. Free, private, offline after a one-time download. Language **Auto** detects Arabic or English every 30 seconds, for lectures that switch. |
| Quality check | Every lecture is audited for Whisper failures (one sentence repeated, invented text, text over silence, missing speech). Failing 5-minute parts are re-transcribed automatically (original audio, shorter pieces, fixed language, sampling). Anything that still fails is marked **⚠** in the file and the lecture shows **Needs review**: nothing is guessed. |
| Output | `Files → On My iPad → Mentality → Lectures → <date> - <name>/`: `01 - Lecture.md`, the cleaned audio, and `00 - Index.md`. **Copy text**, **Share**, or **Share all transcripts**. |

## What a lecture file looks like

```markdown
---
title: "Abdominal wall"
course: "Anatomy week 3"
lecture: 1 of 5
duration: "00:48:10"
speech_time: "00:41:37"
language: "Arabic 72 %, English 28 %"
transcribed_with: "Whisper large-v3 turbo (WhisperKit, on-device) on iPad"
quality: "ok — passed the automatic quality check"
---

# Abdominal wall

## Instructions for the AI
> … list what the lecturer stressed, then write MCQs and short-answer questions …

## Lecturer emphasis (auto-detected)
- 🎯 exam **[00:12:05]** وهذا مهم جداً للامتحان، الـ inguinal ligament …
- ❗ stressed **[00:31:40]** Remember the boundaries of the inguinal canal.

## Transcript
**[00:00:00]** اليوم نتكلم عن the anterior abdominal wall …
```

The instructions are editable in Settings, and you can switch to plain `.txt` or both.

## Working in the background (iPadOS 18): what to expect

- Start an import and switch apps or lock the iPad: **processing continues**. The app keeps itself running with a silent, mixable audio session (it never interrupts your music). This is allowed for sideloaded apps; the App Store would not accept it.
- iPadOS **does not allow the GPU in the background**, so the app never uses it: Whisper runs on the **Neural Engine** and audio cleanup on the **CPU** all the time. That is also the fastest place for Whisper on M4.
- **Swiping the app away** in the app switcher, or iPadOS closing it under memory pressure, stops the work. Progress is saved every few pieces, so the lecture **continues from where it stopped** the next time you open the app.
- Settings → *Keep the screen on while working* (on by default) helps very long batches when the iPad is on a charger.
- You get a notification when a batch is finished.

## Using the M4

- One lecture is transcribed at a time on the Neural Engine, with **several pieces in parallel** (Settings → Performance, 4 by default; up to 8).
- While one lecture is being transcribed, the **next lecture's audio is cleaned at the same time** on the CPU.
- Model choice: **large-v3 turbo** (default, ~1.6 GB) is close to large-v3 accuracy and several times faster. **large-v3** (~3 GB) is the most accurate for Arabic; its first start takes several minutes while iPadOS prepares it for the Neural Engine. Download models on Wi-Fi with the app open (Settings → Download now).

## Install on your iPad (free, no paid Apple account)

1. Download **Mentality-unsigned.ipa** from the latest successful [iPad app workflow run](../../actions/workflows/ipad.yml) (Artifacts), or from [Releases](../../releases).
2. On a computer, install [Sideloadly](https://sideloadly.io) (Windows also needs iTunes from apple.com). Connect the iPad by USB.
3. Drag the `.ipa` into Sideloadly, enter your Apple ID, press **Start**.
4. On the iPad: **Settings → General → VPN & Device Management** → trust your Apple ID; turn on **Settings → Privacy & Security → Developer Mode** and restart.
5. Free certificates expire after **7 days**: sideload again (your lectures stay) or use Sideloadly's auto-refresh.

With a paid Apple Developer account you can instead open the project in Xcode and run it on the iPad.

## Build it yourself (Mac)

```bash
brew install xcodegen
xcodegen generate
open Mentality.xcodeproj      # choose your team under Signing, then Run on your iPad
```

## How it is tested

Every push runs the [iPad app workflow](.github/workflows/ipad.yml) on a GitHub macOS runner with Xcode 16 (iPadOS 18 SDK), on an **iPad Pro 13-inch (M4) simulator with iPadOS 18**:

- **Quality check**: the same shared cases as the Notakillite Windows app, including the real incident where Whisper repeated one sentence 971 times in a 42-minute lecture.
- **Pipeline**: a scripted engine proves that loops are repaired from the original audio, that unfixable parts become ⚠ markers, and that an interrupted lecture resumes from its checkpoint.
- **Import**: Notability `.note` exports (recordings in Notability's saved order), folders, files without extensions.
- **Audio**: decoding, cleanup and 16 kHz conversion for every cleanup mode.
- **Real speech, end to end**: English and Arabic lectures spoken by macOS text-to-speech go through cleanup, silence detection, real WhisperKit (small "base" model on the simulator CPU) and the Markdown writer. The produced transcripts are printed in the workflow log.
- Screenshots in light and dark mode, and the unsigned `.ipa`.

The simulator has no Neural Engine, and Voice Isolation may be missing there, so the tests never depend on them. **Final acceptance is a real 40-minute Arabic/English lecture on your iPad.**

## Lessons carried over from Notakillite

This app is a fresh iPad build informed by [Notakillite](https://github.com/saud-creator/notakillite):

- Whisper is never fed its own previous text, and every piece is transcribed independently (the cause of the 971× loop).
- Transcripts are audited before they are called ready; failing parts are retried from the original audio and otherwise marked, never silently exported.
- The queue, imported recordings and progress are stored permanently (not in temporary folders), so nothing is lost when iPadOS closes the app.
- Import works from Files, Share and paste only; the app never talks to Notability's website.
