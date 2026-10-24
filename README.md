# Mentality

Turn Notability lecture recordings into **clean, checked, exam-ready transcripts** on your iPad or iPhone.
Built for **iPadOS 18 on iPad Pro (M4)**; also runs on **iPhone 15 Pro** (iOS 18 and later, tested on iOS 27).

Import many lectures at once → remove noise with a neural network → skip silence → transcribe Arabic, English or mixed speech with Whisper on the Neural Engine (or, if you choose, a cloud service) → automatic quality check → **one Markdown (or TXT) file per lecture**, ready for an AI to write exam questions and list what the doctor stressed.

| Step | How |
| --- | --- |
| Import | Notability → open a note → **Share** → **Note** format → **Open in Mentality**. Or **Import lectures…** from Files (`.note`, `.zip`, audio, whole folders, many at once), **paste**, or **drag** recordings onto the window. |
| Noise | **DeepFilterNet 3** (default): a state-of-the-art speech enhancement network, built into the app, that removes air conditioning, fans, traffic and chatter while keeping the voice natural. Also **RNNoise** (very fast), **Apple Voice Isolation**, a light rumble/hum filter, or off. If cleanup ever removes too much of the voice, the original audio is used automatically. |
| Silence | Long, clearly silent stretches (3 s or more near the noise floor) are skipped, with a threshold that adapts to each recording. Everything else, including quiet speech, goes to speech recognition in pieces of about 10 to 28 seconds. |
| Speech to text | **Whisper** through [WhisperKit](https://github.com/argmaxinc/argmax-oss-swift) on the Neural Engine: free, private, offline after a one-time download. Language **Auto** decides between Arabic and English for every piece (only those two compete, so Arabic is never mistaken for Persian or Urdu), for lectures that switch. Optional **cloud services** with your own API key (below). |
| Quality check | Every lecture is audited for recognition failures (one sentence repeated, invented text, text over silence, missing speech). Failing 5-minute parts are transcribed again automatically (original audio, shorter pieces, fixed language, sampling). Anything that still fails is marked **⚠** in the file and the lecture shows **Needs review**: nothing is guessed. |
| Output | `Files → On My iPad (or iPhone) → Mentality → Lectures → <date> - <name>/`: `01 - Lecture.md`, the cleaned audio, and `00 - Index.md`. **Copy text**, **Share**, or **Share all transcripts**. |

## Speech recognition models

Settings → Speech recognition. Which Whisper models a device gets comes from Argmax's device table in WhisperKit, so the app only offers what the device can run well.

| Device | Models offered | Default |
| --- | --- | --- |
| **iPad Pro (M4)** | **large-v3 turbo** (about 1.6 GB, fast, nearly as accurate as large-v3) and full **large-v3** (about 3 GB, the most accurate for Arabic and mixed lectures). Both can stay downloaded and you can switch at any time. | large-v3 turbo |
| **iPhone 15 Pro** | The same two models, compressed by Argmax to fit the iPhone's memory: large-v3 turbo (626 MB) and large-v3 (947 MB). | large-v3 turbo (compressed) |

Download models on Wi-Fi with the app open (Settings → Download now). The first start of full large-v3 takes several minutes while the Neural Engine prepares it; later starts are quick.

### Optional: cloud speech to text

For a second opinion on a hard lecture, or when you'd rather not wait, Settings → Speech to text can use a cloud service with **your own API key**:

| Service | Models |
| --- | --- |
| OpenAI | `gpt-transcribe` (recommended), `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1` |
| ElevenLabs | Scribe v2 (word timestamps, strong Arabic) |
| Groq | Whisper large-v3, Whisper large-v3 turbo (very fast) |
| Other | Any OpenAI-compatible service: enter its address, model and key |

Only speech is uploaded: silence is cut out on the device first, and noise removal and the quality check still run on the device. Your course vocabulary is sent as hints. Keys are kept in the device's Keychain and are never written into transcripts. **Save and check** sends one second of near-silence so you know the key works. The service charges your account per minute of speech. If the key is rejected or the account is out of credit, the queue stops with a clear message instead of failing every lecture.

## What a lecture file looks like

```markdown
---
title: "Abdominal wall"
course: "Anatomy week 3"
lecture: 1 of 5
duration: "00:48:10"
speech_time: "00:41:37"
language: "Arabic 72 %, English 28 %"
noise_cleanup: "DeepFilterNet 3 + rumble filter"
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

## Working in the background

- Start a batch and switch apps or lock the screen: **processing continues**, on iPadOS 18 and on newer systems. The app keeps itself running with a silent, mixable audio session (it never interrupts your music). This is fine for sideloaded apps; the App Store would not accept it.
- iPadOS stops background apps that keep the CPU busy (more than 80 % of one core over a minute). So in the background the app **paces its CPU work** (mostly noise removal) to about 45 % of one core, while speech recognition runs on the **Neural Engine** and keeps most of its speed. With the app open, everything runs at full speed. The GPU is never used, because iPadOS doesn't allow it in the background.
- **Swiping the app away** in the app switcher, or the system closing it under memory pressure, stops the work. Progress is saved every few pieces, so the lecture **continues from where it stopped** the next time you open the app.
- Settings → *Keep the screen on while working* helps very long batches when the iPad is on a charger. You get a notification when a batch is finished.

The CI runs check this on every push: the app is sent to the background in the middle of two noisy lectures and must finish both there without ever being suspended, while a control run without the keep-alive shows that the system does suspend it.

## Using the M4

- Noise removal splits each recording into up to four segments and cleans them in parallel on the CPU cores (each segment starts a few seconds early so the network has settled; the tests check that the joins match a single pass).
- Whisper transcribes **several pieces in parallel** on the Neural Engine (Settings → Performance, 4 by default).
- While one lecture is being transcribed, the **next lecture's audio is cleaned at the same time**.

## Install on your iPad or iPhone (free, no paid Apple account)

1. Download **Mentality-unsigned.ipa** from the latest successful [App workflow run](../../actions/workflows/app.yml) (Artifacts), or from [Releases](../../releases). The same file works on iPad and iPhone.
2. On a computer, install [Sideloadly](https://sideloadly.io) (Windows also needs iTunes from apple.com). Connect the device by USB.
3. Drag the `.ipa` into Sideloadly, enter your Apple ID, press **Start**.
4. On the device: **Settings → General → VPN & Device Management** → trust your Apple ID; turn on **Settings → Privacy & Security → Developer Mode** and restart.
5. Free certificates expire after **7 days**: sideload again (your lectures stay) or use Sideloadly's auto-refresh.

With a paid Apple Developer account you can instead open the project in Xcode and run it on the device.

## Build it yourself (Mac with Xcode and Rust)

```bash
bash scripts/build-noise-models.sh   # once: fetches and builds RNNoise and DeepFilterNet 3 (needs rustup)
brew install xcodegen
xcodegen generate
open Mentality.xcodeproj             # choose your team under Signing, then Run
```

## How it is tested

Every push runs the [App workflow](.github/workflows/app.yml) on GitHub's Mac runners, as two jobs:

| Job | Runner | Simulator |
| --- | --- | --- |
| iPad Pro M4 · iPadOS 18 | `macos-15`, Xcode 16 (iPadOS 18 SDK); also builds the IPA | iPad Pro 13-inch (M4), newest iPadOS 18 |
| iPhone 15 Pro · iOS 27 | `xcode-27`, Xcode 27 | iPhone 15 Pro, iOS 27 (created for the run) |

If a runner can't provide the requested system version or device, the job stops and says so instead of quietly testing something else.

Each job runs:

- **Quality check**: shared cases from the Notakillite app, including the real incident where Whisper repeated one sentence 971 times in a 42-minute lecture.
- **Pipeline**: loops are repaired from the original audio, unfixable parts become ⚠ markers, and an interrupted lecture resumes from its checkpoint.
- **Noise models**: DeepFilterNet 3 and RNNoise on real speech mixed with real noise at 5 dB: the noise must drop by more than 15 dB, the speech must stay within 3 dB and stay in time, and the parallel version must match a single pass.
- **Cloud engines**: every service against a local mock server: request format, Arabic/English handling, retries on busy servers and dropped connections, rejected keys and empty accounts stopping the queue, order kept with parallel requests. Real requests run too when the repository has `OPENAI_API_KEY`, `GROQ_API_KEY` or `ELEVENLABS_API_KEY` secrets.
- **Model choice**: iPad Pro (M4) gets both full-size large models; iPhone 15 Pro gets the compressed ones.
- **Import**: Notability `.note` exports (recordings in Notability's saved order), folders, files without extensions.
- **Real speech, end to end**: English and Arabic lectures made with text-to-speech go through DeepFilterNet, silence detection, real WhisperKit (the small "base" model, on the simulator's CPU) and the Markdown writer.
- **The app itself**: the screens and Settings (model menu, cloud option, noise cleanup), then the background test above, with screenshots.

Each run's page shows a summary with the background test's numbers and the transcripts. Screenshots, transcripts and logs are attached as artifacts.

The simulator has no Neural Engine and its speed says little about a real device, so **final acceptance is a real 40-minute Arabic/English lecture on your iPad**.

## Lessons carried over from Notakillite

This app is a fresh build informed by [Notakillite](https://github.com/saud-creator/notakillite):

- Whisper is never fed its own previous text, and every piece is transcribed independently (the cause of the 971× loop).
- Transcripts are audited before they are called ready; failing parts are retried from the original audio and otherwise marked, never silently exported.
- The queue, imported recordings and progress are stored permanently (not in temporary folders), so nothing is lost when the system closes the app.
- Import works from Files, Share and paste only; the app never talks to Notability's website.

## Credits and licenses

- [WhisperKit](https://github.com/argmaxinc/argmax-oss-swift) (MIT) and OpenAI's Whisper models (MIT).
- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) by Hendrik Schröter (MIT or Apache-2.0).
- [RNNoise](https://github.com/xiph/rnnoise) by Xiph.Org and Jean-Marc Valin (BSD-3-Clause).
- [ZIPFoundation](https://github.com/weichsel/ZIPFoundation) (MIT).
