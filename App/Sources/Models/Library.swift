import Foundation

/// One import: a course or a group of lectures that were added together.
struct Course: Identifiable, Codable, Equatable, Sendable {
    var id = UUID()
    var title: String
    var folderName: String          // under Documents/Lectures
    var created = Date()
}

struct Lecture: Identifiable, Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case queued, preparing, transcribing, done, needsReview, failed, cancelled }

    var id = UUID()
    var courseID: UUID
    var order: Int
    var title: String
    var recordingName: String
    var sourceName: String
    var sourceFile: String           // path relative to Storage.sources
    var status = Status.queued
    var phase = "Waiting"
    var progress = 0.0
    var error: String?
    var duration = 0.0
    var words = 0
    var outputs: [String] = []       // file names in the course folder
    var cleanedAudio: String?
    var qualityLabel: String?
    var added = Date()
    var finished: Date?

    var displayTitle: String { recordingName.hasPrefix("Recording ") ? "\(title) - \(recordingName)" : title }
    var isActive: Bool { status == .preparing || status == .transcribing }
    var isFinished: Bool { status == .done || status == .needsReview }
    var fileStem: String { "\(String(format: "%02d", order)) - \(safeFileName(displayTitle))" }
}

/// Where the app keeps things. Paths are stored relative to these folders because the app's
/// container path changes when the app is reinstalled or updated.
enum Storage {
    static let fm = FileManager.default
    static var support: URL { folder(fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Mentality", isDirectory: true)) }
    /// Imported recordings, kept until the user deletes the lecture, so any lecture can be redone.
    static var sources: URL { folder(support.appendingPathComponent("Sources", isDirectory: true)) }
    /// Prepared audio and progress checkpoints.
    static var work: URL { folder(support.appendingPathComponent("Work", isDirectory: true)) }
    /// Transcripts, visible in Files → On My iPad → Mentality → Lectures.
    static var lectures: URL { folder(fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Lectures", isDirectory: true)) }
    static var libraryFile: URL { support.appendingPathComponent("library.json") }

    static func workFolder(_ lecture: Lecture) -> URL { work.appendingPathComponent(lecture.id.uuidString, isDirectory: true) }
    static func courseFolder(_ course: Course) -> URL { folder(lectures.appendingPathComponent(course.folderName, isDirectory: true)) }

    @discardableResult
    static func folder(_ url: URL) -> URL {
        try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

struct LibraryData: Codable {
    var courses: [Course] = []
    var lectures: [Lecture] = []

    static func load(from url: URL = Storage.libraryFile) -> LibraryData {
        guard let data = try? Data(contentsOf: url) else { return LibraryData() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(LibraryData.self, from: data)) ?? LibraryData()
    }

    func save(to url: URL = Storage.libraryFile) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: .atomic)
    }

    /// After the app was closed mid-run: unfinished lectures go back to the queue (their checkpoint
    /// lets transcription continue where it stopped).
    mutating func recoverInterrupted() -> Int {
        var count = 0
        for i in lectures.indices where lectures[i].isActive {
            lectures[i].status = .queued
            lectures[i].phase = "Waiting · continues where it stopped"
            count += 1
        }
        return count
    }
}

func safeFileName(_ value: String) -> String {
    let invalid = CharacterSet(charactersIn: "<>:\"/\\|?*").union(.controlCharacters)
    let cleaned = value.precomposedStringWithCanonicalMapping.unicodeScalars.map { invalid.contains($0) ? "-" : String($0) }.joined()
        .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespaces))
    return cleaned.isEmpty ? "Lecture" : String(cleaned.prefix(90))
}
