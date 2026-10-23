# Offline noise reduction engines

These assets are included in the project and Windows EXE. Processing needs no model download, Python installation, GPU, or remote service.

- **RNNoise:** Gregor Richards' recording-oriented `conjoined-burgers` model (`cb.rnnn`), converted to FFmpeg's `arnndn` format, from `richardpl/arnndn-models` commit `0fda24c46d78f0207d820bb970fbe85c1971b39c`. The original Xiph model (`std.rnnn`) is also retained for reference. The existing bundled FFmpeg implements inference. See `rnnoise/LICENSE`, `rnnoise/MODEL-README.md` and `rnnoise/TRAINING-README.md`. Source: https://github.com/xiph/rnnoise, https://github.com/GregorR/rnnoise-models and https://github.com/richardpl/arnndn-models.
- **DeepFilterNet:** official `v0.5.6` Windows x64 CPU runtime and the explicitly supplied **DeepFilterNet3 ONNX** model from the same tag. See the MIT/Apache license files in `deepfilternet/`. Source and build instructions: https://github.com/Rikorose/DeepFilterNet/tree/v0.5.6. Original CLI source used to verify delay and file handling is retained in `research/deepfilternet-enhance_wav.rs` in the project.

`node scripts/install-engines.mjs --verify` validates all binary/model SHA-256 hashes. Omit `--verify` to download missing or modified artifacts again from the pinned upstream URLs. Distributables include their license notices. The Windows runtime targets x64; other platforms need a matching DeepFilterNet runtime.

Balanced mode uses an RNNoise mix of 0.85 and a DeepFilterNet attenuation limit of 24 dB. Strong mode uses 1.0 and 40 dB respectively. Combined mode applies RNNoise before DeepFilterNet; it takes more CPU and may remove quiet speech. The app never silently substitutes a different engine after an error.
