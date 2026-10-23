# Notakillite for iPhone

The same flow as the Windows app, on the phone: **import → remove background noise → transcribe → one Markdown file per lecture** for ChatGPT or Claude.

| Step | How it works on iPhone |
| --- | --- |
| Import | Notability → **Share** → **Note** format → **Open in Notakillite**; or **Import lectures…** (Files: `.note`, `.zip`, audio, folders); or **Paste from clipboard**. |
| Noise cleanup | **Apple Voice Isolation**, the on-device machine-learning noise remover built into iOS (no download). Falls back to the original audio where it isn't available. |
| Speech-to-text | **Whisper on this iPhone** with [WhisperKit](https://github.com/argmaxinc/argmax-oss-swift) (Core ML, Neural Engine). Free and private; the model downloads once (Wi-Fi recommended). Optional **Groq cloud** with your own free key, stored in the Keychain. |
| Output | `Files → On My iPhone → Notakillite → Lectures → <date> - <name>/` with `01 - Lecture.md`, `01 - Lecture.m4a`, `00 - Index.md`. **Copy text**, **Share .md**, or **Share all transcripts**. |

The Markdown is byte-for-byte the same format as the Windows app (checked by both test suites against [`shared/fixtures/transcript-golden.json`](../shared/fixtures/transcript-golden.json)).

**Model choice:** "Recommended for this iPhone" lets WhisperKit pick what your device runs well. "Best · large-v3 turbo" gives the best Arabic/English accuracy on an iPhone 13 Pro or newer. Keep the app open while a long lecture is processed — iOS pauses long work in the background (the screen is kept awake while jobs run).

## Install without a paid Apple account (free sideload)

1. Download **Notakillite-unsigned.ipa** from the latest successful [iPhone app workflow run](../../../actions/workflows/ios.yml) (Artifacts) or from [Releases](../../../releases).
2. On Windows, install [Sideloadly](https://sideloadly.io) and iTunes (from apple.com, not the Microsoft Store), and connect the iPhone by USB.
3. Drag the `.ipa` into Sideloadly, enter your Apple ID, and press **Start**. Sideloadly signs it with your free developer certificate.
4. On the iPhone: **Settings → General → VPN & Device Management** → trust your Apple ID. On iOS 16+, also turn on **Settings → Privacy & Security → Developer Mode** and restart.
5. Free certificates expire after **7 days**: repeat step 3 (your lectures stay on the phone) or let Sideloadly's auto-refresh do it while the phone is on the same Wi-Fi.

A free Apple ID can have at most 3 sideloaded apps at a time. With a paid Apple Developer account the CI can instead upload to TestFlight (not set up).

## Build it yourself (Mac)

```bash
brew install xcodegen
cd ios && xcodegen generate
open Notakillite.xcodeproj    # choose your team under Signing, then Run
```

Tests: `xcodebuild test -project ios/Notakillite.xcodeproj -scheme Notakillite -destination 'platform=iOS Simulator,name=iPhone 16'`. The [iPhone app workflow](../.github/workflows/ios.yml) runs them on GitHub's macOS runner for every change under `ios/`.
