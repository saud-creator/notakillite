import CoreML
import XCTest
@testable import Mentality

/// Real speech through the real pipeline: audio cleanup → speech detection → WhisperKit → Markdown.
///
/// Runs in CI with spoken English and Arabic made by macOS text-to-speech (see the workflow), using a
/// small test model on the simulator's CPU (MENTALITY_MODEL, "base" by default; the iPadOS 18 simulator
/// computes base wrongly, so that job uses "tiny"). Skipped when the audio isn't provided.
final class WhisperEndToEndTests: XCTestCase {
    private func input(_ key: String) throws -> URL {
        guard let path = ProcessInfo.processInfo.environment[key], FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("Set \(key) (the CI workflow does) to run the end-to-end speech test.")
        }
        return URL(fileURLWithPath: path)
    }

    private func transcribe(_ url: URL, language: LectureLanguage) async throws -> (LectureTranscript, String) {
        try await WhisperEngine.shared.load(.forTests, workers: 2) { _, _ in }
        let audio = try await AudioPreparer.prepare(input: url, mode: .deepFilter, keepCleanedAudio: false, folder: TestAudio.folder()) { _ in }
        var options = TranscriptionPipeline.Options()
        options.language = language.whisperCode
        let transcript = try await TranscriptionPipeline(engine: WhisperEngine.shared, options: options, device: DeviceInfo.kind).run(audio: audio, checkpoint: nil) { _, _ in }
        let markdown = LectureMarkdown.markdown(LectureInfo(title: url.lastPathComponent, course: "CI", number: 1, total: 1, sourceFile: url.lastPathComponent,
                                                            recording: "Recording", cleanup: audio.cleanupLabel), transcript: transcript, instructions: LectureMarkdown.defaultInstructions)
        let out = ProcessInfo.processInfo.environment["MENTALITY_E2E_OUT"].map { URL(fileURLWithPath: $0) }
        if let out {
            try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            try? markdown.write(to: out.appendingPathComponent(url.deletingPathExtension().lastPathComponent + ".md"), atomically: true, encoding: .utf8)
        }
        return (transcript, markdown)
    }

    func testEnglishLecture() async throws {
        let (transcript, markdown) = try await transcribe(try input("MENTALITY_E2E_EN"), language: .auto)
        let text = transcript.segments.map(\.text).joined(separator: " ").lowercased()
        // Words from the start, middle and end that both test models hear correctly.
        for word in ["study", "exam", "ligament", "canal"] { XCTAssertTrue(text.contains(word), "missing \"\(word)\" in: \(text)") }
        XCTAssertEqual(transcript.languages.max(by: { $0.value < $1.value })?.key, "en")
        XCTAssertTrue(markdown.contains("🎯 exam"), "the exam mention is listed for the AI")
        XCTAssertNotEqual(transcript.quality.status, .needsReview)
        XCTAssertLessThan(transcript.speechSeconds, transcript.duration - 2, "pauses are skipped")
    }

    func testArabicLecture() async throws {
        let (transcript, _) = try await transcribe(try input("MENTALITY_E2E_AR"), language: .auto)
        let text = transcript.segments.map(\.text).joined(separator: " ")
        let arabicLetters = text.unicodeScalars.filter { (0x0600...0x06FF).contains($0.value) }.count
        XCTAssertGreaterThan(arabicLetters, 10, "expected Arabic script, got: \(text)")
        XCTAssertEqual(transcript.languages.max(by: { $0.value < $1.value })?.key, "ar")
    }
}

extension WhisperModel {
    /// The test model the CI job picked (MENTALITY_MODEL), base by default.
    static var forTests: WhisperModel {
        ProcessInfo.processInfo.environment["MENTALITY_MODEL"].flatMap(WhisperModel.init(rawValue:)) ?? .base
    }
}

/// Whisper's decoding waits before each token while the app is in the background and over its CPU budget.
final class WhisperCPUPauseTests: XCTestCase {
    func testDecodingWaitsBeforeEachTokenOnlyInTheBackground() throws {
        let budget = CPUBudget(backgroundShare: 0.3, window: 2)
        let filter = CPUPauseFilter(budget: budget)
        let logits = try MLMultiArray(shape: [1, 4], dataType: .float32)
        _ = budget.share()
        let start = Date()
        var x = 0.0
        while Date().timeIntervalSince(start) < 1.2 { x += sin(x + 1) }   // a busy second
        XCTAssertFalse(x.isNaN)

        var began = Date()
        XCTAssertTrue(filter.filterLogits(logits, withTokens: [1, 2]) === logits, "the word choice is left alone")
        XCTAssertLessThan(Date().timeIntervalSince(began), 0.1, "in the foreground decoding never waits")

        budget.setLimited(true)
        began = Date()
        _ = filter.filterLogits(logits, withTokens: [1, 2])
        let waited = Date().timeIntervalSince(began)
        XCTAssertGreaterThan(waited, 0.5, "in the background decoding waits until CPU use is back under the budget")
        XCTAssertLessThan(waited, 5)
    }
}
