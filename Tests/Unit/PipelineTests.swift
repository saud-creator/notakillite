import XCTest
@testable import Mentality

/// The whole transcription pipeline with a scripted engine: loops are caught and repaired from the
/// original audio, unfixable parts become visible markers, and an interrupted lecture resumes.
final class PipelineTests: XCTestCase {
    /// 7 minutes (8 s of "speech", 2 s pause), so the quality check has two parts: about 5 minutes and 2.
    private let pattern = TestAudio.repeating(8, 2, count: 42)

    private func audio(cleanedLoops: Bool, originalLoops: Bool) throws -> PreparedAudio {
        let folder = TestAudio.folder()
        let speech = folder.appendingPathComponent("speech-16k.wav"), original = folder.appendingPathComponent("original-16k.wav")
        let duration = try TestAudio.writeSpeechLike(speech, pattern: pattern, amplitude: cleanedLoops ? 0.6 : 0.3)
        try TestAudio.writeSpeechLike(original, pattern: pattern, amplitude: originalLoops ? 0.6 : 0.3)
        return PreparedAudio(original: original, speech: speech, cleanedM4A: nil, duration: duration, cleanupLabel: "test")
    }

    private let loopSentence = "So deep membranous fascia is called fascia of the thigh."

    func testCleanLectureIsOkFirstTime() async throws {
        let engine = FakeEngine()
        let result = try await TranscriptionPipeline(engine: engine, options: .init()).run(audio: try audio(cleanedLoops: false, originalLoops: false), checkpoint: nil) { _, _ in }
        XCTAssertEqual(result.quality.status, .ok)
        XCTAssertEqual(result.quality.attempts, 0)
        XCTAssertGreaterThan(result.words, 300)
        XCTAssertEqual(result.duration, 420, accuracy: 0.1)
        XCTAssertEqual(result.speechSeconds, 336, accuracy: 3, "pauses are not counted as speech")
        XCTAssertEqual(result.languages.keys.sorted(), ["ar", "en"])
        XCTAssertEqual(engine.settingsSeen.first?.language, nil, "Auto detects the language of every piece")
        for (a, b) in zip(result.segments, result.segments.dropFirst()) { XCTAssertLessThanOrEqual(a.start, b.start) }
        XCTAssertTrue(result.segments.allSatisfy { $0.end <= 420.01 })
    }

    func testRepetitionLoopIsRepairedFromTheOriginalAudio() async throws {
        let engine = FakeEngine()
        let result = try await TranscriptionPipeline(engine: engine, options: .init()).run(audio: try audio(cleanedLoops: true, originalLoops: false), checkpoint: nil) { _, _ in }
        XCTAssertEqual(result.quality.status, .repaired, "\(result.quality)")
        XCTAssertEqual(result.quality.repairs.map(\.detail), ["original audio", "original audio"])
        XCTAssertFalse(result.segments.contains { $0.text == loopSentence }, "no looped text is exported")
        XCTAssertFalse(result.segments.contains(where: \.marker))
        XCTAssertGreaterThan(result.words, 300)
        XCTAssertTrue(TranscriptQuality.audit(result.segments, duration: 420).ok)
    }

    func testUnfixablePartsBecomeVisibleMarkersInsteadOfGuesses() async throws {
        let engine = FakeEngine()
        let result = try await TranscriptionPipeline(engine: engine, options: .init()).run(audio: try audio(cleanedLoops: true, originalLoops: true), checkpoint: nil) { _, _ in }
        XCTAssertEqual(result.quality.status, .needsReview)
        XCTAssertEqual(result.quality.unresolved.count, 2)
        XCTAssertTrue(result.segments.contains(where: \.marker))
        let markdown = LectureMarkdown.markdown(LectureInfo(title: "T", course: "C", number: 1, total: 1, sourceFile: "s", recording: "r", cleanup: "c"),
                                                transcript: result, instructions: nil)
        XCTAssertTrue(markdown.contains("Needs review"))
        XCTAssertTrue(markdown.contains("> ⚠ **["))
        let leftovers = result.segments.filter { $0.text == loopSentence }.count
        XCTAssertLessThan(leftovers, 4, "repeated text is replaced by markers, not exported (\(leftovers) left)")
    }

    func testInterruptedLectureContinuesFromTheCheckpoint() async throws {
        let prepared = try audio(cleanedLoops: false, originalLoops: false)
        let checkpoint = TestAudio.folder().appendingPathComponent("checkpoint.json")
        var options = TranscriptionPipeline.Options()
        options.batchSize = 2

        let first = FakeEngine()
        first.failAfterCalls = 1
        do {
            _ = try await TranscriptionPipeline(engine: first, options: options).run(audio: prepared, checkpoint: checkpoint) { _, _ in }
            XCTFail("the first run should stop")
        } catch is FakeEngine.Stop {}
        XCTAssertEqual(first.piecesSeen, 2)

        let second = FakeEngine()
        let result = try await TranscriptionPipeline(engine: second, options: options).run(audio: prepared, checkpoint: checkpoint) { _, _ in }
        let saved = try JSONDecoder().decode(TranscriptionPipeline.Checkpoint.self, from: Data(contentsOf: checkpoint))
        XCTAssertEqual(second.piecesSeen, saved.chunks.count - 2, "pieces already done are not transcribed again")
        XCTAssertEqual(result.quality.status, .ok)
    }

    func testCheckpointFromOtherSettingsIsNotReused() async throws {
        let prepared = try audio(cleanedLoops: false, originalLoops: false)
        let checkpoint = TestAudio.folder().appendingPathComponent("checkpoint.json")
        var options = TranscriptionPipeline.Options()
        options.checkpointKey = "large-v3|auto"
        _ = try await TranscriptionPipeline(engine: FakeEngine(), options: options).run(audio: prepared, checkpoint: checkpoint) { _, _ in }
        options.checkpointKey = "turbo|ar"
        let engine = FakeEngine()
        _ = try await TranscriptionPipeline(engine: engine, options: options).run(audio: prepared, checkpoint: checkpoint) { _, _ in }
        let saved = try JSONDecoder().decode(TranscriptionPipeline.Checkpoint.self, from: Data(contentsOf: checkpoint))
        XCTAssertEqual(engine.piecesSeen, saved.chunks.count, "a different model or language transcribes everything again")
    }

    func testAutoLanguageOnlyChoosesArabicOrEnglish() {
        XCTAssertEqual(WhisperEngine.arabicOrEnglish(["ar": -0.4, "en": -1.2, "fa": -0.1], detected: "fa"), "ar")
        XCTAssertEqual(WhisperEngine.arabicOrEnglish(["ar": -2.0, "en": -0.3], detected: "en"), "en")
        XCTAssertEqual(WhisperEngine.arabicOrEnglish(["ur": -0.2], detected: "ur"), "ar", "Persian/Urdu guesses count as Arabic")
        XCTAssertEqual(WhisperEngine.arabicOrEnglish([:], detected: "en"), "en")
    }

    func testPlacingSegmentsUsesLectureTimeAndDropsArtifacts() {
        var artifacts = 0
        let placed = TranscriptionPipeline.place([
            (TimeRange(start: 100, end: 110), PieceResult(segments: [
                SpeechSegment(start: 0.5, end: 4, text: " Hello   there "),
                SpeechSegment(start: 4, end: 30, text: "runs past the piece"),
                SpeechSegment(start: 8, end: 9, text: "Thanks for watching!"),
            ], language: "en")),
            (TimeRange(start: 50, end: 60), PieceResult(segments: [SpeechSegment(start: 1, end: 2, text: "Earlier")], language: "ar")),
        ], artifacts: &artifacts)
        XCTAssertEqual(artifacts, 1)
        XCTAssertEqual(placed.map(\.text), ["Earlier", "Hello there", "runs past the piece"])
        XCTAssertEqual(placed[1].start, 100.5)
        XCTAssertEqual(placed[2].end, 110, "times stay inside their piece")
        XCTAssertEqual(placed[0].language, "ar")
    }
}
