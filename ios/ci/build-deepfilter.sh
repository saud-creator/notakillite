#!/bin/bash
# Cross-compiles DeepFilterNet's Rust library (libDF, tag v0.5.6, C API feature "capi") as a static
# library for iPhone/iPad (aarch64-apple-ios) and the Apple Silicon simulator (aarch64-apple-ios-sim),
# and packages both as ios/DeepFilter/DeepFilter.xcframework. The app links it and loads the bundled
# DeepFilterNet3 model (vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz) at run time.
#
# Needs a Mac with Xcode and rustup; takes about 10 minutes. CI caches the result (see ios.yml).
# Usage: bash ios/ci/build-deepfilter.sh
set -euo pipefail

TAG=v0.5.6
# A Rust release from the same era as the tag's Cargo.lock (newer compilers reject some locked crates).
TOOLCHAIN=${DEEPFILTER_RUST_TOOLCHAIN:-1.79.0}
TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim)
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$IOS_DIR/DeepFilter/DeepFilter.xcframework"
WORK="${TMPDIR:-/tmp}/deepfilter-build"

rm -rf "$WORK" && mkdir -p "$WORK"
git clone --quiet --depth 1 --branch "$TAG" https://github.com/Rikorose/DeepFilterNet.git "$WORK/src"
cd "$WORK/src"

# The "capi" feature also embeds a second copy of the model in the library; the app passes the path
# of the bundled model to df_create() instead, so drop the embedded one (saves 8 MB).
sed -i '' 's/^capi = \["tract", "default-model", "dep:ndarray"\]$/capi = ["tract", "dep:ndarray"]/' libDF/Cargo.toml
grep -q '^capi = \["tract", "dep:ndarray"\]$' libDF/Cargo.toml || { echo "libDF/Cargo.toml differs from $TAG"; exit 1; }

rustup toolchain install "$TOOLCHAIN" --profile minimal
rustup target add --toolchain "$TOOLCHAIN" "${TARGETS[@]}"
export IPHONEOS_DEPLOYMENT_TARGET=18.0
export CARGO_PROFILE_RELEASE_STRIP=debuginfo

LIBRARIES=()
for TARGET in "${TARGETS[@]}"; do
  echo "== $TARGET"
  cargo +"$TOOLCHAIN" rustc --locked --release -p deep_filter --lib --no-default-features --features capi \
    --target "$TARGET" --crate-type staticlib -- --print native-static-libs
  LIB="$WORK/src/target/$TARGET/release/libdf.a"
  ls -lh "$LIB"
  for SYMBOL in df_create df_get_frame_length df_process_frame df_set_atten_lim df_free; do
    nm -gU "$LIB" 2>/dev/null | grep -q " T _$SYMBOL\$" || { echo "$SYMBOL missing from $LIB"; exit 1; }
  done
  LIBRARIES+=(-library "$LIB")
done

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
xcodebuild -create-xcframework "${LIBRARIES[@]}" -output "$OUT"
find "$OUT" -type f | sed "s|$IOS_DIR/||"
