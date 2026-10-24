#!/bin/bash
# Fetches and builds the on-device noise removal models into Packages/NoiseModels:
#   - RNNoise (Xiph, BSD): C sources and the latest trained weights, compiled by Xcode. The 0.2
#     release doesn't build for ARM (missing os_support.h), so a later, fixed commit is used.
#   - DeepFilterNet 3 (Rikorose, MIT/Apache-2.0): Rust library built for iOS devices and simulators
#     (DeepFilter.xcframework), plus the model file the app loads at run time.
# Also copies two short recordings from DeepFilterNet's repository (clean speech, and noise) into
# TestAssets/ for the noise removal tests.
# Needs a Mac with Xcode and Rust (rustup). Run once before `xcodegen generate`; later runs exit
# immediately while the outputs are current. Downloads are pinned by commit and checksum.
set -euo pipefail

STAMP_VERSION=2
RNNOISE_REPO=https://github.com/xiph/rnnoise
RNNOISE_COMMIT=70f1d256acd4b34a572f999a05c87bf00b67730d
RNNOISE_MODEL_SHA256=0a8755f8e2d834eff6a54714ecc7d75f9932e845df35f8b59bc52a7cfe6e8b37
DFN_REPO=https://github.com/Rikorose/DeepFilterNet
DFN_COMMIT=d375b2d8309e0935d165700c91da9de862a99c31
DFN_MODEL_SHA256=c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616
IOS_TARGET=18.0

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG="$ROOT/Packages/NoiseModels"
STAMP="$PKG/.built-v$STAMP_VERSION"
RNN_DIR="$PKG/Sources/CRNNoise"
RES_DIR="$PKG/Sources/NoiseModels/Resources"
XCF="$PKG/DeepFilter.xcframework"
ASSETS="$PKG/TestAssets"

if [ -f "$STAMP" ] && [ -f "$RNN_DIR/rnnoise_data.c" ] && [ -f "$RES_DIR/DeepFilterNet3_onnx.tar.gz" ] && [ -d "$XCF" ] \
   && [ -f "$ASSETS/clean_freesound_33711.wav" ] && [ -f "$ASSETS/noise_freesound_2530.wav" ]; then
  echo "Noise models are already built ($STAMP)."
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
fetch_commit() {  # repo commit folder
  git -c init.defaultBranch=main init -q "$3"
  git -C "$3" remote add origin "$1"
  git -C "$3" fetch -q --depth 1 origin "$2"
  git -C "$3" checkout -q FETCH_HEAD
}

echo "== RNNoise"
SRC="$WORK/rnnoise"
fetch_commit "$RNNOISE_REPO" "$RNNOISE_COMMIT" "$SRC"
[ "$(cat "$SRC/model_version")" = "$RNNOISE_MODEL_SHA256" ] || { echo "Unexpected RNNoise model version" >&2; exit 1; }
curl -fsSL --retry 4 -o "$WORK/rnnoise-model.tar.gz" "https://media.xiph.org/rnnoise/models/rnnoise_data-$RNNOISE_MODEL_SHA256.tar.gz"
[ "$(sha "$WORK/rnnoise-model.tar.gz")" = "$RNNOISE_MODEL_SHA256" ] || { echo "RNNoise model checksum mismatch" >&2; exit 1; }
tar -xzf "$WORK/rnnoise-model.tar.gz" -C "$SRC"
rm -rf "$RNN_DIR"
mkdir -p "$RNN_DIR/include"
cp "$SRC/include/rnnoise.h" "$RNN_DIR/include/"
# Only the library sources (no x86-only files, no tools with their own main()).
for f in denoise.c rnn.c pitch.c kiss_fft.c celt_lpc.c nnet.c nnet_default.c parse_lpcnet_weights.c rnnoise_data.c rnnoise_tables.c; do
  cp "$SRC/src/$f" "$RNN_DIR/"
done
for h in "$SRC"/src/*.h; do cp "$h" "$RNN_DIR/"; done
cp "$SRC/COPYING" "$RNN_DIR/LICENSE-RNNoise"

echo "== DeepFilterNet 3"
fetch_commit "$DFN_REPO" "$DFN_COMMIT" "$WORK/dfn"
# The repository's own Cargo.lock is out of date (cargo refuses it with --locked), so a lock file
# that is known to build is used: dependencies stay exactly the same on every run.
cp "$ROOT/scripts/deepfilter/Cargo.lock" "$WORK/dfn/Cargo.lock"
MODEL="$WORK/dfn/models/DeepFilterNet3_onnx.tar.gz"
[ "$(sha "$MODEL")" = "$DFN_MODEL_SHA256" ] || { echo "DeepFilterNet model checksum mismatch" >&2; exit 1; }
mkdir -p "$RES_DIR"
cp "$MODEL" "$RES_DIR/"
cp "$WORK/dfn/LICENSE-MIT" "$RES_DIR/LICENSE-DeepFilterNet-MIT"
mkdir -p "$ASSETS"
cp "$WORK/dfn/assets/clean_freesound_33711.wav" "$WORK/dfn/assets/noise_freesound_2530.wav" "$ASSETS/"

rustup target add aarch64-apple-ios aarch64-apple-ios-sim
export IPHONEOS_DEPLOYMENT_TARGET=$IOS_TARGET
for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  echo "-- building for $target"
  (cd "$WORK/dfn" && cargo rustc --locked --release -p deep_filter --lib --no-default-features --features capi \
     --target "$target" --crate-type staticlib -- --print native-static-libs)
done

HEADERS="$WORK/include/CDeepFilter"
mkdir -p "$HEADERS"
cat > "$HEADERS/deep_filter.h" <<'EOF'
// C interface of DeepFilterNet's libDF (libDF/src/capi.rs). SPDX-License-Identifier: MIT OR Apache-2.0
#ifndef DEEP_FILTER_H
#define DEEP_FILTER_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct DFState DFState;
/// Loads a DeepFilterNet model (.tar.gz of ONNX files). atten_lim: maximum noise reduction in dB.
DFState *df_create(const char *path, float atten_lim, const char *log_level);
/// Samples per frame (hop size), 480 at 48 kHz.
size_t df_get_frame_length(DFState *st);
char *df_next_log_msg(DFState *st);
void df_free_log_msg(char *ptr);
void df_set_atten_lim(DFState *st, float lim_db);
void df_set_post_filter_beta(DFState *st, float beta);
/// Cleans one frame of 48 kHz mono audio (-1...1). Returns the frame's local SNR.
float df_process_frame(DFState *st, float *input, float *output);
void df_free(DFState *model);
#ifdef __cplusplus
}
#endif
#endif
EOF
cat > "$HEADERS/module.modulemap" <<'EOF'
module CDeepFilter {
    header "deep_filter.h"
    export *
}
EOF

rm -rf "$XCF"
xcodebuild -create-xcframework \
  -library "$WORK/dfn/target/aarch64-apple-ios/release/libdf.a" -headers "$WORK/include" \
  -library "$WORK/dfn/target/aarch64-apple-ios-sim/release/libdf.a" -headers "$WORK/include" \
  -output "$XCF"
ls -lh "$XCF"/*/libdf.a

rm -f "$PKG"/.built-v*
date -u +%FT%TZ > "$STAMP"
echo "Noise models ready in $PKG"
