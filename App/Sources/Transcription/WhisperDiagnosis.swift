#if DEBUG
import CoreML
import Foundation
import WhisperKit

/// Debug builds only (used by the Whisper check in CI): what Whisper sees and writes for some audio,
/// as lines that can be compared between simulators and Xcode versions.
enum WhisperDiagnosis {
    static func run(samples: [Float], language: String, modelFolder: URL) async throws -> [String] {
        var lines = ["OS \(ProcessInfo.processInfo.operatingSystemVersionString), simulator \(WhisperKit.isRunningOnSimulator), device \(DeviceInfo.identifier)"]
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: modelFolder.path)) ?? []).sorted()
        lines.append("model files: \(names.joined(separator: ", "))")
        let rms = (samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(max(1, samples.count))).squareRoot()
        lines.append("audio: \(samples.count) samples, rms \(String(format: "%.4f", rms))")

        let pipe = try await WhisperKit(WhisperKitConfig(model: WhisperModel.base.rawValue, downloadBase: WhisperEngine.modelsFolder, modelFolder: modelFolder.path,
                                                         verbose: false, logLevel: .error, prewarm: false, load: true, download: false))
        lines.append("compute units: mel \(pipe.modelCompute.melCompute.rawValue), encoder \(pipe.modelCompute.audioEncoderCompute.rawValue), decoder \(pipe.modelCompute.textDecoderCompute.rawValue)")

        if let window = pipe.audioProcessor.padOrTrim(fromArray: samples, startAt: 0, toLength: 480_000),
           let mel = try await pipe.featureExtractor.logMelSpectrogram(fromAudio: window) {
            lines.append("mel: \(describe(mel))")
            let encoded = try await pipe.audioEncoder.encodeFeatures(mel)
            lines.append("encoder: \(describe(encoded))")
        }
        let detected = try await pipe.detectLangauge(audioArray: samples)
        let top = detected.langProbs.sorted { $0.value > $1.value }.prefix(4).map { "\($0.key) \(String(format: "%.3f", $0.value))" }
        lines.append("language: \(detected.language) (\(top.joined(separator: ", ")))")

        for timestamps in [true, false] {
            let options = DecodingOptions(task: .transcribe, language: language, temperature: 0, temperatureFallbackCount: 0, usePrefillPrompt: true,
                                          detectLanguage: false, skipSpecialTokens: false, withoutTimestamps: !timestamps,
                                          compressionRatioThreshold: nil, logProbThreshold: nil, firstTokenLogProbThreshold: nil, noSpeechThreshold: nil)
            let name = timestamps ? "with timestamps" : "without timestamps"
            let segments = try await pipe.transcribe(audioArray: samples, decodeOptions: options).flatMap(\.segments)
            if segments.isEmpty { lines.append("\(name): no segments") }
            for s in segments {
                lines.append("\(name) [\(s.start)–\(s.end)] logprob \(String(format: "%.2f", s.avgLogprob)) no-speech \(String(format: "%.2f", s.noSpeechProb)) "
                             + "tokens \(Array(s.tokens.prefix(14))) text: \(s.text)")
            }
        }
        return lines
    }

    /// Shape, type and value statistics of a model input or output, and its first values.
    private static func describe(_ value: Any?) -> String {
        guard let array = value as? MLMultiArray else { return "not an MLMultiArray: \(String(describing: value))" }
        let count = array.count
        var sum = 0.0, squares = 0.0, low = Double.infinity, high = -Double.infinity, nan = 0
        for i in 0..<count {
            let v = array[i].doubleValue
            if v.isNaN { nan += 1; continue }
            sum += v; squares += v * v; low = min(low, v); high = max(high, v)
        }
        let n = Double(max(1, count - nan)), mean = sum / n
        let first = (0..<min(6, count)).map { String(format: "%.4f", array[$0].doubleValue) }
        return "shape \(array.shape) type \(array.dataType.rawValue) mean \(String(format: "%.4f", mean)) sd \(String(format: "%.4f", max(0, squares / n - mean * mean).squareRoot())) "
            + "min \(String(format: "%.3f", low)) max \(String(format: "%.3f", high)) NaN \(nan) first \(first.joined(separator: " "))"
    }
}
#endif
