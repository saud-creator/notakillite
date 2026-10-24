import XCTest
@testable import Mentality

final class OutputTests: XCTestCase {
    private func transcript(_ segments: [SpeechSegment], quality: QualityInfo = QualityInfo(status: .ok)) -> LectureTranscript {
        LectureTranscript(segments: segments, model: "Whisper large-v3 (WhisperKit, on-device)", device: "iPad", duration: 3705.5,
                          speechSeconds: 3000, languages: ["ar": 0.7, "en": 0.3], quality: quality)
    }

    private var info: LectureInfo {
        var info = LectureInfo(title: "Anatomy: \"L3\" | wall", course: "Anatomy week 3", number: 3, total: 5, sourceFile: "Anatomy L3.note",
                               recording: "Recording 1", cleanup: "Apple Voice Isolation + rumble filter")
        info.createdAt = ISO8601DateFormatter().date(from: "2026-10-23T10:00:00Z")!
        return info
    }

    func testTimestampsAndDurations() {
        XCTAssertEqual(LectureMarkdown.timestamp(0), "00:00:00")
        XCTAssertEqual(LectureMarkdown.timestamp(3705.9), "01:01:45")
        XCTAssertEqual(LectureMarkdown.timestamp(-3), "00:00:00")
        XCTAssertEqual(LectureMarkdown.durationLabel(3600 + 59), "1 h 0 min")
        XCTAssertEqual(LectureMarkdown.durationLabel(20), "1 min")
        XCTAssertEqual(LectureMarkdown.yaml("a \"b\" \\ c\n"), "\"a \\\"b\\\" \\\\ c\\n\"")
    }

    func testParagraphsBreakAtPausesAndAfterAMinute() {
        let blocks = LectureMarkdown.paragraphs([
            SpeechSegment(start: 0.2, end: 4.8, text: " اليوم نتكلم عن the anterior abdominal wall"),
            SpeechSegment(start: 5, end: 9.5, text: "وهذا   مهم جداً للامتحان."),
            SpeechSegment(start: 14, end: 18, text: "Next, the rectus sheath."),
            SpeechSegment(start: 18.5, end: 80, text: "A very long explanation."),
            SpeechSegment(start: 80.5, end: 82, text: "New paragraph because of the cap."),
            SpeechSegment(start: 90, end: 95, text: "Not reliably transcribed.", marker: true),
            SpeechSegment(start: 95.5, end: 96, text: "   "),
        ])
        XCTAssertEqual(blocks.count, 5)
        XCTAssertEqual(blocks[0].text, "اليوم نتكلم عن the anterior abdominal wall وهذا مهم جداً للامتحان.")
        XCTAssertEqual(blocks[1].text, "Next, the rectus sheath.")
        XCTAssertEqual(blocks[2].text, "A very long explanation.")
        XCTAssertTrue(blocks[4].marker)
    }

    func testEmphasisFinderFindsExamAndStressInArabicAndEnglish() {
        XCTAssertEqual(EmphasisFinder.kind(of: "وهذا مهم جداً للامتحان."), .exam)
        XCTAssertEqual(EmphasisFinder.kind(of: "انتبهوا لهذي النقطة"), .stressed)
        XCTAssertEqual(EmphasisFinder.kind(of: "This is very important, remember this."), .stressed)
        XCTAssertEqual(EmphasisFinder.kind(of: "It always comes in the exam, they always ask about it."), .exam)
        XCTAssertEqual(EmphasisFinder.kind(of: "هذا السؤال جاء في الكويز السابق"), .exam)
        XCTAssertEqual(EmphasisFinder.kind(of: "أحفظوا التعريف"), .stressed, "hamza forms are unified")
        XCTAssertNil(EmphasisFinder.kind(of: "The testis descends through the inguinal canal."), "no partial-word matches")
        XCTAssertNil(EmphasisFinder.kind(of: "اليوم نتكلم عن جدار البطن"))
        let hints = EmphasisFinder.hints([
            SpeechSegment(start: 10, end: 12, text: "Plain sentence."),
            SpeechSegment(start: 20, end: 25, text: "هذا مهم"),
            SpeechSegment(start: 30, end: 35, text: "Skipped part", marker: true),
        ])
        XCTAssertEqual(hints, [EmphasisFinder.Hint(start: 20, kind: .stressed, text: "هذا مهم")])
    }

    func testMarkdownLayoutForTheAI() {
        let md = LectureMarkdown.markdown(info, transcript: transcript([
            SpeechSegment(start: 0.2, end: 4.8, text: "اليوم نتكلم عن the anterior abdominal wall"),
            SpeechSegment(start: 5, end: 9.5, text: "وهذا مهم جداً للامتحان."),
            SpeechSegment(start: 14, end: 18, text: "Next, the rectus sheath."),
        ]), instructions: "Make questions.")
        XCTAssertTrue(md.hasPrefix("---\ntitle: \"Anatomy: \\\"L3\\\" | wall\"\ncourse: \"Anatomy week 3\"\nlecture: 3 of 5\n"), md)
        XCTAssertTrue(md.contains("\nduration: \"01:01:45\"\n"))
        XCTAssertTrue(md.contains("\nlanguage: \"Arabic 70 %, English 30 %\"\n"))
        XCTAssertTrue(md.contains("\nwords: 15\n"))
        XCTAssertTrue(md.contains("\nquality: \"ok — passed the automatic quality check\"\n"))
        XCTAssertTrue(md.contains("\ncreated: \"2026-10-23\"\n---\n\n# Anatomy: \"L3\" | wall\n\n## Instructions for the AI\n\n> Make questions.\n\n"))
        XCTAssertTrue(md.contains("## Lecturer emphasis (auto-detected)"))
        XCTAssertTrue(md.contains("- 🎯 exam **[00:00:05]** وهذا مهم جداً للامتحان."))
        XCTAssertTrue(md.hasSuffix("## Transcript\n\n**[00:00:00]** اليوم نتكلم عن the anterior abdominal wall وهذا مهم جداً للامتحان.\n\n**[00:00:14]** Next, the rectus sheath.\n"), md)
    }

    func testNeedsReviewAndMarkersAreVisible() {
        let quality = QualityInfo(status: .needsReview, unresolved: [.init(start: 300, end: 600, detail: "repeated-sentence")])
        let md = LectureMarkdown.markdown(info, transcript: transcript([
            SpeechSegment(start: 10, end: 15, text: "Fine."),
            SpeechSegment(start: 300, end: 420, text: "Not reliably transcribed (00:05:00–00:07:00). Check the audio.", marker: true),
        ], quality: quality), instructions: nil)
        XCTAssertTrue(md.contains("> ⚠ **Needs review:** 1 part(s)"))
        XCTAssertTrue(md.contains("> ⚠ **[00:05:00–00:07:00]** Not reliably transcribed"))
        XCTAssertFalse(md.contains("Instructions for the AI"))
        XCTAssertFalse(md.contains("Lecturer emphasis"))
        XCTAssertTrue(md.contains("\nwords: 1\n"), "markers are not counted as words")
    }

    func testEmptyLectureAndPlainTextAndIndex() {
        let empty = LectureMarkdown.markdown(info, transcript: transcript([]), instructions: nil)
        XCTAssertTrue(empty.hasSuffix("## Transcript\n\n_No speech was detected in this recording._\n"))
        let text = LectureMarkdown.plainText(info, transcript: transcript([SpeechSegment(start: 61, end: 64, text: "Remember this definition.")]), instructions: "Go.")
        XCTAssertTrue(text.hasPrefix("Anatomy: \"L3\" | wall\nCourse: Anatomy week 3 · Lecture 3 of 5\n"))
        XCTAssertTrue(text.contains("LECTURER EMPHASIS (auto-detected, check in context)\n[00:01:01] (stressed) Remember this definition."))
        XCTAssertTrue(text.hasSuffix("TRANSCRIPT\n[00:01:01] Remember this definition.\n"))
        let index = LectureMarkdown.index(course: "Week 3", lectures: [
            .init(number: 1, title: "Intro | overview", duration: 3000, words: 5000, quality: "ok", file: "01 - Intro.md"),
            .init(number: 2, title: "No speech", duration: 59, words: 0, quality: "ok", file: nil),
        ], createdAt: info.createdAt)
        XCTAssertTrue(index.contains("2 lectures · 50 min of audio · 2026-10-23"))
        XCTAssertTrue(index.contains("| 1 | Intro \\| overview | 00:50:00 | 5000 | ok | [01 - Intro.md](<01 - Intro.md>) |"))
        XCTAssertTrue(index.contains("| 2 | No speech | 00:00:59 | 0 | ok | — |"))
    }

    func testLanguageLabel() {
        XCTAssertEqual(LectureMarkdown.languageLabel(["ar": 0.97, "en": 0.03]), "Arabic")
        XCTAssertEqual(LectureMarkdown.languageLabel(["en": 1]), "English")
        XCTAssertEqual(LectureMarkdown.languageLabel([:]), "Unknown")
        XCTAssertEqual(LectureMarkdown.languageLabel(["en": 0.5, "ar": 0.5]), "Arabic 50 %, English 50 %")
    }

    func testFileNamesAreSafe() {
        XCTAssertEqual(safeFileName("a/b:c?"), "a-b-c-")
        XCTAssertEqual(safeFileName("  ..  "), "Lecture")
        XCTAssertEqual(safeFileName("محاضرة ١"), "محاضرة ١")
    }
}
