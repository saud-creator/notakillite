import Foundation

/// Where speech is turned into text: Whisper on the device, or a cloud service with the user's own key.
enum SpeechService: String, CaseIterable, Identifiable, Codable, Sendable {
    case onDevice, openAI, elevenLabs, groq, custom

    var id: String { rawValue }
    var isCloud: Bool { self != .onDevice }

    var title: String {
        switch self {
        case .onDevice: "On this \(DeviceInfo.kind) · Whisper, private, offline"
        case .openAI: "OpenAI · cloud"
        case .elevenLabs: "ElevenLabs Scribe · cloud"
        case .groq: "Groq Whisper · cloud, fast"
        case .custom: "Other service (OpenAI-compatible)"
        }
    }

    var name: String {
        switch self {
        case .onDevice: "On-device Whisper"
        case .openAI: "OpenAI"
        case .elevenLabs: "ElevenLabs"
        case .groq: "Groq"
        case .custom: "Custom service"
        }
    }

    struct ModelChoice: Identifiable, Hashable, Sendable {
        var id: String
        var title: String
    }

    var models: [ModelChoice] {
        switch self {
        case .onDevice, .custom:
            return []
        case .openAI:
            return [ModelChoice(id: "gpt-transcribe", title: "gpt-transcribe · best (recommended)"),
                    ModelChoice(id: "gpt-4o-transcribe", title: "gpt-4o-transcribe · older, ends Feb 2027"),
                    ModelChoice(id: "gpt-4o-mini-transcribe", title: "gpt-4o-mini-transcribe · cheaper, ends Feb 2027"),
                    ModelChoice(id: "whisper-1", title: "whisper-1 · exact timestamps, ends Feb 2027")]
        case .elevenLabs:
            return [ModelChoice(id: "scribe_v2", title: "Scribe v2 · word timestamps, strong Arabic")]
        case .groq:
            return [ModelChoice(id: "whisper-large-v3", title: "Whisper large-v3 · most accurate"),
                    ModelChoice(id: "whisper-large-v3-turbo", title: "Whisper large-v3 turbo · fastest, cheapest")]
        }
    }

    var defaultModel: String { models.first?.id ?? "whisper-1" }

    var defaultBaseURL: String {
        switch self {
        case .openAI: "https://api.openai.com/v1"
        case .groq: "https://api.groq.com/openai/v1"
        case .elevenLabs: "https://api.elevenlabs.io/v1"
        case .onDevice, .custom: ""
        }
    }

    /// Where to create an API key.
    var keyPage: URL? {
        switch self {
        case .openAI: URL(string: "https://platform.openai.com/api-keys")
        case .elevenLabs: URL(string: "https://elevenlabs.io/app/settings/api-keys")
        case .groq: URL(string: "https://console.groq.com/keys")
        case .onDevice, .custom: nil
        }
    }
}

struct CloudConfig: Sendable, Equatable {
    var service: SpeechService
    var model: String
    var apiKey: String
    /// Custom service only: the address that ends before /audio/transcriptions, e.g. https://example.com/v1
    var baseURL = ""

    var endpoint: String {
        let base = service == .custom ? baseURL.trimmingCharacters(in: .whitespacesAndNewlines) : service.defaultBaseURL
        return base.hasSuffix("/") ? String(base.dropLast()) : base
    }
}

enum CloudSpeechError: LocalizedError {
    case missingKey(String)
    case rejectedKey(String, String)
    case quota(String, String)
    case badAddress(String)
    case badRequest(Int, String)
    case server(Int, String)
    case network(String)
    case unreadable(String)

    var errorDescription: String? {
        switch self {
        case .missingKey(let service): "Add your \(service) API key in Settings, or switch to on-device speech recognition."
        case .rejectedKey(let service, let message): "\(service) rejected the API key. Check it in Settings. (\(message))"
        case .quota(let service, let message): "Your \(service) account has no credit or reached its limit. (\(message))"
        case .badAddress(let detail): "The speech service address is wrong: \(detail)"
        case .badRequest(let code, let message): "The speech service refused the request (\(code)): \(message)"
        case .server(let code, let message): "The speech service had a problem (\(code)) and still failed after several tries: \(message)"
        case .network(let message): "No connection to the speech service: \(message)"
        case .unreadable(let detail): "The speech service sent an answer the app can't read: \(detail)"
        }
    }

    /// Problems that would fail every lecture the same way: the queue stops instead of trying them all.
    var stopsQueue: Bool {
        if case .unreadable = self { return false }
        return true
    }
}

/// Speech-to-text through a cloud service, as an alternative to Whisper on the device.
///
/// Gets the same ≤ 28-second pieces of speech as Whisper (silence is never sent), uploads each as a
/// 16 kHz WAV, several at a time, and retries when the service is busy. Supports OpenAI
/// (gpt-transcribe and older models), ElevenLabs Scribe, Groq, and any OpenAI-compatible service.
final class CloudSpeechEngine: SpeechEngine, @unchecked Sendable {
    let config: CloudConfig
    private let session: URLSession
    var maxConcurrent = 4
    var maxAttempts = 5
    /// Multiplies every wait between retries (tests make it tiny).
    var retryDelayScale = 1.0

    init(config: CloudConfig, session: URLSession? = nil) {
        self.config = config
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 120
            configuration.timeoutIntervalForResource = 600
            self.session = URLSession(configuration: configuration)
        }
    }

    var label: String { "\(config.service.name) \(config.model) (cloud)" }

    enum Style { case gptTranscribe, gpt4o, whisper, scribe }

    /// How requests and answers look for the chosen model.
    var style: Style {
        if config.service == .elevenLabs { return .scribe }
        let model = config.model.lowercased()
        if model.hasPrefix("gpt-transcribe") { return .gptTranscribe }
        if model.hasPrefix("gpt-") { return .gpt4o }
        return .whisper
    }

    func transcribe(_ pieces: [[Float]], settings: DecodeSettings) async throws -> [PieceResult] {
        guard !pieces.isEmpty else { return [] }
        var results = [PieceResult?](repeating: nil, count: pieces.count)
        let limit = max(1, maxConcurrent)
        try await withThrowingTaskGroup(of: (Int, PieceResult).self) { group in
            var next = 0
            while next < min(limit, pieces.count) {
                let index = next
                group.addTask {
                    let result = try await self.transcribePiece(pieces[index], settings: settings)
                    return (index, result)
                }
                next += 1
            }
            while let finished = try await group.next() {
                results[finished.0] = finished.1
                if next < pieces.count {
                    let index = next
                    group.addTask {
                        let result = try await self.transcribePiece(pieces[index], settings: settings)
                        return (index, result)
                    }
                    next += 1
                }
            }
        }
        return results.map { $0 ?? PieceResult(segments: [], language: nil) }
    }

    /// Sends a short sound to check the key, the model name and the connection.
    func check() async throws {
        var seed: UInt32 = 1
        let quiet = (0..<16_000).map { _ -> Float in
            seed = seed &* 1_103_515_245 &+ 12_345
            return Float(seed % 1_000) / 100_000 - 0.005
        }
        _ = try await transcribePiece(quiet, settings: DecodeSettings(language: "en"))
    }

    func transcribePiece(_ samples: [Float], settings: DecodeSettings) async throws -> PieceResult {
        let duration = Double(samples.count) / 16_000
        let wav = WAV.encode(samples, sampleRate: 16_000)
        var result = try await request(wav: wav, duration: duration, language: settings.language, settings: settings)
        // Lectures are Arabic or English. If the service heard another language (Whisper often calls
        // Arabic Persian or Urdu), ask again with the language its text looks like.
        if settings.language == nil, style != .gptTranscribe, let heard = result.language, heard != "ar", heard != "en" {
            let retry = Self.scriptLanguage(result.segments.map(\.text).joined(separator: " ")) ?? "ar"
            result = try await request(wav: wav, duration: duration, language: retry, settings: settings)
        }
        return result
    }

    // MARK: Requests

    private func request(wav: Data, duration: Double, language: String?, settings: DecodeSettings, keyterms: Bool = true) async throws -> PieceResult {
        guard let url = URL(string: config.endpoint + (style == .scribe ? "/speech-to-text" : "/audio/transcriptions")),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host != nil else {
            throw CloudSpeechError.badAddress("\"\(config.endpoint)\" is not a web address. Enter one like https://example.com/v1")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        var form = MultipartForm()
        let vocabulary = settings.vocabulary.trimmingCharacters(in: .whitespacesAndNewlines)
        let temperature = String(format: "%.2f", settings.temperature)
        var sentKeyterms = false
        switch style {
        case .scribe:
            request.setValue(config.apiKey, forHTTPHeaderField: "xi-api-key")
            form.add("model_id", config.model)
            form.add("tag_audio_events", "false")
            form.add("timestamps_granularity", "word")
            form.add("diarize", "false")
            if let language { form.add("language_code", language) }
            if settings.temperature > 0 { form.add("temperature", temperature) }
            if keyterms {
                for term in Self.scribeKeyterms(vocabulary) { form.add("keyterms", term); sentKeyterms = true }
            }
        case .gptTranscribe, .gpt4o, .whisper:
            if !config.apiKey.isEmpty { request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization") }
            form.add("model", config.model)
            switch style {
            case .gptTranscribe:
                for code in language.map({ [$0] }) ?? ["ar", "en"] { form.add("languages[]", code) }
                for term in Self.terms(vocabulary) { form.add("keywords[]", term) }
            case .gpt4o:
                form.add("response_format", "json")
                if let language { form.add("language", language) }
                if !vocabulary.isEmpty { form.add("prompt", vocabulary) }
            default:
                form.add("response_format", "verbose_json")
                form.add("timestamp_granularities[]", "segment")
                if let language { form.add("language", language) }
                if !vocabulary.isEmpty { form.add("prompt", vocabulary) }
                if settings.temperature > 0 { form.add("temperature", temperature) }
            }
        }
        form.addFile("file", filename: "audio.wav", contentType: "audio/wav", data: wav)
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = form.finished()
        do {
            let data = try await send(request)
            return try parse(data, duration: duration, requested: language)
        } catch CloudSpeechError.badRequest(let code, _) where sentKeyterms && (code == 400 || code == 422) {
            // Some vocabulary terms may not be accepted as key terms: try again without them.
            return try await self.request(wav: wav, duration: duration, language: language, settings: settings, keyterms: false)
        }
    }

    private func send(_ request: URLRequest) async throws -> Data {
        var attempt = 0
        while true {
            attempt += 1
            let answer: (Data, URLResponse)
            do {
                answer = try await session.data(for: request)
            } catch let error as URLError {
                if error.code == .cancelled { throw CancellationError() }
                if attempt < maxAttempts, Self.isTransient(error) {
                    try await wait(attempt: attempt, retryAfter: nil)
                    continue
                }
                throw CloudSpeechError.network(error.localizedDescription)
            }
            let (data, response) = answer
            guard let http = response as? HTTPURLResponse else { throw CloudSpeechError.unreadable("no HTTP response") }
            let message = Self.message(from: data)
            switch http.statusCode {
            case 200..<300:
                return data
            case 401, 403:
                throw CloudSpeechError.rejectedKey(config.service.name, message)
            case 402:
                throw CloudSpeechError.quota(config.service.name, message)
            case 429 where Self.isQuota(data):
                throw CloudSpeechError.quota(config.service.name, message)
            case 408, 409, 425, 429, 500...599:
                if attempt < maxAttempts {
                    try await wait(attempt: attempt, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
                    continue
                }
                throw CloudSpeechError.server(http.statusCode, message)
            case 404:
                throw CloudSpeechError.badAddress("\(request.url?.absoluteString ?? "") was not found (\(message))")
            default:
                throw CloudSpeechError.badRequest(http.statusCode, message)
            }
        }
    }

    private func wait(attempt: Int, retryAfter: String?) async throws {
        let seconds = retryAfter.flatMap { Double($0.trimmingCharacters(in: .whitespaces)) } ?? min(30, pow(2, Double(attempt - 1)))
        try await Task.sleep(nanoseconds: UInt64(max(0, min(60, seconds)) * retryDelayScale * 1_000_000_000))
    }

    static func isTransient(_ error: URLError) -> Bool {
        [.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost,
         .dnsLookupFailed, .resourceUnavailable, .dataNotAllowed, .internationalRoamingOff, .callIsActive,
         .backgroundSessionWasDisconnected].contains(error.code)
    }

    static func isQuota(_ data: Data) -> Bool {
        let text = String(decoding: data.prefix(4_000), as: UTF8.self).lowercased()
        return text.contains("insufficient_quota") || text.contains("quota_exceeded") || text.contains("exceeded your current quota")
    }

    static func message(from data: Data) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let error = json["error"] as? [String: Any], let message = error["message"] as? String { return message }
            if let error = json["error"] as? String { return error }
            if let detail = json["detail"] as? [String: Any], let message = detail["message"] as? String { return message }
            if let detail = json["detail"] as? String { return detail }
            if let message = json["message"] as? String { return message }
        }
        let text = String(decoding: data.prefix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "no details" : text
    }

    // MARK: Answers

    func parse(_ data: Data, duration: Double, requested: String?) throws -> PieceResult {
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw CloudSpeechError.unreadable(String(decoding: data.prefix(200), as: UTF8.self))
        }
        var detected: String?
        var segments: [SpeechSegment] = []
        if style == .scribe {
            detected = Self.languageCode(json["language_code"] as? String)
            segments = Self.segments(fromWords: json["words"] as? [[String: Any]] ?? [], duration: duration)
            if segments.isEmpty, let text = json["text"] as? String { segments = Self.spread(text, duration: duration) }
        } else {
            if let list = json["segments"] as? [[String: Any]] {
                for item in list {
                    guard let text = item["text"] as? String else { continue }
                    let start = (item["start"] as? NSNumber)?.doubleValue ?? 0
                    let end = (item["end"] as? NSNumber)?.doubleValue ?? start
                    let noSpeech = (item["no_speech_prob"] as? NSNumber)?.doubleValue ?? 0
                    let logProb = (item["avg_logprob"] as? NSNumber)?.doubleValue ?? 0
                    if noSpeech > 0.6 && logProb < -1 { continue }   // Whisper's own "this was not speech" rule
                    let from = min(duration, max(0, start))
                    segments.append(SpeechSegment(start: from, end: min(duration, max(from, end)), text: text))
                }
            } else if let text = json["text"] as? String {
                segments = Self.spread(text, duration: duration)
            }
            if let languages = json["languages"] as? [[String: Any]], let code = languages.first?["code"] as? String {
                detected = Self.languageCode(code)
            } else if let name = json["language"] as? String {
                detected = Self.languageCode(name)
            }
        }
        segments = segments.filter { !TranscriptText.collapse($0.text).isEmpty }
        let language = requested ?? detected ?? Self.scriptLanguage(segments.map(\.text).joined(separator: " "))
        return PieceResult(segments: segments, language: language)
    }

    /// ElevenLabs returns words with times: group them into sentence-like segments.
    static func segments(fromWords words: [[String: Any]], duration: Double) -> [SpeechSegment] {
        var out: [SpeechSegment] = []
        var text = ""
        var start: Double?
        var end = 0.0
        func close() {
            let cleaned = TranscriptText.collapse(text)
            if let first = start, !cleaned.isEmpty {
                let from = min(duration, max(0, first))
                out.append(SpeechSegment(start: from, end: min(duration, max(from, end)), text: cleaned))
            }
            text = ""
            start = nil
        }
        for word in words {
            let type = word["type"] as? String ?? "word"
            let piece = word["text"] as? String ?? ""
            if type == "audio_event" { continue }
            if type == "spacing" {
                if start != nil { text += piece }
                continue
            }
            let wordStart = (word["start"] as? NSNumber)?.doubleValue ?? end
            let wordEnd = (word["end"] as? NSNumber)?.doubleValue ?? wordStart
            if let first = start, wordStart - end > 1.0 || wordEnd - first > 12 { close() }
            if start == nil { start = wordStart }
            if let last = text.last, !last.isWhitespace { text += " " }
            text += piece
            end = wordEnd
            if let first = start, end - first >= 3, let mark = piece.last, ".?!؟".contains(mark) { close() }
        }
        close()
        return out
    }

    /// For answers without timestamps: one segment per sentence, timed in proportion to its length.
    static func spread(_ text: String, duration: Double) -> [SpeechSegment] {
        let sentences = TranscriptQuality.splitSentences(text).map { TranscriptText.collapse($0) }.filter { !$0.isEmpty }
        let total = sentences.reduce(0) { $0 + $1.count }
        guard total > 0 else { return [] }
        var out: [SpeechSegment] = []
        var position = 0
        for sentence in sentences {
            let start = duration * Double(position) / Double(total)
            position += sentence.count
            out.append(SpeechSegment(start: start, end: duration * Double(position) / Double(total), text: sentence))
        }
        return out
    }

    /// "ar", "en" or another short code from names and codes such as "arabic", "ara", "en-US".
    static func languageCode(_ raw: String?) -> String? {
        guard var value = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !value.isEmpty else { return nil }
        if let cut = value.firstIndex(where: { $0 == "-" || $0 == "_" }) { value = String(value[..<cut]) }
        let names = ["arabic": "ar", "ara": "ar", "english": "en", "eng": "en", "persian": "fa", "farsi": "fa", "fas": "fa",
                     "per": "fa", "urdu": "ur", "urd": "ur", "pashto": "ps", "pus": "ps"]
        return names[value] ?? value
    }

    /// "ar" when a text is mostly Arabic script, "en" when mostly Latin letters, nil without letters.
    static func scriptLanguage(_ text: String) -> String? {
        var arabic = 0, latin = 0
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x0600...0x06FF, 0x0750...0x077F, 0x08A0...0x08FF, 0xFB50...0xFDFF, 0xFE70...0xFEFF: arabic += 1
            case 0x41...0x5A, 0x61...0x7A: latin += 1
            default: break
            }
        }
        if arabic == 0 && latin == 0 { return nil }
        return arabic >= latin ? "ar" : "en"
    }

    /// Course vocabulary as separate terms (comma, semicolon or new line separated).
    static func terms(_ vocabulary: String, limit: Int = 50) -> [String] {
        var seen = Set<String>()
        let parts = vocabulary.components(separatedBy: CharacterSet(charactersIn: ",;\n،؛"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
        return Array(parts.prefix(limit))
    }

    /// ElevenLabs key terms: under 50 characters, at most 5 words, no brackets or backslashes.
    static func scribeKeyterms(_ vocabulary: String) -> [String] {
        let forbidden = CharacterSet(charactersIn: "<>{}[]\\")
        return Array(terms(vocabulary, limit: 1_000).filter { term in
            term.count < 50 && term.split(separator: " ").count <= 5 && term.rangeOfCharacter(from: forbidden) == nil
        }.prefix(100))
    }
}

/// A multipart/form-data request body.
struct MultipartForm {
    let boundary = "mentality-\(UUID().uuidString)"
    private var body = Data()

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    mutating func add(_ name: String, _ value: String) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }

    mutating func addFile(_ name: String, filename: String, contentType: String, data: Data) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(contentType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n".utf8))
    }

    func finished() -> Data {
        var data = body
        data.append(Data("--\(boundary)--\r\n".utf8))
        return data
    }
}

/// 16-bit PCM WAV files in memory.
enum WAV {
    static func encode(_ samples: [Float], sampleRate: Int) -> Data {
        var data = Data(capacity: 44 + samples.count * 2)
        func text(_ value: String) { data.append(Data(value.utf8)) }
        func u32(_ value: UInt32) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        func u16(_ value: UInt16) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        let bytes = UInt32(samples.count * 2)
        text("RIFF"); u32(36 + bytes); text("WAVE")
        text("fmt "); u32(16); u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        text("data"); u32(bytes)
        var pcm = [Int16](repeating: 0, count: samples.count)
        for i in samples.indices { pcm[i] = NeuralCleanup.int16(samples[i]).littleEndian }
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }
}
