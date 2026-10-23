import AVFoundation
import XCTest
import ZIPFoundation
@testable import Notakillite

final class TranscriptFormatterTests: XCTestCase {
    struct Golden: Decodable {
        struct Lecture: Decodable {
            var title: String; var recording: String; var sourceFile: String; var duration: Double; var cleanup: String
            var number: Int; var total: Int; var createdAt: String; var transcript: Transcript
        }
        struct Index: Decodable { var title: String; var createdAt: String; var lectures: [TranscriptFormatter.IndexEntry] }
        struct Expected: Decodable { var lecture: String; var lectureWithoutPrompt: String; var empty: String; var index: String }
        var lecture: Lecture; var index: Index; var expected: Expected
    }

    private func date(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)!
    }

    /// The Windows app (Node) and this app must write byte-identical Markdown.
    func testMatchesSharedGoldenFile() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "transcript-golden", withExtension: "json"))
        let golden = try JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
        let l = golden.lecture
        func lecture(_ prompt: Bool) -> String {
            TranscriptFormatter.lectureMarkdown(title: l.title, recording: l.recording, sourceFile: l.sourceFile, duration: l.duration, cleanup: l.cleanup, transcript: l.transcript, createdAt: date(l.createdAt), includePrompt: prompt, number: l.number, total: l.total)
        }
        XCTAssertEqual(lecture(true), golden.expected.lecture)
        XCTAssertEqual(lecture(false), golden.expected.lectureWithoutPrompt)
        XCTAssertEqual(TranscriptFormatter.lectureMarkdown(title: "Empty", recording: "r", sourceFile: "s", duration: 0, cleanup: "None", transcript: Transcript(language: "en", model: "m", device: nil, segments: []), createdAt: date(l.createdAt)), golden.expected.empty)
        XCTAssertEqual(TranscriptFormatter.indexMarkdown(title: golden.index.title, lectures: golden.index.lectures, createdAt: date(golden.index.createdAt)), golden.expected.index)
    }

    func testTimestampsAndParagraphs() {
        XCTAssertEqual(TranscriptFormatter.timestamp(3725.9), "01:02:05")
        let blocks = TranscriptFormatter.paragraphs([SpeechSegment(start: 0, end: 2, text: "a"), SpeechSegment(start: 2.5, end: 4, text: "b"), SpeechSegment(start: 9, end: 10, text: "c")])
        XCTAssertEqual(blocks.map(\.text), ["a b", "c"])
    }
}

final class NoteImporterTests: XCTestCase {
    private var folder: URL!
    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: folder) }

    private func add(_ archive: Archive, _ path: String, _ data: Data) throws {
        try archive.addEntry(with: path, type: .file, uncompressedSize: Int64(data.count), compressionMethod: .deflate) { position, size in
            let start = Int(position)
            return data.subdata(in: start..<min(data.count, start + Int(size)))
        }
    }

    func testNoteExportRecordingsFollowLibraryOrder() throws {
        let note = folder.appendingPathComponent("Anatomy L3.note")
        let archive = try Archive(url: note, accessMode: .create)
        let a = Data("....ftypM4A first".utf8), b = Data("....ftypM4A second".utf8)
        try add(archive, "Anatomy L3/Session.plist", Data("bplist00".utf8))
        try add(archive, "Anatomy L3/Recordings/library.plist", Data("bplist00 2B6F-rec.m4a 1A2C-rec.m4a".utf8))
        try add(archive, "Anatomy L3/Recordings/1A2C-rec.m4a", a)
        try add(archive, "Anatomy L3/Recordings/2B6F-rec.m4a", b)
        try add(archive, "Anatomy L3/Images/page.png", Data([0x89, 0x50]))

        let items = try NoteImporter.expand([note], into: folder.appendingPathComponent("out"))
        XCTAssertEqual(items.map(\.recordingName), ["Recording 1", "Recording 2"])
        XCTAssertEqual(items.map(\.title), ["Anatomy L3", "Anatomy L3"])
        XCTAssertEqual(try Data(contentsOf: items[0].file), b)
        XCTAssertEqual(try Data(contentsOf: items[1].file), a)
    }

    func testEmptyNoteExplainsHowToExportRecordings() throws {
        let note = folder.appendingPathComponent("Empty.note")
        let archive = try Archive(url: note, accessMode: .create)
        try add(archive, "Empty/Session.plist", Data("bplist00".utf8))
        XCTAssertThrowsError(try NoteImporter.expand([note], into: folder)) { error in
            XCTAssertTrue(error.localizedDescription.contains("Note"))
        }
    }
}

final class AudioProcessorTests: XCTestCase {
    func testProcessingWritesCleanedAudioAndSpeechWav() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        // Three seconds of a 440 Hz tone at 44.1 kHz stereo, to exercise resampling and downmixing.
        let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2)!
        let input = folder.appendingPathComponent("tone.caf")
        let file = try AVAudioFile(forWriting: input, settings: format.settings)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 132_300)!
        buffer.frameLength = 132_300
        for channel in 0..<2 { for i in 0..<Int(buffer.frameLength) { buffer.floatChannelData![channel][i] = 0.2 * sin(Float(i) * 2 * .pi * 440 / 44_100) } }
        try file.write(from: buffer)

        let result = try AudioProcessor.process(input: input, mode: .none, workFolder: folder.appendingPathComponent("work")) { _ in }
        XCTAssertEqual(result.duration, 3, accuracy: 0.05)
        let speech = try AVAudioFile(forReading: result.speechWAV)
        XCTAssertEqual(speech.fileFormat.sampleRate, 16_000)
        XCTAssertEqual(Double(speech.length) / 16_000, 3, accuracy: 0.05)
        XCTAssertGreaterThan(try AVAudioFile(forReading: result.cleanedM4A).length, 0)
        let quiet = try AudioProcessor.quietPoint(in: result.speechWAV, near: 1.5, window: 1)
        XCTAssertTrue((0.5...2.5).contains(quiet))
    }
}
