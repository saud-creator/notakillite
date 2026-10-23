import CoreML
import Foundation
import WhisperKit

enum TranscriberChoice: String, CaseIterable, Identifiable, Codable {
    case onDevice, groq
    var id: String { rawValue }
    var label: String { self == .onDevice ? "Whisper on this iPhone · free, private" : "Groq cloud · free tier, fastest" }
}

enum LectureLanguage: String, CaseIterable, Identifiable, Codable {
    case auto, ar, en
    var id: String { rawValue }
    var label: String { switch self { case .auto: "Auto · Arabic and English mixed"; case .ar: "Arabic"; case .en: "English" } }
}

enum WhisperModelChoice: String, CaseIterable, Identifiable, Codable {
    case recommended, turbo, small
    var id: String { rawValue }
    var label: String {
        switch self {
        case .recommended: "Recommended for this iPhone"
        case .turbo: "Best · large-v3 turbo (626 MB, iPhone 13 Pro or newer)"
        case .small: "Light · small (about 250 MB)"
        }
    }
    var variant: String? { switch self { case .recommended: nil; case .turbo: "large-v3-v20240930_626MB"; case .small: "small" } }
}

struct TranscriptionRequest {
    var wav: URL
    var duration: Double
    var language: LectureLanguage
    var vocabulary: String
    var model: WhisperModelChoice
}

enum TranscriptionError: LocalizedError {
    case modelUnavailable(String), groqKeyMissing, groqRejected, groqLimit, groqFailed(Int, String), network
    var errorDescription: String? {
        switch self {
        case .modelUnavailable(let reason): "The speech model could not be loaded: \(reason)"
        case .groqKeyMissing: "Add your free Groq API key in Settings, or switch to Whisper on this iPhone."
        case .groqRejected: "Groq rejected the API key. Paste a valid key in Settings."
        case .groqLimit: "Groq's free limit was reached. Try again later, or use Whisper on this iPhone."
        case .groqFailed(let status, let detail): "Groq could not transcribe this audio (HTTP \(status)). \(detail)"
        case .network: "Could not reach Groq. Check your connection, or use Whisper on this iPhone."
        }
    }
}

typealias StageCallback = @Sendable (String, Double) -> Void

/// On-device Whisper (Core ML / Neural Engine) through WhisperKit. The model downloads once.
actor WhisperService {
    static let shared = WhisperService()
    private var pipe: WhisperKit?
    private var loadedVariant: String?

    func transcribe(_ request: TranscriptionRequest, stage: @escaping StageCallback) async throws -> Transcript {
        let variant = request.model.variant ?? WhisperKit.recommendedModels().default
        if pipe == nil || loadedVariant != variant {
            pipe = nil
            stage("Downloading speech model (one time)", 0)
            do {
                let folder = try await WhisperKit.download(variant: variant, progressCallback: { progress in
                    stage("Downloading speech model (one time) · \(Int(progress.fractionCompleted * 100))%", progress.fractionCompleted * 0.3)
                })
                stage("Loading speech model", 0.3)
                // Keep every stage off the GPU: iOS stops apps that use the GPU in the background.
                let compute = ModelComputeOptions(melCompute: .cpuOnly, audioEncoderCompute: .cpuAndNeuralEngine, textDecoderCompute: .cpuAndNeuralEngine)
                pipe = try await WhisperKit(WhisperKitConfig(model: variant, modelFolder: folder.path, computeOptions: compute, verbose: false, logLevel: .error, prewarm: true, load: true, download: false))
                loadedVariant = variant
            } catch { throw TranscriptionError.modelUnavailable(error.localizedDescription) }
        }
        guard let pipe else { throw TranscriptionError.modelUnavailable("not loaded") }

        var options = DecodingOptions()
        options.skipSpecialTokens = true
        options.chunkingStrategy = .vad
        if request.language == .auto { options.language = nil; options.detectLanguage = true } else { options.language = request.language.rawValue; options.detectLanguage = false }
        let terms = request.vocabulary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !terms.isEmpty, let tokenizer = pipe.tokenizer {
            options.promptTokens = tokenizer.encode(text: " " + terms).filter { $0 < tokenizer.specialTokens.specialTokenBegin }
        }

        stage("Transcribing", 0.32)
        let watcher = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                let fraction = pipe.progress.fractionCompleted
                stage("Transcribing \(Int(fraction * 100))%", 0.32 + 0.68 * fraction)
            }
        }
        defer { watcher.cancel() }
        let results = try await pipe.transcribe(audioPath: request.wav.path, audioInputOptions: AudioInputOptions(audioLoadingMode: .incremental), decodeOptions: options)
        let segments = results.flatMap(\.segments).map { SpeechSegment(start: Double($0.start), end: Double($0.end), text: $0.text) }.sorted { $0.start < $1.start }
        let detected = results.first?.language ?? request.language.rawValue
        let label = variant.contains("large-v3") ? "Whisper large-v3-turbo" : "Whisper \(variant)"
        return Transcript(language: request.language == .auto ? detected : request.language.rawValue, model: label, device: "iPhone", segments: segments)
    }
}

/// Optional cloud transcription through Groq's free Whisper API. Audio is uploaded to Groq.
enum GroqService {
    static let endpoint = URL(string: "https://api.groq.com/openai/v1/audio/transcriptions")!
    static let chunkSeconds = 600.0

    static func transcribe(_ request: TranscriptionRequest, key: String, workFolder: URL, session: URLSession = .shared, stage: @escaping StageCallback) async throws -> Transcript {
        guard !key.isEmpty else { throw TranscriptionError.groqKeyMissing }
        // Cut near every 10 minutes, in the quietest moment, so no word is split between uploads.
        var cuts: [Double] = [0]
        while request.duration - cuts.last! > chunkSeconds + 90 {
            cuts.append(try AudioProcessor.quietPoint(in: request.wav, near: cuts.last! + chunkSeconds))
        }
        let parts = cuts.enumerated().map { index, start in (start, index + 1 < cuts.count ? cuts[index + 1] : request.duration) }
        var segments: [SpeechSegment] = []
        var detected: String?
        for (index, part) in parts.enumerated() {
            try Task.checkCancellation()
            stage("Transcribing with Groq · part \(index + 1) of \(parts.count)", Double(index) / Double(parts.count))
            let chunk = workFolder.appendingPathComponent("groq-\(index).wav")
            try AudioProcessor.slice(request.wav, start: part.0, end: part.1, to: chunk)
            defer { try? FileManager.default.removeItem(at: chunk) }
            let result = try await upload(chunk, key: key, language: request.language, prompt: request.vocabulary, session: session)
            detected = detected ?? result.language
            for segment in result.segments ?? [] where !segment.text.trimmingCharacters(in: .whitespaces).isEmpty {
                segments.append(SpeechSegment(start: part.0 + segment.start, end: part.0 + segment.end, text: segment.text.trimmingCharacters(in: .whitespaces)))
            }
            if result.segments == nil, let text = result.text, !text.isEmpty { segments.append(SpeechSegment(start: part.0, end: part.1, text: text)) }
        }
        let names = ["arabic": "ar", "english": "en"]
        let language = request.language != .auto ? request.language.rawValue : names[(detected ?? "").lowercased()] ?? detected ?? "auto"
        return Transcript(language: language, model: "Groq whisper-large-v3-turbo", device: "Cloud", segments: segments)
    }

    struct Response: Decodable {
        struct Segment: Decodable { var start: Double; var end: Double; var text: String }
        var language: String?
        var text: String?
        var segments: [Segment]?
    }

    static func upload(_ file: URL, key: String, language: LectureLanguage, prompt: String, session: URLSession, attempts: Int = 6) async throws -> Response {
        let boundary = "notakillite-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) { body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!) }
        field("model", "whisper-large-v3-turbo")
        field("response_format", "verbose_json")
        field("temperature", "0")
        if language != .auto { field("language", language.rawValue) }
        let terms = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !terms.isEmpty { field("prompt", String(terms.prefix(600))) }
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(file.lastPathComponent)\"\r\nContent-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(try Data(contentsOf: file))
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 300

        for attempt in 1...attempts {
            let data: Data, response: URLResponse
            do { (data, response) = try await session.upload(for: request, from: body) }
            catch {
                if error is CancellationError || attempt == attempts { throw error is CancellationError ? error : TranscriptionError.network }
                try await Task.sleep(nanoseconds: UInt64(2 * attempt) * 1_000_000_000); continue
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) { return try JSONDecoder().decode(Response.self, from: data) }
            if status == 401 || status == 403 { throw TranscriptionError.groqRejected }
            if (status == 429 || status >= 500) && attempt < attempts {
                let retryAfter = Double((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "retry-after") ?? "") ?? min(60, 5 * pow(2, Double(attempt - 1)))
                try await Task.sleep(nanoseconds: UInt64(min(retryAfter, 120) * 1_000_000_000)); continue
            }
            if status == 429 { throw TranscriptionError.groqLimit }
            throw TranscriptionError.groqFailed(status, String(decoding: data.prefix(200), as: UTF8.self))
        }
        throw TranscriptionError.network
    }
}
