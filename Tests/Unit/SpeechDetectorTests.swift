import XCTest
@testable import Mentality

final class SpeechDetectorTests: XCTestCase {
    func testThresholdAdaptsToTheNoiseFloor() {
        // Speech around −22 dB, pauses at −38 dB with short −33 dB peaks: a fixed −35 dB detector finds nothing.
        var levels: [Double] = []
        for _ in 0..<120 {
            for i in 0..<40 { levels.append(-22 + Double(i % 5)) }
            for i in 0..<8 { levels.append(i == 3 ? -33 : -38) }
        }
        let (pauses, threshold) = SpeechDetector.silences(levels)
        XCTAssertGreaterThanOrEqual(pauses.count, 110)
        XCTAssertGreaterThan(threshold, -35)
        XCTAssertLessThan(threshold, -25)
        XCTAssertEqual(SpeechDetector.silences(Array(repeating: -20, count: 500)).0.count, 0, "continuous loud audio has no pauses")
    }

    func testFindsSpeechInAFile() throws {
        let url = TestAudio.folder().appendingPathComponent("speech.wav")
        try TestAudio.writeSpeechLike(url, pattern: [(0, 2), (5, 3), (4, 1)], amplitude: 0.5, noise: 0.002)
        let analysis = try SpeechDetector.analyze(url)
        XCTAssertEqual(analysis.duration, 15, accuracy: 0.01)
        XCTAssertEqual(analysis.speech.count, 2, "\(analysis.speech)")
        XCTAssertEqual(analysis.speech[0].start, 2, accuracy: 0.15)
        XCTAssertEqual(analysis.speech[0].end, 7, accuracy: 0.15)
        XCTAssertEqual(analysis.speechSeconds, 9, accuracy: 0.4)
    }

    func testChunksSkipLongSilencesAndStayShort() {
        let speech = [TimeRange(start: 1, end: 5), TimeRange(start: 5.8, end: 9), TimeRange(start: 30, end: 100), TimeRange(start: 200, end: 200.05)]
        let levels = Array(repeating: -20.0, count: 2100)
        let chunks = SpeechDetector.chunks(speech: speech, levels: levels, duration: 210)
        XCTAssertEqual(chunks.first?.start ?? -1, 0.75, accuracy: 0.001)
        XCTAssertEqual(chunks.first?.end ?? -1, 9.25, accuracy: 0.001, "short pauses stay inside one piece")
        XCTAssertTrue(chunks.allSatisfy { $0.length <= 28.001 }, "\(chunks)")
        XCTAssertFalse(chunks.contains { $0.start < 29 && $0.end > 10 }, "the 21-second pause is skipped")
        XCTAssertFalse(chunks.contains { $0.start >= 199 }, "a 0.05 s click is not sent to Whisper")
        let covered = chunks.filter { $0.start >= 29 }.reduce(0) { $0 + $1.length }
        XCTAssertEqual(covered, 70.5, accuracy: 0.01, "long speech is split without losing audio")
        for (a, b) in zip(chunks, chunks.dropFirst()) { XCTAssertLessThanOrEqual(a.end, b.start + 1e-9) }
    }

    func testLongSpeechIsCutAtTheQuietestMoment() {
        var levels = Array(repeating: -20.0, count: 600)
        levels[250] = -50   // 25.0–25.1 s
        let parts = SpeechDetector.split(TimeRange(start: 0, end: 60), levels: levels, maxSeconds: 28)
        XCTAssertEqual(parts.first?.end ?? 0, 25.05, accuracy: 0.001)
        XCTAssertEqual(parts.last?.end, 60)
    }

    func testQualityPartsAreCutInPauses() {
        let silences = [TimeRange(start: 290, end: 291), TimeRange(start: 610, end: 612)]
        let cuts = SpeechDetector.cuts(duration: 950, silences: silences, target: 300, window: 60)
        XCTAssertEqual(cuts.count, 2)
        XCTAssertEqual(cuts[0], 290.5, accuracy: 0.001)
        XCTAssertEqual(cuts[1], 611, accuracy: 0.001)
    }
}
