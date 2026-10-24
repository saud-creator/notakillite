import Foundation

enum OutputFormat: String, CaseIterable, Identifiable, Codable, Sendable {
    case markdown, text, both
    var id: String { rawValue }
    var label: String {
        switch self {
        case .markdown: "Markdown (.md)"
        case .text: "Plain text (.txt)"
        case .both: "Both .md and .txt"
        }
    }
}

/// Facts about a lecture written into its file header.
struct LectureInfo: Sendable {
    var title: String
    var course: String
    var number: Int
    var total: Int
    var sourceFile: String
    var recording: String
    var cleanup: String
    var createdAt = Date()
}

/// Writes one file per lecture, laid out for an AI that writes exam questions:
/// a YAML header, instructions for the AI, the moments the lecturer stressed, then the timestamped
/// transcript in paragraphs. Parts that failed the quality check are visible ⚠ lines.
enum LectureMarkdown {
    static let defaultInstructions = """
    This is an automatic, on-device transcript of a university lecture, kept in the language(s) the lecturer spoke (often Arabic with English terms). Each paragraph starts with a [hh:mm:ss] timestamp. Speech recognition can mishear names and technical terms: correct obvious errors from context and say when you are unsure. Lines marked ⚠ could not be transcribed reliably; do not invent their content.
    Suggested task: 1) List everything the lecturer stressed or said will be on the exam, quiz or OSCE, with timestamps (start from "Lecturer emphasis" below and check each one in context). 2) Write exam questions (MCQs with answers and explanations, then short-answer questions) that cover those points first and then the rest of the lecture. 3) Give the key definitions, lists, numbers and a short summary.
    """

    static let languageNames = ["ar": "Arabic", "en": "English"]

    static func timestamp(_ seconds: Double) -> String {
        let value = max(0, Int(floor(seconds.isFinite ? seconds : 0)))
        return String(format: "%02d:%02d:%02d", value / 3600, (value / 60) % 60, value % 60)
    }

    static func durationLabel(_ seconds: Double) -> String {
        let value = Int((seconds.isFinite ? seconds : 0).rounded())
        let hours = value / 3600, minutes = (value / 60) % 60
        return hours > 0 ? "\(hours) h \(minutes) min" : "\(max(minutes, value > 0 ? 1 : 0)) min"
    }

    /// JSON-style escaping, which is also a valid YAML double-quoted scalar.
    static func yaml(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }

    static func isoDay(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// "Arabic 70 %, English 30 %", or one name when a language is ≥ 95 %.
    static func languageLabel(_ shares: [String: Double]) -> String {
        let sorted = shares.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
        guard let top = sorted.first else { return "Unknown" }
        func name(_ code: String) -> String { languageNames[code] ?? code }
        if top.value >= 0.95 || sorted.count == 1 { return name(top.key) }
        return sorted.filter { $0.value >= 0.03 }.map { "\(name($0.key)) \(Int(($0.value * 100).rounded())) %" }.joined(separator: ", ")
    }

    struct Paragraph: Equatable {
        var start: Double
        var end: Double
        var text: String
        var marker: Bool
    }

    /// Groups segments into paragraphs at pauses of 2 s or more, each at most about a minute long.
    static func paragraphs(_ segments: [SpeechSegment], pause: Double = 2, maxSeconds: Double = 60) -> [Paragraph] {
        var result: [Paragraph] = []
        var open = false
        for segment in segments {
            let text = TranscriptText.collapse(segment.text)
            if text.isEmpty { continue }
            if segment.marker {
                result.append(Paragraph(start: segment.start, end: segment.end, text: text, marker: true))
                open = false
                continue
            }
            if open, let last = result.last, segment.start - last.end < pause, segment.end - last.start <= maxSeconds {
                result[result.count - 1].text += " " + text
                result[result.count - 1].end = segment.end
            } else {
                result.append(Paragraph(start: segment.start, end: segment.end, text: text, marker: false))
                open = true
            }
        }
        return result
    }

    static func markdown(_ info: LectureInfo, transcript: LectureTranscript, instructions: String?) -> String {
        var lines = [
            "---",
            "title: \(yaml(info.title))",
            "course: \(yaml(info.course))",
            "lecture: \(info.number) of \(info.total)",
            "source_file: \(yaml(info.sourceFile))",
            "recording: \(yaml(info.recording))",
            "duration: \(yaml(timestamp(transcript.duration)))",
            "speech_time: \(yaml(timestamp(transcript.speechSeconds)))",
            "language: \(yaml(languageLabel(transcript.languages)))",
            "noise_cleanup: \(yaml(info.cleanup))",
            "transcribed_with: \(yaml("\(transcript.model) on \(transcript.device)"))",
            "words: \(transcript.words)",
            "quality: \(yaml(transcript.quality.label))",
            "created: \(yaml(isoDay(info.createdAt)))",
            "---",
            "",
            "# \(info.title)",
            "",
        ]
        if transcript.quality.status == .needsReview {
            lines += ["> ⚠ **Needs review:** \(transcript.quality.unresolved.count) part(s) could not be transcribed reliably. They are marked ⚠ below; the rest passed the quality check.", ""]
        }
        if let instructions = instructions?.trimmingCharacters(in: .whitespacesAndNewlines), !instructions.isEmpty {
            lines += ["## Instructions for the AI", ""]
            lines += instructions.components(separatedBy: .newlines).map { "> \($0)" }
            lines.append("")
        }
        let hints = EmphasisFinder.hints(transcript.segments)
        if !hints.isEmpty {
            lines += ["## Lecturer emphasis (auto-detected)", "",
                      "Moments where the lecturer mentioned the exam (🎯) or stressed a point (❗), found by keywords. Check each one in the transcript.", ""]
            for hint in hints { lines.append("- \(hint.kind == .exam ? "🎯 exam" : "❗ stressed") **[\(timestamp(hint.start))]** \(hint.text)") }
            lines.append("")
        }
        lines += ["## Transcript", ""]
        let blocks = paragraphs(transcript.segments)
        if blocks.isEmpty { lines += ["_No speech was detected in this recording._", ""] }
        for block in blocks {
            if block.marker { lines += ["> ⚠ **[\(timestamp(block.start))–\(timestamp(block.end))]** \(block.text)", ""] }
            else { lines += ["**[\(timestamp(block.start))]** \(block.text)", ""] }
        }
        return trimEnd(lines.joined(separator: "\n")) + "\n"
    }

    static func plainText(_ info: LectureInfo, transcript: LectureTranscript, instructions: String?) -> String {
        var lines = [
            info.title,
            "Course: \(info.course) · Lecture \(info.number) of \(info.total)",
            "Duration: \(timestamp(transcript.duration)) (speech \(timestamp(transcript.speechSeconds))) · Language: \(languageLabel(transcript.languages)) · Words: \(transcript.words)",
            "Source: \(info.sourceFile) · \(info.recording)",
            "Transcribed with \(transcript.model) on \(transcript.device) · Noise cleanup: \(info.cleanup)",
            "Quality: \(transcript.quality.label)",
            "",
        ]
        if let instructions = instructions?.trimmingCharacters(in: .whitespacesAndNewlines), !instructions.isEmpty {
            lines += ["INSTRUCTIONS FOR THE AI", instructions, ""]
        }
        let hints = EmphasisFinder.hints(transcript.segments)
        if !hints.isEmpty {
            lines.append("LECTURER EMPHASIS (auto-detected, check in context)")
            for hint in hints { lines.append("[\(timestamp(hint.start))] (\(hint.kind == .exam ? "exam" : "stressed")) \(hint.text)") }
            lines.append("")
        }
        lines.append("TRANSCRIPT")
        let blocks = paragraphs(transcript.segments)
        if blocks.isEmpty { lines.append("No speech was detected in this recording.") }
        for block in blocks {
            lines.append(block.marker ? "[\(timestamp(block.start))–\(timestamp(block.end))] ⚠ \(block.text)" : "[\(timestamp(block.start))] \(block.text)")
            lines.append("")
        }
        return trimEnd(lines.joined(separator: "\n")) + "\n"
    }

    struct IndexEntry: Equatable {
        var number: Int
        var title: String
        var duration: Double
        var words: Int
        var quality: String
        var file: String?
    }

    static func index(course: String, lectures: [IndexEntry], createdAt: Date = Date()) -> String {
        let total = lectures.reduce(0) { $0 + $1.duration }
        var lines = [
            "# \(course)",
            "",
            "\(lectures.count) lecture\(lectures.count == 1 ? "" : "s") · \(durationLabel(total)) of audio · \(isoDay(createdAt))",
            "",
            "Give the numbered lecture files to your AI (one chat for the whole course works well). Each file has instructions, the moments the lecturer stressed, and the timestamped transcript.",
            "",
            "| # | Lecture | Length | Words | Quality | File |",
            "|---|---|---|---|---|---|",
        ]
        func cell(_ value: String) -> String { value.replacingOccurrences(of: "|", with: "\\|") }
        for item in lectures {
            let link = item.file.map { "[\(cell($0))](<\($0)>)" } ?? "—"
            lines.append("| \(item.number) | \(cell(item.title)) | \(timestamp(item.duration)) | \(item.words) | \(cell(item.quality)) | \(link) |")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func trimEnd(_ text: String) -> String {
        var value = text
        while let last = value.last, last.isWhitespace { value.removeLast() }
        return value
    }
}
