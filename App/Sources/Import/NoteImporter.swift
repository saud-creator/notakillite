import Foundation
import ZIPFoundation

/// One recording to process: an audio file already copied into the app's own storage.
struct ImportedRecording: Identifiable, Equatable, Codable, Sendable {
    var id = UUID()
    var file: URL
    var title: String
    var recordingName: String
    var sourceName: String
}

enum ImportError: LocalizedError {
    case noAudio(String), unreadable(String)
    var errorDescription: String? {
        switch self {
        case .noAudio(let name): return "\(name) has no audio recordings. In Notability, export the note in \"Note\" format (or \"PDF + Recording\") so recordings are included."
        case .unreadable(let name): return "\(name) is not a Notability note, ZIP or audio file."
        }
    }
}

/// Reads Notability exports (from Notakillite, proven on real exports): a .note export is a ZIP whose
/// Recordings folder holds the audio, listed in order by Recordings/library.plist. Plain audio files
/// and folders of them work too. Import is from Files, Share and paste only: never Notability's website.
enum NoteImporter {
    static let audioExtensions: Set<String> = ["m4a", "mp3", "wav", "aac", "alac", "flac", "ogg", "oga", "opus", "webm", "caf", "aif", "aiff", "wma", "amr", "mp4", "3gp", "audio"]
    static let archiveExtensions: Set<String> = ["note", "zip"]
    static let ignoredExtensions: Set<String> = ["plist", "pdf", "png", "jpg", "jpeg", "heic", "json", "txt", "xml", "gif", "zip"]

    static func naturalLess(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: [.numeric, .caseInsensitive, .diacriticInsensitive]) == .orderedAscending
    }

    static func looksLikeAudio(_ data: Data) -> Bool {
        guard data.count >= 4 else { return false }
        let bytes = [UInt8](data.prefix(12))
        func ascii(_ range: Range<Int>) -> String { range.upperBound <= bytes.count ? String(decoding: bytes[range], as: UTF8.self) : "" }
        return ascii(4..<8) == "ftyp" || ["caff", "RIFF", "FORM", "fLaC", "OggS"].contains(ascii(0..<4)) || ascii(0..<3) == "ID3"
            || (bytes[0] == 0x1A && bytes[1] == 0x45 && bytes[2] == 0xDF && bytes[3] == 0xA3) || (bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0)
    }

    static func title(of url: URL) -> String {
        let name = url.deletingPathExtension().lastPathComponent.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "Lecture" : name
    }

    /// Expands imported files and folders into ordered recordings, copying audio into `workFolder`.
    static func expand(_ urls: [URL], into workFolder: URL) throws -> [ImportedRecording] {
        try FileManager.default.createDirectory(at: workFolder, withIntermediateDirectories: true)
        var items: [ImportedRecording] = []
        for url in urls { try visit(url, depth: 0, into: workFolder, items: &items) }
        return items
    }

    private static func visit(_ url: URL, depth: Int, into workFolder: URL, items: inout [ImportedRecording]) throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return }
        if isDirectory.boolValue {
            guard depth < 3 else { return }
            let children = try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
                .sorted { naturalLess($0.lastPathComponent, $1.lastPathComponent) }
            for child in children {
                let ext = child.pathExtension.lowercased()
                let childIsDirectory = (try? child.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                if childIsDirectory || audioExtensions.contains(ext) || archiveExtensions.contains(ext) { try visit(child, depth: depth + 1, into: workFolder, items: &items) }
            }
            return
        }
        let ext = url.pathExtension.lowercased()
        if archiveExtensions.contains(ext) {
            let recordings = try archiveRecordings(url, into: workFolder)
            if recordings.isEmpty { throw ImportError.noAudio(url.lastPathComponent) }
            for (index, file) in recordings.enumerated() {
                items.append(ImportedRecording(file: file, title: title(of: url), recordingName: recordings.count > 1 ? "Recording \(index + 1)" : "Recording", sourceName: url.lastPathComponent))
            }
            return
        }
        let handle = try? FileHandle(forReadingFrom: url)
        let head = (try? handle?.read(upToCount: 16)) ?? nil
        try? handle?.close()
        guard audioExtensions.contains(ext) || looksLikeAudio(head ?? Data()) else { throw ImportError.unreadable(url.lastPathComponent) }
        let copy = workFolder.appendingPathComponent("\(UUID().uuidString)-\(url.lastPathComponent)")
        try FileManager.default.copyItem(at: url, to: copy)
        items.append(ImportedRecording(file: copy, title: title(of: url), recordingName: url.lastPathComponent, sourceName: url.lastPathComponent))
    }

    /// Extracts the recordings of a .note/.zip export, in Notability's saved order when available.
    static func archiveRecordings(_ url: URL, into workFolder: URL) throws -> [URL] {
        let archive: Archive
        do { archive = try Archive(url: url, accessMode: .read) } catch { throw ImportError.unreadable(url.lastPathComponent) }
        var audio: [Entry] = []
        var library: Entry?
        for entry in archive where entry.type == .file {
            let path = entry.path
            let name = (path as NSString).lastPathComponent
            if path.hasPrefix("__MACOSX/") || name.hasPrefix("._") || entry.uncompressedSize == 0 { continue }
            if path.range(of: "(^|/)recordings/library\\.plist$", options: [.regularExpression, .caseInsensitive]) != nil { library = entry; continue }
            let ext = (name as NSString).pathExtension.lowercased()
            if ignoredExtensions.contains(ext) { continue }
            if audioExtensions.contains(ext) { audio.append(entry); continue }
            if path.range(of: "(^|/)recordings/", options: [.regularExpression, .caseInsensitive]) != nil, looksLikeAudio(try prefix(of: entry, in: archive)) { audio.append(entry) }
        }
        // Binary plists keep strings in object order: the first mention of each file name gives the saved order.
        var order: [String: Int] = [:]
        if let library, library.uncompressedSize < 4 * 1024 * 1024 {
            var data = Data()
            _ = try? archive.extract(library, skipCRC32: true) { data.append($0) }
            let text = String(decoding: data, as: UTF8.self)
            for entry in audio {
                let name = (entry.path as NSString).lastPathComponent
                if let range = text.range(of: name) { order[entry.path] = text.distance(from: text.startIndex, to: range.lowerBound) }
            }
        }
        audio.sort { a, b in
            if let x = order[a.path], let y = order[b.path], x != y { return x < y }
            return naturalLess(a.path, b.path)
        }
        return try audio.map { entry in
            let name = (entry.path as NSString).lastPathComponent
            let target = workFolder.appendingPathComponent("\(UUID().uuidString)-\(name)")
            _ = try archive.extract(entry, to: target)
            return target
        }
    }

    private struct EnoughData: Error {}

    /// The first 16 bytes of an entry (it stops reading there, so large recordings aren't unpacked twice).
    private static func prefix(of entry: Entry, in archive: Archive) throws -> Data {
        var data = Data()
        _ = try? archive.extract(entry, bufferSize: 16 * 1024, skipCRC32: true) { chunk in
            data.append(chunk.prefix(16 - data.count))
            if data.count >= 16 { throw EnoughData() }
        }
        return data
    }
}
