import Foundation

/// A timed piece of recognised speech, in seconds from the start of the recording.
struct SpeechSegment: Codable, Equatable {
    var start: Double
    var end: Double
    var text: String
}

struct Transcript: Codable, Equatable {
    var language: String
    var model: String
    var device: String?
    var segments: [SpeechSegment]
}

/// Port of companion/transcript-format.mjs. Both must produce byte-identical Markdown;
/// shared/fixtures/transcript-golden.json is checked by the Node and iOS test suites.
enum TranscriptFormatter {
    static let languageNames = ["ar": "Arabic", "en": "English", "auto": "Auto-detected"]

    static let aiPrompt = [
        "This is an automatic transcript of a university lecture, kept in the language(s) the lecturer spoke (often Arabic with English terms).",
        "Each paragraph starts with a [hh:mm:ss] timestamp from the recording. Speech recognition can mishear names and technical terms; correct obvious errors from context and say when unsure.",
        "Suggested request: list everything the lecturer said is important, will be on the exam, quiz or assignment, or must be memorised (quote it with its timestamp). Then give the key concepts, definitions, lists and a short summary.",
    ]

    static func timestamp(_ seconds: Double) -> String {
        let value = max(0, Int(floor(seconds.isFinite ? seconds : 0)))
        return String(format: "%02d:%02d:%02d", value / 3600, (value / 60) % 60, value % 60)
    }

    static func durationLabel(_ seconds: Double) -> String {
        let value = Int((seconds.isFinite ? seconds : 0).rounded())
        let hours = value / 3600, minutes = (value / 60) % 60
        return hours > 0 ? "\(hours) h \(minutes) min" : "\(max(minutes, value > 0 ? 1 : 0)) min"
    }

    /// Same escaping as JSON.stringify, which is also a valid YAML double-quoted scalar.
    static func yaml(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }

    static func collapse(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    static func wordCount(_ segments: [SpeechSegment]) -> Int {
        segments.reduce(0) { $0 + $1.text.split(whereSeparator: { $0.isWhitespace }).count }
    }

    /// Groups segments into paragraphs at pauses of `pause` seconds, capped at about `maxSeconds`.
    static func paragraphs(_ segments: [SpeechSegment], pause: Double = 2, maxSeconds: Double = 60) -> [SpeechSegment] {
        var result: [(start: Double, end: Double, parts: [String])] = []
        for segment in segments {
            let text = collapse(segment.text)
            if text.isEmpty { continue }
            if let last = result.last, segment.start - last.end < pause, segment.end - last.start <= maxSeconds {
                result[result.count - 1].parts.append(text)
                result[result.count - 1].end = segment.end
            } else {
                result.append((segment.start, segment.end, [text]))
            }
        }
        return result.map { SpeechSegment(start: $0.start, end: $0.end, text: $0.parts.joined(separator: " ")) }
    }

    static func isoDay(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC")
        return String(formatter.string(from: date).prefix(10))
    }

    static func lectureMarkdown(title: String, recording: String, sourceFile: String, duration: Double, cleanup: String,
                                transcript: Transcript, createdAt: Date = Date(), includePrompt: Bool = true, number: Int? = nil, total: Int? = nil) -> String {
        let blocks = paragraphs(transcript.segments)
        let language = languageNames[transcript.language] ?? (transcript.language.isEmpty ? "Auto-detected" : transcript.language)
        var lines = [
            "---",
            "title: \(yaml(title))",
        ]
        if let number, number > 0 { lines.append("lecture: \(number)\(total.map { " of \($0)" } ?? "")") }
        lines += [
            "recording: \(yaml(recording))",
            "source_file: \(yaml(sourceFile))",
            "duration: \(yaml(timestamp(duration)))",
            "language: \(yaml(language))",
            "noise_cleanup: \(yaml(cleanup))",
            "transcribed_with: \(yaml(transcript.model + ((transcript.device?.isEmpty == false) ? " (\(transcript.device!))" : "")))",
            "words: \(wordCount(transcript.segments))",
            "created: \(yaml(isoDay(createdAt)))",
            "---",
            "",
            "# \(title)",
            "",
        ]
        if includePrompt { lines += aiPrompt.map { "> \($0)" } + [""] }
        lines += ["## Transcript", ""]
        if blocks.isEmpty { lines += ["_No speech was detected in this recording._", ""] }
        for block in blocks { lines += ["**[\(timestamp(block.start))]** \(block.text)", ""] }
        return trimEnd(lines.joined(separator: "\n")) + "\n"
    }

    struct IndexEntry: Codable, Equatable {
        var number: Int
        var title: String
        var duration: Double
        var words: Int?
        var transcript: String?
    }

    static func indexMarkdown(title: String, lectures: [IndexEntry], createdAt: Date = Date()) -> String {
        let total = lectures.reduce(0) { $0 + $1.duration }
        var lines = [
            "# \(title)",
            "",
            "\(lectures.count) lecture\(lectures.count == 1 ? "" : "s") · \(durationLabel(total)) of audio · \(isoDay(createdAt))",
            "",
            "Upload the numbered `.md` files to ChatGPT or Claude (one chat for the whole course works well). Each file has the lecture's transcript with timestamps and a suggested request at the top.",
            "",
            "| # | Lecture | Length | Words | Transcript |",
            "|---|---|---|---|---|",
        ]
        func cell(_ value: String) -> String { value.replacingOccurrences(of: "|", with: "\\|") }
        for item in lectures {
            let link = (item.transcript ?? "").isEmpty ? "—" : "[\(cell(item.transcript!))](<\(item.transcript!)>)"
            lines.append("| \(item.number) | \(cell(item.title)) | \(timestamp(item.duration)) | \(item.words.map(String.init) ?? "") | \(link) |")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func trimEnd(_ text: String) -> String {
        var value = text
        while let last = value.last, last.isWhitespace { value.removeLast() }
        return value
    }
}
