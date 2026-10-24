import Foundation

enum LectureLanguage: String, CaseIterable, Identifiable, Codable, Sendable {
    case auto, ar, en
    var id: String { rawValue }
    var label: String {
        switch self {
        case .auto: "Auto · Arabic and English, detected every 30 seconds"
        case .ar: "Arabic"
        case .en: "English"
        }
    }
    var whisperCode: String? { self == .auto ? nil : rawValue }
}

/// User settings, stored in UserDefaults under the same keys the Settings screen uses with @AppStorage.
struct AppSettings: Sendable {
    var model = WhisperModel.turbo
    var language = LectureLanguage.auto
    var cleanup = CleanupMode.voiceIsolation
    var vocabulary = ""
    var format = OutputFormat.markdown
    var includeInstructions = true
    var instructions = LectureMarkdown.defaultInstructions
    var keepCleanedAudio = true
    var workers = 4
    var keepAwake = true
    var notify = true

    enum Key {
        static let model = "model", language = "language", cleanup = "cleanup", vocabulary = "vocabulary", format = "format"
        static let includeInstructions = "includeInstructions", instructions = "instructions", keepCleanedAudio = "keepCleanedAudio"
        static let workers = "workers", keepAwake = "keepAwake", notify = "notify"
    }

    static func current(_ defaults: UserDefaults = .standard) -> AppSettings {
        var s = AppSettings()
        s.model = defaults.string(forKey: Key.model).flatMap(WhisperModel.init(rawValue:)) ?? s.model
        s.language = defaults.string(forKey: Key.language).flatMap(LectureLanguage.init(rawValue:)) ?? s.language
        s.cleanup = defaults.string(forKey: Key.cleanup).flatMap(CleanupMode.init(rawValue:)) ?? s.cleanup
        s.format = defaults.string(forKey: Key.format).flatMap(OutputFormat.init(rawValue:)) ?? s.format
        s.vocabulary = defaults.string(forKey: Key.vocabulary) ?? ""
        if let text = defaults.string(forKey: Key.instructions), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { s.instructions = text }
        if defaults.object(forKey: Key.includeInstructions) != nil { s.includeInstructions = defaults.bool(forKey: Key.includeInstructions) }
        if defaults.object(forKey: Key.keepCleanedAudio) != nil { s.keepCleanedAudio = defaults.bool(forKey: Key.keepCleanedAudio) }
        if defaults.object(forKey: Key.keepAwake) != nil { s.keepAwake = defaults.bool(forKey: Key.keepAwake) }
        if defaults.object(forKey: Key.notify) != nil { s.notify = defaults.bool(forKey: Key.notify) }
        let workers = defaults.integer(forKey: Key.workers)
        if workers > 0 { s.workers = min(8, workers) }
        return s
    }
}
