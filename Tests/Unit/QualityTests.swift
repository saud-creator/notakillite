import XCTest
@testable import Mentality

/// The quality check must give the same verdicts as Notakillite's Windows implementation on the
/// shared cases (including the real incident: one sentence repeated 971 times).
final class QualityTests: XCTestCase {
    struct Cases: Decodable {
        struct Options: Decodable {
            struct Piece: Decodable { var index: Int; var start: Double; var end: Double }
            var duration: Double?
            var speech: [TimeRange]?
            var pieces: [Piece]?
        }
        struct Expected: Decodable { var status: String; var kinds: [String] }
        struct Case: Decodable { var name: String; var options: Options; var segments: [SpeechSegment]; var expected: Expected }
        var cases: [Case]
    }

    func testSharedCasesGiveTheSameVerdictsAsTheWindowsApp() throws {
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: TestAudio.fixture("quality-cases", "json")))
        XCTAssertEqual(cases.cases.count, 5)
        for c in cases.cases {
            let pieces = c.options.pieces?.map { TranscriptQuality.Piece(index: $0.index, start: $0.start, end: $0.end) }
            let report = TranscriptQuality.audit(c.segments, duration: c.options.duration, pieces: pieces, speech: c.options.speech)
            XCTAssertEqual(report.ok ? "ok" : "failed", c.expected.status, "\(c.name): \(report.findings.prefix(3))")
            for kind in c.expected.kinds { XCTAssertTrue(report.kinds.contains(kind), "\(c.name) should find \(kind); found \(report.kinds)") }
        }
    }

    func testIncidentIsFlaggedFromWhereItStarts() throws {
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: TestAudio.fixture("quality-cases", "json")))
        let incident = try XCTUnwrap(cases.cases.first { $0.name == "incident-971-repeats" })
        let report = TranscriptQuality.audit(incident.segments, duration: 2514)
        let repeated = try XCTUnwrap(report.findings.first { $0.kind == "repeated-sentence" })
        XCTAssertGreaterThanOrEqual(repeated.start, 236)
        XCTAssertLessThan(repeated.start, 250)
        XCTAssertTrue(report.pieces.filter { $0.piece.start >= 300 }.allSatisfy { !$0.ok })
        XCTAssertLessThan(TranscriptQuality.score(report), 0.2)
    }

    func testLecturerEmphasisAndCodeSwitchingAreNotFlagged() {
        let definition = "The inguinal ligament is formed by the external oblique aponeurosis."
        var segments: [SpeechSegment] = []
        for i in 0..<60 { segments.append(SpeechSegment(start: Double(i) * 10, end: Double(i) * 10 + 8, text: FakeText.sentence(i, words: 14))) }
        segments.append(SpeechSegment(start: 30.5, end: 31, text: "Okay? Okay?"))
        segments.append(SpeechSegment(start: 120.1, end: 125, text: "\(definition) \(definition)"))
        segments.append(SpeechSegment(start: 240.3, end: 245, text: definition))
        let arabic = ["اليوم نتكلم عن the anterior abdominal wall وهذا مهم جداً للامتحان.", "الـ external oblique aponeurosis تكوّن الـ inguinal ligament.",
                      "لاحظوا أن الـ iliohypogastric nerve يمر بين الـ internal oblique و transversus abdominis.", "هذا السؤال جاء في الكويز السابق عن الـ rectus sheath."]
        for (i, line) in arabic.enumerated() { segments.append(SpeechSegment(start: 400 + Double(i) * 9, end: 407 + Double(i) * 9, text: line)) }
        segments.sort { $0.start < $1.start }
        let report = TranscriptQuality.audit(segments, duration: 600)
        XCTAssertTrue(report.ok, "\(report.findings)")
    }

    func testKnownArtifactsOnlyAsWholeSegments() {
        for t in ["Subtitles by the Amara.org community", "ترجمة نانسي قنقر", "Please subscribe to my channel.", "Thanks for watching!"] {
            XCTAssertTrue(TranscriptQuality.isKnownArtifact(t), t)
        }
        for t in ["The subtitles by the professor are on the slide.", "So, everybody has signed the sheet.", "Thank you."] {
            XCTAssertFalse(TranscriptQuality.isKnownArtifact(t), t)
        }
    }

    func testSimilarityAndNormalisation() {
        XCTAssertEqual(TranscriptQuality.similarity("so deep membranous fascia", "so deep membranous fascia"), 1)
        XCTAssertGreaterThan(TranscriptQuality.similarity("the fascia latae of the thigh known as", "the fascia lata of the thigh is known as"), 0.8)
        XCTAssertLessThan(TranscriptQuality.similarity("the inguinal ligament is formed by the external oblique", "the conjoint tendon is formed by the internal oblique"), 0.9)
        XCTAssertEqual(TranscriptQuality.normalize("  Hello,   WORLD!! "), "hello world")
        XCTAssertEqual(TranscriptQuality.words("Don't stop — it's 5 o'clock."), ["don't", "stop", "it's", "5", "o'clock"])
        XCTAssertEqual(TranscriptQuality.splitSentences("One. Two?  Three!Four"), ["One.", "Two?", "Three!Four"])
    }

    func testRepetitionInsideOneSegmentIsFlagged() {
        let loop = Array(repeating: "the rectus sheath is", count: 12).joined(separator: " ")
        let report = TranscriptQuality.audit([SpeechSegment(start: 0, end: 25, text: loop)], duration: 30)
        XCTAssertTrue(report.kinds.contains("internal-repetition") || report.kinds.contains("compressible"), "\(report.kinds)")
    }
}
