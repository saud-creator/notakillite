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

    /// Real speech in a room with mains hum and air-conditioning noise only 8 dB below it, like the CI's
    /// noisy lectures (ci/mix-noise.py). Measured in the speech band, most of the speech is still found;
    /// measured over the full band with the old 6 dB margin, less than half of it was.
    func testHumAndRoomNoiseDoNotHideSpeech() throws {
        guard let assets = ProcessInfo.processInfo.environment["MENTALITY_NOISE_ASSETS"], !assets.isEmpty else {
            throw XCTSkip("Set MENTALITY_NOISE_ASSETS (the CI workflow does) to test with real speech.")
        }
        let recording = try NoiseModelTests.read48k(URL(fileURLWithPath: assets).appendingPathComponent("clean_freesound_33711.wav"))
        let voice = TestAudio.resample(recording, from: 48_000, to: 16_000)
        // About two minutes of 3-second phrases from the recording, with 1.4 s pauses.
        var clean = [Float](repeating: 0, count: 16_000)
        var start = 0
        while clean.count < 16_000 * 120 {
            if start + 48_000 > voice.count { start = 0 }
            clean += voice[start..<(start + 48_000)]
            clean += [Float](repeating: 0, count: 22_400)
            start += 37_000
        }
        let noisy = TestAudio.mix(clean, TestAudio.roomNoise(count: clean.count, rate: 16_000), snr: 8)
        let folder = TestAudio.folder()
        let cleanURL = folder.appendingPathComponent("clean.wav"), noisyURL = folder.appendingPathComponent("noisy.wav")
        try TestAudio.write(clean, rate: 16_000, to: cleanURL)
        try TestAudio.write(noisy, rate: 16_000, to: noisyURL)

        let truth = try SpeechDetector.analyze(cleanURL).speechSeconds
        let found = try SpeechDetector.analyze(noisyURL).speechSeconds
        XCTAssertGreaterThan(truth, 70, "the test lecture has enough speech")
        XCTAssertGreaterThan(found, truth * 0.8, "speech found in the noisy room: \(found) s of \(truth) s")
        XCTAssertLessThan(found, truth + 15, "the pauses are still pauses: \(found) s of \(truth) s")
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

    func testQuietSpeechCloseToTheNoiseFloorIsStillTranscribed() throws {
        // Air-conditioning hiss everywhere, a quiet lecturer only ~6 dB above it from 6 s to 12 s.
        let url = TestAudio.folder().appendingPathComponent("quiet.wav")
        try TestAudio.writeSpeechLike(url, pattern: [(0, 6), (6, 6)], amplitude: 0.06, noise: 0.02)
        let analysis = try SpeechDetector.analyze(url)
        let kept = analysis.keep.reduce(0) { $0 + $1.overlap(TimeRange(start: 6, end: 12)) }
        XCTAssertGreaterThan(kept, 5.5, "keep: \(analysis.keep), threshold \(analysis.threshold)")
        let chunks = SpeechDetector.chunks(speech: analysis.keep, levels: analysis.levels, duration: analysis.duration)
        XCTAssertTrue(chunks.contains { $0.overlap(TimeRange(start: 6, end: 12)) > 5.5 }, "\(chunks)")
    }

    func testShortStretchesAreMergedIntoLongerPieces() {
        // Short phrases separated by 4-second pauses: one piece, not many 1-second clips.
        let speech = (0..<4).map { TimeRange(start: Double($0) * 5, end: Double($0) * 5 + 1) }
        let chunks = SpeechDetector.chunks(speech: speech, levels: Array(repeating: -20, count: 300), duration: 30)
        XCTAssertEqual(chunks.count, 1, "\(chunks)")
        XCTAssertEqual(chunks[0].length, 16.25, accuracy: 0.01)
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
