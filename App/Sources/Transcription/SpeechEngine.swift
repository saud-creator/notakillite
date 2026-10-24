import Foundation

/// How one batch of audio pieces should be decoded.
struct DecodeSettings: Sendable, Equatable {
    /// nil = detect the language of every piece (best for lectures that switch between Arabic and English).
    var language: String?
    /// 0 = greedy decoding. Higher values are used only when retrying a part that failed the quality check.
    var temperature: Float = 0
    /// Course terms (drug names, anatomy…) that help Whisper spell them right.
    var vocabulary = ""
}

/// Recognised speech for one piece of audio. Times are relative to the start of the piece.
struct PieceResult: Sendable, Equatable, Codable {
    var segments: [SpeechSegment]
    var language: String?
}

/// Speech-to-text engine. The app uses WhisperKit; tests use a scripted fake.
protocol SpeechEngine: AnyObject, Sendable {
    /// Short description written into each transcript, e.g. "Whisper large-v3 (WhisperKit, on-device)".
    var label: String { get async }
    /// Transcribes independent pieces of 16 kHz mono audio, in order. Pieces may run in parallel.
    func transcribe(_ pieces: [[Float]], settings: DecodeSettings) async throws -> [PieceResult]
}
