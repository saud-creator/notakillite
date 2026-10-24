import Foundation

/// A timed piece of recognised speech, in seconds from the start of the recording.
/// `marker` segments are not speech: they mark a part that could not be transcribed reliably.
struct SpeechSegment: Codable, Equatable, Sendable {
    var start: Double
    var end: Double
    var text: String
    var marker = false
    /// Language Whisper detected for the audio this segment came from ("ar", "en", …), if known.
    var language: String?

    init(start: Double, end: Double, text: String, marker: Bool = false, language: String? = nil) {
        self.start = start; self.end = end; self.text = text; self.marker = marker; self.language = language
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        start = try c.decode(Double.self, forKey: .start)
        end = try c.decode(Double.self, forKey: .end)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        marker = try c.decodeIfPresent(Bool.self, forKey: .marker) ?? false
        language = try c.decodeIfPresent(String.self, forKey: .language)
    }
}

/// A span of time in seconds.
struct TimeRange: Codable, Equatable, Sendable {
    var start: Double
    var end: Double
    var length: Double { end - start }

    func overlap(_ other: TimeRange) -> Double { max(0, min(end, other.end) - max(start, other.start)) }
    func overlap(_ segment: SpeechSegment) -> Double { max(0, min(end, segment.end) - max(start, segment.start)) }
}

/// The outcome of the automatic quality check for one lecture.
struct QualityInfo: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case ok, repaired, needsReview }
    struct Part: Codable, Equatable, Sendable {
        var start: Double
        var end: Double
        var detail: String
    }
    var status: Status
    var repairs: [Part] = []
    var unresolved: [Part] = []
    var artifactsRemoved = 0
    var attempts = 0

    var label: String {
        func parts(_ n: Int) -> String { "\(n) part\(n == 1 ? "" : "s")" }
        let artifacts = artifactsRemoved > 0 ? "; \(artifactsRemoved) known Whisper artifact\(artifactsRemoved == 1 ? "" : "s") removed (e.g. \"Subtitles by…\" credits)" : ""
        switch status {
        case .needsReview: return "needs review — \(parts(unresolved.count)) could not be transcribed reliably\(artifacts)"
        case .repaired: return "repaired — \(parts(repairs.count)) re-transcribed after the automatic quality check\(artifacts)"
        case .ok: return "ok — passed the automatic quality check\(artifacts)"
        }
    }
}

/// Everything the transcription stage produces for one lecture.
struct LectureTranscript: Codable, Equatable, Sendable {
    var segments: [SpeechSegment]
    var model: String
    var device: String
    var duration: Double
    var speechSeconds: Double
    /// Share of speech time per detected language, e.g. ["ar": 0.7, "en": 0.3].
    var languages: [String: Double]
    var quality: QualityInfo

    var words: Int { TranscriptText.wordCount(segments) }
}

enum TranscriptText {
    static func wordCount(_ segments: [SpeechSegment]) -> Int {
        segments.reduce(0) { $0 + ($1.marker ? 0 : $1.text.split(whereSeparator: { $0.isWhitespace }).count) }
    }

    static func collapse(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
