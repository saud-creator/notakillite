import CoreML
import Foundation
import WhisperKit

/// Whisper models offered in the app. Names are folders in huggingface.co/argmaxinc/whisperkit-coreml.
enum WhisperModel: String, CaseIterable, Identifiable, Codable, Sendable {
    case largeV3 = "openai_whisper-large-v3"
    case turbo = "openai_whisper-large-v3-v20240930"
    case turboCompact = "openai_whisper-large-v3-v20240930_626MB"
    case small = "openai_whisper-small"
    case base = "openai_whisper-base"     // used by the automated tests

    var id: String { rawValue }
    static var offered: [WhisperModel] { [.largeV3, .turbo, .turboCompact, .small] }

    var title: String {
        switch self {
        case .largeV3: "Best accuracy · large-v3"
        case .turbo: "Fast and accurate · large-v3 turbo"
        case .turboCompact: "Compact · large-v3 turbo (626 MB)"
        case .small: "Light · small"
        case .base: "Test · base"
        }
    }
    var detail: String {
        switch self {
        case .largeV3: "Full Whisper large-v3, about 3 GB. The most accurate for Arabic and mixed lectures. Slowest; first start takes several minutes while iPadOS prepares it for the Neural Engine."
        case .turbo: "About 1.6 GB. Close to large-v3 accuracy and several times faster. Recommended for iPad Pro M4."
        case .turboCompact: "Compressed turbo. Smaller download, slightly less accurate."
        case .small: "About 480 MB. Fast, but noticeably weaker on Arabic."
        case .base: "Tiny model used by the automated tests."
        }
    }
    var shortName: String {
        switch self {
        case .largeV3: "large-v3"
        case .turbo: "large-v3 turbo"
        case .turboCompact: "large-v3 turbo (compressed)"
        case .small: "small"
        case .base: "base"
        }
    }
}

enum WhisperEngineError: LocalizedError {
    case modelUnavailable(String), pieceFailed(String)
    var errorDescription: String? {
        switch self {
        case .modelUnavailable(let reason): "The speech model could not be loaded: \(reason). Connect to Wi-Fi for the one-time download, or pick another model in Settings."
        case .pieceFailed(let reason): "Speech recognition failed: \(reason)"
        }
    }
}

/// On-device Whisper through WhisperKit (Core ML). Audio never leaves the iPad.
///
/// The encoder and decoder run on the Neural Engine and the spectrogram on the CPU: iPadOS stops apps
/// that use the GPU in the background, and the Neural Engine is the fastest unit for Whisper on M4.
actor WhisperEngine: SpeechEngine {
    static let shared = WhisperEngine()

    private var pipe: WhisperKit?
    private var loaded: WhisperModel?
    private var workers = 4

    static var modelsFolder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Models", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = base
        try? url.setResourceValues(values)
        return base
    }

    var label: String { "Whisper \(loaded?.shortName ?? "") (WhisperKit, on-device)" }

    /// Downloads (once) and loads a model. `stage` receives text and 0–1 progress.
    func load(_ model: WhisperModel, workers: Int, stage: @escaping @Sendable (String, Double) -> Void) async throws {
        self.workers = max(1, workers)
        if loaded == model, pipe != nil { return }
        pipe = nil
        loaded = nil
        do {
            let folder: URL
            if let local = Self.localFolder(model) {
                folder = local   // already downloaded: works offline
            } else {
                stage("Downloading \(model.shortName) (one time)", 0)
                folder = try await WhisperKit.download(variant: model.rawValue, downloadBase: Self.modelsFolder, progressCallback: { progress in
                    stage("Downloading \(model.shortName) (one time) · \(Int(progress.fractionCompleted * 100))%", progress.fractionCompleted * 0.8)
                })
            }
            stage("Preparing \(model.shortName) for the Neural Engine (slow only the first time)", 0.85)
            let compute = ModelComputeOptions(melCompute: .cpuOnly, audioEncoderCompute: .cpuAndNeuralEngine, textDecoderCompute: .cpuAndNeuralEngine)
            let config = WhisperKitConfig(model: model.rawValue, downloadBase: Self.modelsFolder, modelFolder: folder.path,
                                          computeOptions: compute, verbose: false, logLevel: .error, prewarm: true, load: true, download: false)
            pipe = try await WhisperKit(config)
            loaded = model
            try? Data().write(to: folder.appendingPathComponent(Self.readyMarker))
            stage("Model ready", 1)
        } catch {
            throw WhisperEngineError.modelUnavailable(error.localizedDescription)
        }
    }

    private static let readyMarker = ".mentality-ready"

    /// The model's folder when it was fully downloaded and loaded once before.
    static func localFolder(_ model: WhisperModel) -> URL? {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: modelsFolder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsPackageDescendants]) else { return nil }
        for case let url as URL in enumerator {
            if url.pathExtension == "mlmodelc" { enumerator.skipDescendants(); continue }
            if url.lastPathComponent == model.rawValue {
                return fm.fileExists(atPath: url.appendingPathComponent(readyMarker).path) ? url : nil
            }
        }
        return nil
    }

    static func isDownloaded(_ model: WhisperModel) -> Bool { localFolder(model) != nil }

    /// Deletes a downloaded model to free space.
    static func delete(_ model: WhisperModel) {
        if let folder = localFolder(model) { try? FileManager.default.removeItem(at: folder) }
    }

    func unload() {
        pipe = nil
        loaded = nil
    }

    func transcribe(_ pieces: [[Float]], settings: DecodeSettings) async throws -> [PieceResult] {
        guard let pipe else { throw WhisperEngineError.modelUnavailable("not loaded") }
        guard !pieces.isEmpty else { return [] }
        var options = DecodingOptions(
            task: .transcribe,
            language: settings.language,
            temperature: settings.temperature,
            temperatureIncrementOnFallback: 0.2,
            temperatureFallbackCount: 5,
            usePrefillPrompt: true,
            detectLanguage: settings.language == nil,
            skipSpecialTokens: true,
            withoutTimestamps: false,
            suppressBlank: true,
            compressionRatioThreshold: 2.4,
            logProbThreshold: -1.0,
            firstTokenLogProbThreshold: -1.5,
            noSpeechThreshold: 0.6,
            concurrentWorkerCount: workers,
            chunkingStrategy: ChunkingStrategy.none
        )
        let terms = settings.vocabulary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !terms.isEmpty, let tokenizer = pipe.tokenizer {
            // A fixed prompt only: earlier decoded text is never fed back (that caused repetition loops).
            options.promptTokens = Array(tokenizer.encode(text: " " + terms).filter { $0 < tokenizer.specialTokens.specialTokenBegin }.prefix(120))
            options.usePrefillPrompt = true
        }
        let results = await pipe.transcribeWithResults(audioArrays: pieces, decodeOptions: options)
        var out: [PieceResult] = []
        for result in results {
            switch result {
            case .success(let list):
                let segments = list.flatMap(\.segments).map { SpeechSegment(start: Double($0.start), end: Double($0.end), text: $0.text) }
                out.append(PieceResult(segments: segments, language: list.first?.language))
            case .failure(let error):
                if error is CancellationError { throw error }
                throw WhisperEngineError.pieceFailed(error.localizedDescription)
            }
        }
        return out
    }
}
