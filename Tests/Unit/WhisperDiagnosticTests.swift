import XCTest
@testable import Mentality

/// For the Whisper check workflow: prints what Whisper sees and writes for the spoken test lectures
/// ("DIAG" lines), so simulators and Xcode versions can be compared line by line. Runs only when
/// MENTALITY_WHISPER_DIAG=1.
final class WhisperDiagnosticTests: XCTestCase {
    func testPrintWhatWhisperSeesAndWrites() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["MENTALITY_WHISPER_DIAG"] == "1" else { throw XCTSkip("Set MENTALITY_WHISPER_DIAG=1 to run the Whisper diagnosis.") }
        try await WhisperEngine.shared.load(.base, workers: 1) { _, _ in }
        let baseFolder = try XCTUnwrap(WhisperEngine.localFolder(.base))
        // WhisperKit's own CI transcribes correctly with the tiny model on iOS 18 simulators: compare.
        let tiny = "openai_whisper-tiny"
        let tinyFolder = try await WhisperDiagnosis.download(tiny)
        let models = [("base", WhisperModel.base.rawValue, baseFolder), ("tiny", tiny, tinyFolder)]
        for (key, language) in [("MENTALITY_E2E_EN", "en"), ("MENTALITY_E2E_AR", "ar")] {
            guard let path = env[key], FileManager.default.fileExists(atPath: path) else { continue }
            let audio = try await AudioPreparer.prepare(input: URL(fileURLWithPath: path), mode: .none, keepCleanedAudio: false, folder: TestAudio.folder()) { _ in }
            let samples = try AudioSamples.read(audio.original, range: TimeRange(start: 0, end: audio.duration))
            for (name, variant, folder) in models {
                for line in try await WhisperDiagnosis.run(samples: samples, language: language, modelFolder: folder, variant: variant) {
                    print("DIAG \(name) \(language) \(line)")
                }
            }
        }
    }

    /// The app's own path with the tiny model: its decoding settings, with and without DeepFilterNet, then the
    /// whole pipeline. Shows where text is lost when the raw diagnosis above has it.
    func testPrintWhatTheAppMakesOfItWithTiny() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["MENTALITY_WHISPER_DIAG"] == "1" else { throw XCTSkip("Set MENTALITY_WHISPER_DIAG=1 to run the Whisper diagnosis.") }
        try await WhisperEngine.shared.load(.tiny, workers: 2) { _, _ in }
        for (key, language) in [("MENTALITY_E2E_EN", "en"), ("MENTALITY_E2E_AR", "ar")] {
            guard let path = env[key], FileManager.default.fileExists(atPath: path) else { continue }
            for mode in [CleanupMode.none, .deepFilter] {
                let audio = try await AudioPreparer.prepare(input: URL(fileURLWithPath: path), mode: mode, keepCleanedAudio: false, folder: TestAudio.folder()) { _ in }
                                let samples = try AudioSamples.read(audio.speech, range: TimeRange(start: 0, end: audio.duration))
                for settings in [DecodeSettings(), DecodeSettings(language: language)] {
                    let results = try await WhisperEngine.shared.transcribe([samples], settings: settings)
                    let label = "app tiny \(language) \(mode.rawValue) language \(settings.language ?? "auto")"
                    let segments = results.first?.segments ?? []
                    print("DIAG \(label): \(segments.count) segments, language \(results.first?.language ?? "-")")
                    for s in segments {
                        print("DIAG \(label) [\(s.start)–\(s.end)]\(TranscriptQuality.isKnownArtifact(s.text) ? " (known artifact)" : "") \(s.text)")
                    }
                }
                var options = TranscriptionPipeline.Options()
                options.language = nil
                let transcript = try await TranscriptionPipeline(engine: WhisperEngine.shared, options: options, device: DeviceInfo.kind).run(audio: audio, checkpoint: nil) { _, _ in }
                let q = transcript.quality
                print("DIAG pipeline tiny \(language) \(mode.rawValue): \(transcript.segments.count) segments, speech \(Int(transcript.speechSeconds)) s, "
                      + "status \(q.status), artifacts removed \(q.artifactsRemoved), attempts \(q.attempts), languages \(transcript.languages)")
                for s in transcript.segments { print("DIAG pipeline tiny \(language) \(mode.rawValue) [\(s.start)] \(s.text)") }
            }
        }
    }
}
