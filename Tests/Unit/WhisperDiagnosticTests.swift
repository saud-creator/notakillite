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
        let folder = try XCTUnwrap(WhisperEngine.localFolder(.base))
        for (key, language) in [("MENTALITY_E2E_EN", "en"), ("MENTALITY_E2E_AR", "ar")] {
            guard let path = env[key], FileManager.default.fileExists(atPath: path) else { continue }
            let audio = try await AudioPreparer.prepare(input: URL(fileURLWithPath: path), mode: .none, keepCleanedAudio: false, folder: TestAudio.folder()) { _ in }
            let samples = try AudioSamples.read(audio.original, range: TimeRange(start: 0, end: audio.duration))
            for line in try await WhisperDiagnosis.run(samples: samples, language: language, modelFolder: folder) {
                print("DIAG \(language) \(line)")
            }
        }
    }
}
