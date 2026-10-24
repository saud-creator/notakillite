import XCTest
@testable import Mentality

/// A fake speech service: answers requests from a script instead of the network and records them.
final class MockServer: @unchecked Sendable {
    struct Reply {
        var status = 200
        var body = "{}"
        var headers: [String: String] = ["Content-Type": "application/json"]
        var delay = 0.0
        var dropConnection = false
    }

    struct Request {
        var url: String
        var headers: [String: String]
        var fields: [(name: String, value: String)]
        var audioBytes: Int

        func values(_ name: String) -> [String] { fields.filter { $0.name == name }.map(\.value) }
        func value(_ name: String) -> String? { values(name).first }
    }

    static let shared = MockServer()
    private let lock = NSLock()
    private var handler: (Request, Int) -> Reply = { _, _ in Reply() }
    private var received: [Request] = []

    func reset(_ handler: @escaping (Request, Int) -> Reply) {
        lock.lock()
        self.handler = handler
        received = []
        lock.unlock()
    }

    var requests: [Request] {
        lock.lock()
        defer { lock.unlock() }
        return received
    }

    func reply(to request: URLRequest, body: Data) -> Reply {
        let parsed = Request(url: request.url?.absoluteString ?? "", headers: request.allHTTPHeaderFields ?? [:],
                             fields: Self.fields(body, contentType: request.value(forHTTPHeaderField: "Content-Type") ?? ""),
                             audioBytes: Self.fileSize(body, contentType: request.value(forHTTPHeaderField: "Content-Type") ?? ""))
        lock.lock()
        let index = received.count
        received.append(parsed)
        let handler = self.handler
        lock.unlock()
        return handler(parsed, index)
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    /// The text fields of a multipart/form-data body, in order. The file is listed as "<file>".
    static func fields(_ body: Data, contentType: String) -> [(name: String, value: String)] {
        parts(body, contentType: contentType).map { part in
            (part.name, part.isFile ? "<file>" : String(decoding: part.data, as: UTF8.self))
        }
    }

    static func fileSize(_ body: Data, contentType: String) -> Int {
        parts(body, contentType: contentType).first(where: \.isFile)?.data.count ?? 0
    }

    private static func parts(_ body: Data, contentType: String) -> [(name: String, isFile: Bool, data: Data)] {
        guard let range = contentType.range(of: "boundary=") else { return [] }
        let boundary = Data(("--" + contentType[range.upperBound...]).utf8)
        let separator = Data("\r\n\r\n".utf8)
        var out: [(name: String, isFile: Bool, data: Data)] = []
        var position = body.startIndex
        var starts: [Data.Index] = []
        while let found = body.range(of: boundary, in: position..<body.endIndex) {
            starts.append(found.upperBound)
            position = found.upperBound
        }
        for (i, start) in starts.enumerated() where i + 1 < starts.count {
            let end = starts[i + 1] - boundary.count
            let chunk = body[start..<end]
            guard let split = chunk.range(of: separator) else { continue }
            let header = String(decoding: chunk[chunk.startIndex..<split.lowerBound], as: UTF8.self)
            var content = chunk[split.upperBound..<chunk.endIndex]
            if content.count >= 2 { content = content.dropLast(2) }   // the \r\n before the next boundary
            guard let nameStart = header.range(of: "name=\"") else { continue }
            let rest = header[nameStart.upperBound...]
            let name = String(rest.prefix { $0 != "\"" })
            out.append((name, header.contains("filename="), Data(content)))
        }
        return out
    }
}

final class MockURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let reply = MockServer.shared.reply(to: request, body: Self.body(of: request))
        let send = { [self] in
            if reply.dropConnection {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        if reply.delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay, execute: send)
        } else {
            send()
        }
    }

    override func stopLoading() {}

    /// URLSession moves the body into a stream before it reaches a URL protocol.
    static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let size = 65_536
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: size)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// The cloud speech option against a fake server: the requests each service expects, their answers,
/// retries when a service is busy, and the errors that stop the queue.
final class CloudEngineTests: XCTestCase {
    private var server: MockServer { MockServer.shared }

    private func engine(_ service: SpeechService, model: String? = nil, key: String = "test-key", baseURL: String = "") -> CloudSpeechEngine {
        let engine = CloudSpeechEngine(config: CloudConfig(service: service, model: model ?? service.defaultModel, apiKey: key, baseURL: baseURL),
                                       session: MockServer.session())
        engine.retryDelayScale = 0.001
        return engine
    }

    /// Seconds of a quiet tone at 16 kHz.
    private func piece(_ seconds: Double) -> [Float] {
        (0..<Int(seconds * 16_000)).map { Float(sin(Double($0) * 0.07)) * 0.1 }
    }

    private func json(_ object: Any) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    func testOpenAIGptTranscribeRequestAndAnswer() async throws {
        server.reset { _, _ in
            MockServer.Reply(body: self.json(["text": "This is very important for the exam. The inguinal ligament comes next.",
                                              "languages": [["code": "en"]]]))
        }
        let result = try await engine(.openAI).transcribe([piece(6)], settings: DecodeSettings(vocabulary: "inguinal ligament, cremaster\nparacentesis"))
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(server.requests.count, 1)
        XCTAssertEqual(request.url, "https://api.openai.com/v1/audio/transcriptions")
        XCTAssertEqual(request.headers["Authorization"], "Bearer test-key")
        XCTAssertEqual(request.value("model"), "gpt-transcribe")
        XCTAssertEqual(request.values("languages[]"), ["ar", "en"], "automatic language means Arabic or English")
        XCTAssertEqual(request.values("keywords[]"), ["inguinal ligament", "cremaster", "paracentesis"])
        XCTAssertEqual(request.value("file"), "<file>")
        XCTAssertEqual(request.audioBytes, 44 + 6 * 16_000 * 2, "16 kHz 16-bit WAV")

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].language, "en")
        XCTAssertEqual(result[0].segments.map(\.text), ["This is very important for the exam.", "The inguinal ligament comes next."])
        XCTAssertEqual(result[0].segments.first?.start, 0)
        XCTAssertEqual(result[0].segments.last?.end ?? 0, 6, accuracy: 0.001, "text without times is spread over the piece")
    }

    func testFixedLanguageIsSentToEveryService() async throws {
        server.reset { _, _ in MockServer.Reply(body: self.json(["text": "مرحبا"])) }
        _ = try await engine(.openAI, model: "gpt-4o-transcribe").transcribe([piece(2)], settings: DecodeSettings(language: "ar"))
        XCTAssertEqual(server.requests.last?.value("language"), "ar")
        XCTAssertEqual(server.requests.last?.value("response_format"), "json")
        _ = try await engine(.openAI).transcribe([piece(2)], settings: DecodeSettings(language: "ar"))
        XCTAssertEqual(server.requests.last?.values("languages[]"), ["ar"])
        server.reset { _, _ in MockServer.Reply(body: self.json(["language_code": "ara", "text": "مرحبا", "words": []])) }
        _ = try await engine(.elevenLabs).transcribe([piece(2)], settings: DecodeSettings(language: "ar"))
        XCTAssertEqual(server.requests.last?.value("language_code"), "ar")
    }

    func testGroqWhisperTimestampsAndPersianIsRetriedAsArabic() async throws {
        server.reset { request, index in
            if index == 0 {
                return MockServer.Reply(body: self.json(["language": "persian", "text": "سلام",
                                                         "segments": [["start": 0.0, "end": 2.0, "text": "سلام", "no_speech_prob": 0.1, "avg_logprob": -0.3]]]))
            }
            return MockServer.Reply(body: self.json(["language": "arabic", "text": "...", "segments": [
                ["start": 0.4, "end": 2.5, "text": " اليوم نتكلم عن جدار البطن", "no_speech_prob": 0.05, "avg_logprob": -0.2],
                ["start": 2.5, "end": 3.0, "text": " شكرا", "no_speech_prob": 0.9, "avg_logprob": -1.5],
                ["start": 3.1, "end": 9.0, "text": " وهذا مهم جدا للامتحان", "no_speech_prob": 0.02, "avg_logprob": -0.25],
            ]]))
        }
        let result = try await engine(.groq).transcribe([piece(8)], settings: DecodeSettings())
        XCTAssertEqual(server.requests.count, 2)
        let first = server.requests[0], second = server.requests[1]
        XCTAssertEqual(first.url, "https://api.groq.com/openai/v1/audio/transcriptions")
        XCTAssertEqual(first.value("model"), "whisper-large-v3")
        XCTAssertEqual(first.value("response_format"), "verbose_json")
        XCTAssertEqual(first.value("timestamp_granularities[]"), "segment")
        XCTAssertNil(first.value("language"))
        XCTAssertEqual(second.value("language"), "ar", "Persian is asked again as Arabic")

        XCTAssertEqual(result[0].language, "ar")
        XCTAssertEqual(result[0].segments.map(\.text), [" اليوم نتكلم عن جدار البطن", " وهذا مهم جدا للامتحان"], "Whisper's own no-speech rule drops the made-up line")
        XCTAssertEqual(result[0].segments[0].start, 0.4)
        XCTAssertEqual(result[0].segments[1].end, 8, "times stay inside the piece")
    }

    func testElevenLabsScribeWordsBecomeSegments() async throws {
        server.reset { _, _ in
            MockServer.Reply(body: self.json(["language_code": "eng", "text": "Hello world. Next part.", "words": [
                ["text": "Hello", "start": 0.2, "end": 0.6, "type": "word"],
                ["text": " ", "start": 0.6, "end": 0.7, "type": "spacing"],
                ["text": "world.", "start": 0.7, "end": 1.1, "type": "word"],
                ["text": "(coughs)", "start": 1.2, "end": 1.5, "type": "audio_event"],
                ["text": "Next", "start": 3.0, "end": 3.3, "type": "word"],
                ["text": " ", "start": 3.3, "end": 3.35, "type": "spacing"],
                ["text": "part.", "start": 3.35, "end": 3.8, "type": "word"],
            ]]))
        }
        let result = try await engine(.elevenLabs).transcribe([piece(5)], settings: DecodeSettings(vocabulary: "rectus sheath, a very long phrase that has far too many words in it, [bad]"))
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.url, "https://api.elevenlabs.io/v1/speech-to-text")
        XCTAssertEqual(request.headers["xi-api-key"], "test-key")
        XCTAssertNil(request.headers["Authorization"])
        XCTAssertEqual(request.value("model_id"), "scribe_v2")
        XCTAssertEqual(request.value("timestamps_granularity"), "word")
        XCTAssertEqual(request.value("tag_audio_events"), "false")
        XCTAssertNil(request.value("language_code"), "automatic language")
        XCTAssertEqual(request.values("keyterms"), ["rectus sheath"], "terms ElevenLabs doesn't accept are left out")

        XCTAssertEqual(result[0].language, "en")
        XCTAssertEqual(result[0].segments.map(\.text), ["Hello world.", "Next part."], "a pause starts a new segment; sounds are dropped")
        XCTAssertEqual(result[0].segments[0].start, 0.2, accuracy: 0.001)
        XCTAssertEqual(result[0].segments[1].end, 3.8, accuracy: 0.001)
    }

    func testRejectedKeyTermsAreDroppedAndTheRequestRepeated() async throws {
        server.reset { request, _ in
            request.values("keyterms").isEmpty
                ? MockServer.Reply(body: self.json(["language_code": "en", "text": "Fine.", "words": []]))
                : MockServer.Reply(status: 422, body: self.json(["detail": ["message": "invalid keyterms"]]))
        }
        let result = try await engine(.elevenLabs).transcribe([piece(2)], settings: DecodeSettings(vocabulary: "cremaster"))
        XCTAssertEqual(server.requests.count, 2)
        XCTAssertEqual(result[0].segments.map(\.text), ["Fine."])
    }

    func testBusyServiceAndDroppedConnectionsAreRetried() async throws {
        server.reset { _, index in
            switch index {
            case 0: return MockServer.Reply(status: 429, body: self.json(["error": ["message": "Rate limit reached"]]), headers: ["Retry-After": "0"])
            case 1: return MockServer.Reply(status: 503, body: "Service Unavailable")
            case 2: return MockServer.Reply(dropConnection: true)
            default: return MockServer.Reply(body: self.json(["text": "Done at last."]))
            }
        }
        let result = try await engine(.custom, model: "whisper-1", key: "", baseURL: "https://speech.example.com/v1/").transcribe([piece(2)], settings: DecodeSettings())
        XCTAssertEqual(server.requests.count, 4)
        XCTAssertEqual(server.requests[0].url, "https://speech.example.com/v1/audio/transcriptions")
        XCTAssertNil(server.requests[0].headers["Authorization"], "no key, no Authorization header")
        XCTAssertEqual(result[0].segments.map(\.text), ["Done at last."])
    }

    func testProblemsThatWouldFailEveryLectureStopTheQueue() async throws {
        server.reset { _, _ in MockServer.Reply(status: 401, body: self.json(["error": ["message": "Incorrect API key provided"]])) }
        do {
            _ = try await engine(.openAI).transcribe([piece(1)], settings: DecodeSettings())
            XCTFail("expected an error")
        } catch let error as CloudSpeechError {
            guard case .rejectedKey = error else { return XCTFail("\(error)") }
            XCTAssertTrue(error.localizedDescription.contains("Incorrect API key provided"))
            XCTAssertTrue(LibraryModel.stopsQueue(error))
        }
        XCTAssertEqual(server.requests.count, 1, "a rejected key is not retried")

        server.reset { _, _ in MockServer.Reply(status: 429, body: self.json(["error": ["message": "You exceeded your current quota", "code": "insufficient_quota"]])) }
        do {
            _ = try await engine(.openAI).transcribe([piece(1)], settings: DecodeSettings())
            XCTFail("expected an error")
        } catch let error as CloudSpeechError {
            guard case .quota = error else { return XCTFail("\(error)") }
            XCTAssertTrue(LibraryModel.stopsQueue(error))
        }
        XCTAssertEqual(server.requests.count, 1, "no credit is not retried")

        server.reset { _, _ in MockServer.Reply(status: 404, body: "Not Found") }
        do {
            _ = try await engine(.custom, model: "whisper-1", baseURL: "https://example.com/wrong").transcribe([piece(1)], settings: DecodeSettings())
            XCTFail("expected an error")
        } catch let error as CloudSpeechError {
            guard case .badAddress = error else { return XCTFail("\(error)") }
        }

        do {
            _ = try await engine(.custom, model: "whisper-1", baseURL: "not an address").transcribe([piece(1)], settings: DecodeSettings())
            XCTFail("expected an error")
        } catch let error as CloudSpeechError {
            guard case .badAddress = error else { return XCTFail("\(error)") }
        }

        XCTAssertTrue(LibraryModel.stopsQueue(CloudSpeechError.missingKey("OpenAI")))
        XCTAssertTrue(LibraryModel.stopsQueue(WhisperEngineError.modelUnavailable("offline")))
        XCTAssertFalse(LibraryModel.stopsQueue(CloudSpeechError.unreadable("odd answer")), "one odd answer only fails that lecture")
        XCTAssertFalse(LibraryModel.stopsQueue(AudioPreparationError.unreadable("x.m4a")))
    }

    func testPiecesComeBackInOrderWhileSentSeveralAtATime() async throws {
        // Piece n is 1 + n/10 seconds long; later pieces are answered sooner, so they finish first.
        server.reset { request, _ in
            let seconds = Double((request.audioBytes - 44) / 2) / 16_000
            let n = Int(((seconds - 1) * 10).rounded())
            return MockServer.Reply(body: self.json(["text": "Piece number \(n)."]), delay: Double(10 - n) * 0.02)
        }
        let pieces = (0..<10).map { piece(1 + Double($0) / 10) }
        let engine = engine(.openAI, model: "whisper-1")
        let result = try await engine.transcribe(pieces, settings: DecodeSettings())
        XCTAssertEqual(result.map { $0.segments.first?.text ?? "" }, (0..<10).map { "Piece number \($0)." })
        XCTAssertEqual(server.requests.count, 10)
    }

    func testWholePipelineWithACloudService() async throws {
        let folder = TestAudio.folder()
        let speech = folder.appendingPathComponent("speech-16k.wav")
        let duration = try TestAudio.writeSpeechLike(speech, pattern: TestAudio.repeating(8, 2, count: 12), amplitude: 0.3)
        let audio = PreparedAudio(original: speech, speech: speech, cleanedM4A: nil, duration: duration, cleanupLabel: "test")
        server.reset { request, index in
            let seconds = Double((request.audioBytes - 44) / 2) / 16_000
            return MockServer.Reply(body: self.json(["text": FakeText.sentence(index, words: max(3, Int(seconds * 2))), "languages": [["code": "en"]]]))
        }
        var options = TranscriptionPipeline.Options()
        options.batchSize = 8
        options.retryBudgetShare = 0.5
        let transcript = try await TranscriptionPipeline(engine: engine(.openAI), options: options).run(audio: audio, checkpoint: nil) { _, _ in }
        XCTAssertEqual(transcript.model, "OpenAI gpt-transcribe (cloud)")
        XCTAssertEqual(transcript.quality.status, .ok)
        XCTAssertGreaterThan(transcript.words, 100)
        XCTAssertEqual(transcript.languages["en"], 1)
        XCTAssertLessThan(Double(server.requests.count), duration / 8 + 2, "silence is not sent: one request per spoken piece")
    }

    func testKeysAreSavedReadAndRemoved() throws {
        let account = "test-\(UUID().uuidString)"
        XCTAssertNil(KeyStore.read(account))
        try KeyStore.save("  sk-123  ", for: account)
        XCTAssertEqual(KeyStore.read(account), "sk-123", "spaces around a pasted key are removed")
        try KeyStore.save("sk-456", for: account)
        XCTAssertEqual(KeyStore.read(account), "sk-456")
        KeyStore.delete(account)
        XCTAssertNil(KeyStore.read(account))
    }

    func testWAVEncoding() {
        let data = WAV.encode([0, 0.5, -1, 1.5], sampleRate: 16_000)
        XCTAssertEqual(data.count, 44 + 8)
        XCTAssertEqual(String(decoding: data.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: data[8..<12], as: UTF8.self), "WAVE")
        let samples = data.suffix(8).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }.map { Int16(littleEndian: $0) }
        XCTAssertEqual(samples, [0, 16_384, -32_768, 32_767])
    }

    // MARK: Live services (only with your own keys)

    /// Real requests, when CI has keys (repository secrets) or you set them for a local run.
    private func live(_ service: SpeechService, keyName: String) async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let key = environment[keyName], !key.isEmpty else { throw XCTSkip("Set \(keyName) to test \(service.name) for real.") }
        guard let path = environment["MENTALITY_E2E_EN"], FileManager.default.fileExists(atPath: path) else { throw XCTSkip("No spoken test lecture.") }
        let audio = try await AudioPreparer.prepare(input: URL(fileURLWithPath: path), mode: .lowCut, keepCleanedAudio: false, folder: TestAudio.folder()) { _ in }
        let engine = CloudSpeechEngine(config: CloudConfig(service: service, model: service.defaultModel, apiKey: key))
        let transcript = try await TranscriptionPipeline(engine: engine, options: .init()).run(audio: audio, checkpoint: nil) { _, _ in }
        let text = transcript.segments.map(\.text).joined(separator: " ").lowercased()
        print("\(service.name): \(text)")
        for word in ["abdominal", "exam"] { XCTAssertTrue(text.contains(word), "missing \"\(word)\" in: \(text)") }
    }

    func testLiveOpenAI() async throws { try await live(.openAI, keyName: "MENTALITY_OPENAI_KEY") }
    func testLiveGroq() async throws { try await live(.groq, keyName: "MENTALITY_GROQ_KEY") }
    func testLiveElevenLabs() async throws { try await live(.elevenLabs, keyName: "MENTALITY_ELEVENLABS_KEY") }
}
