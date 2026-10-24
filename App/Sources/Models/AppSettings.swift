import Foundation

enum LectureLanguage: String, CaseIterable, Identifiable, Codable, Sendable {
    case auto, ar, en
    var id: String { rawValue }
    var label: String {
        switch self {
        case .auto: "Auto · Arabic or English, decided for every piece"
        case .ar: "Arabic"
        case .en: "English"
        }
    }
    var whisperCode: String? { self == .auto ? nil : rawValue }
}

/// User settings, stored in UserDefaults under the same keys the Settings screen uses with @AppStorage.
struct AppSettings: Sendable {
    var service = SpeechService.onDevice
    var model = WhisperModel.recommended
    /// Model of the chosen cloud service (each service remembers its own).
    var cloudModel = SpeechService.onDevice.defaultModel
    /// Address of an OpenAI-compatible service (custom service only).
    var customBaseURL = ""
    var language = LectureLanguage.auto
    var cleanup = CleanupMode.deepFilter
    var vocabulary = ""
    var format = OutputFormat.markdown
    var includeInstructions = true
    var instructions = LectureMarkdown.defaultInstructions
    var keepCleanedAudio = true
    var workers = 4
    var keepAwake = true
    var notify = true

    enum Key {
        static let service = "service", model = "model", customBaseURL = "customBaseURL"
        static let language = "language", cleanup = "cleanup", vocabulary = "vocabulary", format = "format"
        static let includeInstructions = "includeInstructions", instructions = "instructions", keepCleanedAudio = "keepCleanedAudio"
        static let workers = "workers", keepAwake = "keepAwake", notify = "notify"
        static func cloudModel(_ service: SpeechService) -> String { "cloudModel.\(service.rawValue)" }
    }

    static func current(_ defaults: UserDefaults = .standard) -> AppSettings {
        var s = AppSettings()
        s.service = defaults.string(forKey: Key.service).flatMap(SpeechService.init(rawValue:)) ?? s.service
        if let stored = defaults.string(forKey: Key.model).flatMap(WhisperModel.init(rawValue:)) {
            // A model this device can't run (for example a setting restored from an iPad onto an iPhone)
            // falls back to the recommended one. The tiny test model is always allowed.
            s.model = stored == .base || WhisperModel.offered.contains(stored) ? stored : WhisperModel.recommended
        }
        s.cloudModel = cloudModel(for: s.service, defaults: defaults)
        s.customBaseURL = (defaults.string(forKey: Key.customBaseURL) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
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
        if workers > 0 { s.workers = min(4, workers) }   // WhisperKit is slower with more than 4 on iPad
        return s
    }

    /// The saved model for a cloud service; the service's recommended model when none (or a retired one) is saved.
    static func cloudModel(for service: SpeechService, defaults: UserDefaults = .standard) -> String {
        let stored = (defaults.string(forKey: Key.cloudModel(service)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if stored.isEmpty { return service.defaultModel }
        if !service.models.isEmpty && !service.models.contains(where: { $0.id == stored }) { return service.defaultModel }
        return stored
    }

    /// Identifies the engine and model, so a checkpoint made with another one is not reused.
    var engineKey: String { service.isCloud ? "\(service.rawValue):\(cloudModel)" : model.rawValue }
}
