# Notakillite 0.5.0 verification

21 October 2026 · Windows x64 · Local connector build

The app is packaged and launchable. The real-account acceptance gate is still open: the connector has not been installed in the user's usual Brave profile. The blocked connector page was an unavailable-extension page, not evidence of a failed Google sign-in in the new architecture.

| Check | Result |
| --- | --- |
| Regression suite | **42/42 passed**, including library hierarchy/sorting, ownership, account changes, neural engines, formats, cancellation, retry, recovery, and bounded transfers. Browser persistence checks ran under the normal Windows user context; browser encryption did not persist in the restricted test sandbox. |
| Actual native messaging | Installed Brave → native host → current-user Windows pipe → local core → native UI. A synthetic 1,500-note Arabic/English library and a real AAC M4A byte stream passed. No real account was used. |
| Three distinct packaged EXEs | **Passed.** Three different payloads/executable hashes extracted and launched against one synthetic profile. Persistent cookie/local storage, connector UUID, verified synthetic account reference, theme, export location, completed jobs and their files survived app/browser closure between builds. |
| Restored selected lecture | The newest packaged build automatically loaded its recording list after connection returned. Earlier prototype builds used their visible Reload recordings action during the upgrade check. |
| Packaged audio runtime | Bundled Node/FFmpeg/models processed AAC and ALAC M4A through RNNoise, DeepFilterNet3 and combined mode. Both original exports were byte-identical: **8 successful jobs**. Full MP3 decoding, saved history and temporary cleanup passed from an extracted path containing spaces and Arabic. |
| Lecture-length processing | Generated **45:00.137** spoken lecture processed with DeepFilterNet3. The output decoded to exactly **64,803,288 samples at 24 kHz**, including the tail. Temporary cleanup passed. This is synthetic audio, not a user's lecture. |
| Native UI | Dark/light desktop, compact recording drawer and 750 × 520 first-launch views rendered. Contrasts, controls and small-window onboarding were visually reviewed. These are the native WPF app, not the HTML preview. |
| Noise suppression | Controlled speech/noise fixtures passed the minimum noise-to-speech improvement check with both neural engines and combined mode. This does not measure universal lecture intelligibility. |
| Other formats | WAV, MP3, FLAC, OGG/Vorbis, WebM/Opus, AIFF, CAF/PCM and raw AAC passed through both engines. Format support depends on FFmpeg; protected/corrupt files are unsupported. |
| Sign-in after real restart/shutdown | **Not verified.** No Windows restart or shutdown was initiated. Synthetic persistence tests do not replace these checks. |
| Real Notability account/export | **Not verified for this Brave-native release.** Historical Edge account checks belong to the legacy report. |
| Distribution | EXE and local connector ZIP produced. The EXE is unsigned. Store publication and publisher signing remain pending. |

The EXE retains program versions separately from `%LOCALAPPDATA%\Notakillite` settings, library cache, jobs, connector files and exports. Normal Brave manages its own authentication. The app does not collect credentials, copy cookies or reset browser data. Expiry/revocation, explicit sign-out or cleared browser data can still require authentication.

One-time setup requires enabling Developer mode and loading `%LOCALAPPDATA%\Notakillite\connector\extension` in the chosen usual Brave profile. The app checks for a missing/disabled connector before opening its page. If the Extensions button opens a blank tab, type `brave://extensions` in Brave's address bar. The app does not toggle Developer mode or force-install the connector. Automatic approval review rejected the agent's attempt to toggle that browser security setting; manual installation remains required.

DeepFilterNet3's Microsoft Visual C++ prerequisite is installed on this computer. Startup checks the executable. Settings → Repair audio runtime downloads only Microsoft's official installer, verifies its signature and opens it without automatic restart. That repair-install action was not needed or executed during these checks.

Evidence under `%USERPROFILE%\Documents\notakillite`:

- `.local\packaged-upgrades-1792590316550\verification.json` — three actual EXE hashes and retained session/export checks.
- `.local\bridge-native-qa\verification.json` — native messaging and latest synthetic export.
- `.local\native-payload QA العربية\report.json` — bundled runtime and eight AAC/ALAC exports.
- `.local\long-lecture-qa\verification.json` — complete 45-minute processing/decode result.
- `.local\native-ui-qa\verification.json` and PNG files — native views.
- `VERIFICATION-LEGACY.md` — earlier Edge/automation results, kept separate from this release.

## Final EXE check

The delivered `release\Notakillite.exe` is **163,128,832 bytes**. SHA-256: `4657F799C14E67A4590DE2262B19C37CE3CCDB74DE50162522F7DE839D2DF8A5`.

The final EXE extracted to payload `0.5.0-3464bfa82537`. Its bundled runtime repeated all eight AAC/ALAC jobs successfully. A further native-connector run retained the same synthetic profile UUID and previous exports, completed a new DeepFilterNet3 M4A export, and opened/decoded the result in the native Windows player with QA playback muted. The job observer used a read-only SQLite connection.

The final EXE was also launched normally against the user's existing app data. The older idle candidate was closed; Brave windows and all browser data were left intact. The visible native app correctly shows **Set up Brave** while the one-time connector installation remains pending. This does not constitute real-account authentication verification.

The verification report supplied beside the EXE includes these post-build checks; the report embedded in the payload records the earlier build-time checks.
