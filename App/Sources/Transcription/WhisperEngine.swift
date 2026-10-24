import CoreML
import Foundation
import WhisperKit

/// Whisper models offered in the app. Names are folders in huggingface.co/argmaxinc/whisperkit-coreml.
enum WhisperModel: String, CaseIterable, Identifiable, Codable, Sendable {
    case turbo = "openai_whisper-large-v3-v20240930"
    case largeV3 = "openai_whisper-large-v3"
    case turboCompact = "openai_whisper-large-v3-v20240930_626MB"
    case largeV3Compact = "openai_whisper-large-v3_947MB"
    case small = "openai_whisper-small"
    case base = "openai_whisper-base"     // used by the automated tests
    case tiny = "openai_whisper-tiny"     // used by the automated tests on the iPadOS 18 simulator

    var id: String { rawValue }

    /// The small models the automated tests use. Never offered in Settings, but a saved one is kept.
    var isTestModel: Bool { self == .base || self == .tiny }

    /// The models a device can run, recommended first. Devices with enough memory, such as iPad Pro
    /// (M4), get both full-size large models; the iPhone 15 Pro gets the compressed versions of the
    /// same two models (Argmax's device table, built into WhisperKit).
    static func supported(on device: String) -> [WhisperModel] {
        let runnable = Set(ModelUtilities.modelSupport(for: device).supported)
        var list = [WhisperModel.turbo, .largeV3, .turboCompact, .largeV3Compact, .small].filter { runnable.contains($0.rawValue) }
        if list.contains(.turbo) { list.removeAll { $0 == .turboCompact } }
        if list.contains(.largeV3) { list.removeAll { $0 == .largeV3Compact } }
        return list.isEmpty ? [.small] : list
    }

    /// Fast and accurate: large-v3 turbo, full size where the device runs it, compressed otherwise.
    static func recommendedModel(on device: String) -> WhisperModel {
        let list = supported(on: device)
        return list.first { $0 == .turbo || $0 == .turboCompact } ?? list[0]
    }

    /// The models offered on this device (worked out once).
    static let offered: [WhisperModel] = supported(on: DeviceInfo.identifier)
    static let recommended: WhisperModel = recommendedModel(on: DeviceInfo.identifier)

    var title: String {
        switch self {
        case .turbo: "large-v3 turbo · fast, very accurate"
        case .largeV3: "large-v3 · most accurate, slower"
        case .turboCompact: "large-v3 turbo · compressed, 626 MB"
        case .largeV3Compact: "large-v3 · compressed, 947 MB"
        case .small: "small · light"
        case .base: "base · tests"
        case .tiny: "tiny · tests"
        }
    }

    var detail: String {
        switch self {
        case .turbo: "About 1.6 GB. Nearly as accurate as large-v3 and several times faster. Recommended."
        case .largeV3: "About 3 GB. The most accurate for Arabic and mixed lectures. Slower; its first start takes several minutes while the Neural Engine prepares it."
        case .turboCompact: "The turbo model compressed to fit this device's memory. Fast and accurate. Recommended."
        case .largeV3Compact: "Full large-v3 compressed to fit this device's memory: the most accurate choice here, but slower than turbo."
        case .small: "About 480 MB. Fast, but noticeably weaker on Arabic."
        case .base: "Small model used by the automated tests."
        case .tiny: "The smallest model, used by the automated tests on the iPadOS 18 simulator."
        }
    }

    var shortName: String {
        switch self {
        case .turbo: "large-v3 turbo"
        case .largeV3: "large-v3"
        case .turboCompact: "large-v3 turbo (compressed)"
        case .largeV3Compact: "large-v3 (compressed)"
        case .small: "small"
        case .base: "base"
        case .tiny: "tiny"
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

/// On-device Whisper through WhisperKit (Core ML). Audio never leaves the device.
///
/// The encoder and decoder run on the Neural Engine and the spectrogram on the CPU: iPadOS stops apps
/// that use the GPU in the background, and the Neural Engine is the fastest unit for Whisper on M4.
actor WhisperEngine: SpeechEngine {
    static let shared = WhisperEngine()

    private var pipe: WhisperKit?
    private var loaded: WhisperModel?
    private var workers = 4

    static var modelsFolder: URL {
        // Tests can point this at a cached folder (MENTALITY_MODELS_DIR) so CI downloads models once.
        let override = ProcessInfo.processInfo.environment["MENTALITY_MODELS_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        let base = override ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Models", isDirectory: true)
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
        self.workers = min(4, max(1, workers))
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
                    let fraction = progress.fractionCompleted.isFinite ? min(1, max(0, progress.fractionCompleted)) : 0
                    stage("Downloading \(model.shortName) (one time) · \(Int(fraction * 100))%", fraction * 0.8)
                })
            }
            stage("Preparing \(model.shortName) for the Neural Engine (slow only the first time)", 0.85)
            let compute = ModelComputeOptions(melCompute: .cpuOnly, audioEncoderCompute: .cpuAndNeuralEngine, textDecoderCompute: .cpuAndNeuralEngine)
            let config = WhisperKitConfig(model: model.rawValue, downloadBase: Self.modelsFolder, modelFolder: folder.path,
                                          computeOptions: compute, logitsFilters: [CPUPauseFilter()],
                                          verbose: false, logLevel: .error, prewarm: true, load: true, download: false)
            pipe = try await WhisperKit(config)
            loaded = model
            try? Data().write(to: folder.appendingPathComponent(Self.readyMarker))
            stage("Model ready", 1)
        } catch {
            throw WhisperEngineError.modelUnavailable(error.localizedDescription)
        }
    }

    static let readyMarker = ".mentality-ready"

    /// The model's folder when it was fully downloaded and loaded once before. Hidden folders are skipped:
    /// the downloader keeps its bookkeeping in `.cache/huggingface/download/<model name>/`, a folder
    /// with the same name as the model's.
    static func localFolder(_ model: WhisperModel, in base: URL = modelsFolder) -> URL? {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: base, includingPropertiesForKeys: [.isDirectoryKey],
                                             options: [.skipsPackageDescendants, .skipsHiddenFiles]) else { return nil }
        for case let url as URL in enumerator {
            if url.pathExtension == "mlmodelc" { enumerator.skipDescendants(); continue }
            if url.lastPathComponent == model.rawValue, fm.fileExists(atPath: url.appendingPathComponent(readyMarker).path) {
                return url
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

    /// Lectures here are Arabic, English, or both. Whisper's own detection chooses among ~100 languages
    /// and often turns Arabic into Persian/Urdu or translates it, so only Arabic and English compete.
    static func arabicOrEnglish(_ probabilities: [String: Float], detected: String?) -> String {
        if let ar = probabilities["ar"], let en = probabilities["en"] { return ar >= en ? "ar" : "en" }
        if probabilities["ar"] != nil { return "ar" }
        if probabilities["en"] != nil { return "en" }
        return detected == "en" ? "en" : "ar"
    }

    func transcribe(_ pieces: [[Float]], settings: DecodeSettings) async throws -> [PieceResult] {
        guard let pipe else { throw WhisperEngineError.modelUnavailable("not loaded") }
        guard !pieces.isEmpty else { return [] }
        let budget = CPUBudget.shared

        // Language per piece: fixed, or the likelier of Arabic and English.
        var languages: [String] = []
        if let fixed = settings.language {
            languages = Array(repeating: fixed, count: pieces.count)
        } else {
            for piece in pieces {
                try await budget.pause()
                let detection = try? await pipe.detectLangauge(audioArray: piece)   // (sic) WhisperKit's spelling
                languages.append(Self.arabicOrEnglish(detection?.langProbs ?? [:], detected: detection?.language))
            }
        }

        var results = [PieceResult?](repeating: nil, count: pieces.count)
        for language in Set(languages).sorted() {
            let indices = languages.indices.filter { languages[$0] == language }
            var next = 0
            while next < indices.count {
                // In the background, one piece at a time, so the CPU budget can be kept (see CPUBudget).
                try await budget.pause()
                let limited = budget.isLimited
                let group = Array(indices[next..<min(indices.count, next + (limited ? 1 : indices.count))])
                let out = try await decode(group.map { pieces[$0] }, language: language, settings: settings, pipe: pipe, workers: limited ? 1 : workers)
                for (n, index) in group.enumerated() where n < out.count { results[index] = out[n] }
                next += group.count
            }
        }
        return results.map { $0 ?? PieceResult(segments: [], language: nil) }
    }

    private func decode(_ pieces: [[Float]], language: String, settings: DecodeSettings, pipe: WhisperKit, workers: Int) async throws -> [PieceResult] {
        var options = DecodingOptions(
            task: .transcribe,
            language: language,
            temperature: settings.temperature,
            temperatureIncrementOnFallback: 0.2,
            temperatureFallbackCount: 5,
            usePrefillPrompt: true,
            detectLanguage: false,
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
        }
        let results = await pipe.transcribeWithResults(audioArrays: pieces, decodeOptions: options)
        var out: [PieceResult] = []
        for result in results {
            switch result {
            case .success(let list):
                let segments = list.flatMap(\.segments).map { SpeechSegment(start: Double($0.start), end: Double($0.end), text: $0.text) }
                out.append(PieceResult(segments: segments, language: language))
            case .failure(let error):
                if error is CancellationError { throw error }
                throw WhisperEngineError.pieceFailed(error.localizedDescription)
            }
        }
        return out
    }
}

/// WhisperKit runs this before choosing each word piece (token). It leaves the choice alone, but while the
/// app is in the background and has used up its CPU budget, decoding waits here. Without it the budget
/// could only pause between whole pieces of audio, and one hard piece (Whisper retrying it at higher
/// temperatures) could use a full minute of CPU on its own.
final class CPUPauseFilter: LogitsFiltering {
    private let budget: CPUBudget

    init(budget: CPUBudget = .shared) {
        self.budget = budget
    }

    func filterLogits(_ logits: MLMultiArray, withTokens tokens: [Int]) -> MLMultiArray {
        budget.throttle(cancelled: { Task.isCancelled })
        return logits
    }
}
