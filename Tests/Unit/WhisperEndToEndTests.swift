import XCTest
@testable import Mentality

/// Real speech through the real pipeline: audio cleanup → speech detection → WhisperKit → Markdown.
///
/// Runs in CI with spoken English and Arabic made by macOS text-to-speech (see the workflow), using the
/// small "base" model on the simulator's CPU. Skipped when the audio isn't provided.
final class WhisperEndToEndTests: XCTestCase {
    private func input(_ key: String) throws -> URL {
        guard let path = ProcessInfo.processInfo.environment[key], FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("Set \(key) (the CI workflow does) to run the end-to-end speech test.")
        }
        return URL(fileURLWithPath: path)
    }

    private func transcribe(_ url: URL, language: LectureLanguage) async throws -> (LectureTranscript, String) {
        try await WhisperEngine.shared.load(.base, workers: 2) { _, _ in }
        let audio = try AudioPreparer.prepare(input: url, mode: .lowCut, keepCleanedAudio: false, folder: TestAudio.folder()) { _ in }
        var options = TranscriptionPipeline.Options()
        options.language = language.whisperCode
        let transcript = try await TranscriptionPipeline(engine: WhisperEngine.shared, options: options).run(audio: audio, checkpoint: nil) { _, _ in }
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
        for word in ["abdominal", "exam", "ligament"] { XCTAssertTrue(text.contains(word), "missing \"\(word)\" in: \(text)") }
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
