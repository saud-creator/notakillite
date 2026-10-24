// swift-tools-version: 5.9
import PackageDescription

// On-device noise removal models for Mentality:
// - RNNoise (Xiph, pinned commit after 0.2 with the newest weights), C, compiled from source.
// - DeepFilterNet 3 (Rust), prebuilt as a static library for iOS devices and simulators.
// Run `scripts/build-noise-models.sh` once (needs Rust) to fetch and build both before opening the project.
let package = Package(
    name: "NoiseModels",
    platforms: [.iOS(.v17)],
    products: [.library(name: "NoiseModels", targets: ["NoiseModels"])],
    targets: [
        .target(name: "CRNNoise", path: "Sources/CRNNoise", cSettings: [.define("RNNOISE_BUILD")]),
        .binaryTarget(name: "CDeepFilter", path: "DeepFilter.xcframework"),
        .target(
            name: "NoiseModels",
            dependencies: ["CRNNoise", "CDeepFilter"],
            path: "Sources/NoiseModels",
            resources: [.copy("Resources/DeepFilterNet3_onnx.tar.gz")],
            // System libraries the Rust standard library and its dependencies use on iOS.
            linkerSettings: [.linkedFramework("Security"), .linkedFramework("SystemConfiguration"),
                             .linkedFramework("CoreFoundation"), .linkedLibrary("iconv")]
        ),
    ]
)
