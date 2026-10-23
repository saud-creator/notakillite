import AVFoundation
import AudioToolbox

enum CleanupMode: String, CaseIterable, Identifiable, Codable {
    case voiceIsolation, none
    var id: String { rawValue }
    var label: String { self == .voiceIsolation ? "Apple Voice Isolation" : "Original audio" }
}

struct ProcessedAudio {
    var cleanedM4A: URL      // for the user to keep or share
    var speechWAV: URL       // 16 kHz mono for speech recognition
    var duration: Double
    var cleanupLabel: String
}

enum AudioProcessingError: LocalizedError {
    case unreadable, failed(String)
    var errorDescription: String? {
        switch self {
        case .unreadable: return "This recording has no readable audio, is damaged, or is protected."
        case .failed(let reason): return "Audio processing failed: \(reason)"
        }
    }
}

/// Removes background noise (air conditioning, fans, room hum) on-device and prepares speech audio.
enum AudioProcessor {
    static let workRate = 48_000.0
    static let speechRate = 16_000.0

    /// Apple's ML voice isolation effect ('vois'), available from iOS 16. No third-party model needed.
    static var voiceIsolationDescription: AudioComponentDescription {
        AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: 0x766F_6973, componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
    }
    static var voiceIsolationAvailable: Bool {
        var description = voiceIsolationDescription
        return AudioComponentFindNext(nil, &description) != nil
    }

    static func process(input: URL, mode: CleanupMode, workFolder: URL, progress: @escaping (Double) -> Void) throws -> ProcessedAudio {
        try FileManager.default.createDirectory(at: workFolder, withIntermediateDirectories: true)
        let source: AVAudioFile
        do { source = try AVAudioFile(forReading: input) } catch { throw AudioProcessingError.unreadable }
        guard source.length > 0 else { throw AudioProcessingError.unreadable }

        // 1. Decode to 48 kHz mono so every source format reaches the effect the same way.
        let mono48 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: workRate, channels: 1, interleaved: false)!
        let decoded = workFolder.appendingPathComponent("decoded-48k.caf")
        try convert(source, to: decoded, format: mono48) { progress($0 * 0.25) }
        let decodedFile = try AVAudioFile(forReading: decoded)
        let totalFrames = decodedFile.length

        // 2. Render through voice isolation (or straight through) in offline mode.
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        var useIsolation = mode == .voiceIsolation && voiceIsolationAvailable
        if useIsolation {
            let effect = AVAudioUnitEffect(audioComponentDescription: voiceIsolationDescription)
            engine.attach(effect)
            engine.connect(player, to: effect, format: mono48)
            engine.connect(effect, to: engine.mainMixerNode, format: mono48)
        } else {
            useIsolation = false
            engine.connect(player, to: engine.mainMixerNode, format: mono48)
        }
        try engine.enableManualRenderingMode(.offline, format: mono48, maximumFrameCount: 4096)
        try engine.start()
        player.scheduleFile(decodedFile, at: nil)
        player.play()
        defer { player.stop(); engine.stop() }

        let cleaned = workFolder.appendingPathComponent("cleaned.m4a")
        let speech = workFolder.appendingPathComponent("speech-16k.wav")
        try? FileManager.default.removeItem(at: cleaned)
        try? FileManager.default.removeItem(at: speech)
        let aac: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: workRate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000]
        let cleanedFile = try AVAudioFile(forWriting: cleaned, settings: aac, commonFormat: .pcmFormatFloat32, interleaved: false)
        let speechFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: speechRate, channels: 1, interleaved: true)!
        let speechFile = try AVAudioFile(forWriting: speech, settings: speechFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let toSpeech = AVAudioConverter(from: mono48, to: speechFile.processingFormat)!

        let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: engine.manualRenderingMaximumFrameCount)!
        while engine.manualRenderingSampleTime < totalFrames {
            try Task.checkCancellation()
            let remaining = AVAudioFrameCount(totalFrames - engine.manualRenderingSampleTime)
            let status = try engine.renderOffline(min(buffer.frameCapacity, remaining), to: buffer)
            switch status {
            case .success:
                try cleanedFile.write(from: buffer)
                try appendConverted(buffer, with: toSpeech, to: speechFile)
                progress(0.25 + 0.75 * Double(engine.manualRenderingSampleTime) / Double(totalFrames))
            case .insufficientDataFromInputNode, .cannotDoInCurrentContext: continue
            case .error: throw AudioProcessingError.failed("the audio engine stopped")
            @unknown default: throw AudioProcessingError.failed("unknown render status")
            }
        }
        try? FileManager.default.removeItem(at: decoded)
        return ProcessedAudio(cleanedM4A: cleaned, speechWAV: speech, duration: Double(totalFrames) / workRate, cleanupLabel: useIsolation ? CleanupMode.voiceIsolation.label : CleanupMode.none.label)
    }

    /// Streams any readable file into `destination` in `format`, resampling and mixing to mono.
    static func convert(_ source: AVAudioFile, to destination: URL, format: AVAudioFormat, progress: (Double) -> Void) throws {
        try? FileManager.default.removeItem(at: destination)
        let output = try AVAudioFile(forWriting: destination, settings: format.settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        guard let converter = AVAudioConverter(from: source.processingFormat, to: format) else { throw AudioProcessingError.unreadable }
        if source.processingFormat.channelCount > 1 { converter.downmix = true }
        let input = AVAudioPCMBuffer(pcmFormat: source.processingFormat, frameCapacity: 32_768)!
        var finished = false
        while !finished {
            try Task.checkCancellation()
            let capacity = AVAudioFrameCount(Double(input.frameCapacity) * format.sampleRate / source.processingFormat.sampleRate) + 1024
            let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)!
            var readError: Error?
            let status = converter.convert(to: out, error: nil) { _, inputStatus in
                do {
                    try source.read(into: input)
                    if input.frameLength == 0 { inputStatus.pointee = .endOfStream; return nil }
                    inputStatus.pointee = .haveData
                    return input
                } catch { readError = error; inputStatus.pointee = .endOfStream; return nil }
            }
            if let readError { throw AudioProcessingError.failed(readError.localizedDescription) }
            if out.frameLength > 0 { try output.write(from: out) }
            if status == .endOfStream || status == .error { finished = true }
            progress(Double(source.framePosition) / Double(max(1, source.length)))
        }
    }

    private static func appendConverted(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to file: AVAudioFile) throws {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * file.processingFormat.sampleRate / buffer.format.sampleRate) + 64
        let out = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: capacity)!
        var supplied = false
        _ = converter.convert(to: out, error: nil) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        if out.frameLength > 0 { try file.write(from: out) }
    }

    /// Writes [start, end) seconds of a 16 kHz WAV to a new WAV file (used for Groq uploads).
    static func slice(_ wav: URL, start: Double, end: Double, to destination: URL) throws {
        let file = try AVAudioFile(forReading: wav)
        let rate = file.processingFormat.sampleRate
        file.framePosition = AVAudioFramePosition(start * rate)
        let frames = AVAudioFrameCount(max(0, (end - start) * rate))
        try? FileManager.default.removeItem(at: destination)
        let output = try AVAudioFile(forWriting: destination, settings: file.fileFormat.settings, commonFormat: file.processingFormat.commonFormat, interleaved: file.processingFormat.isInterleaved)
        var left = frames
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 65_536)!
        while left > 0 {
            try file.read(into: buffer, frameCount: min(left, buffer.frameCapacity))
            if buffer.frameLength == 0 { break }
            try output.write(from: buffer)
            left -= buffer.frameLength
        }
    }

    /// Quietest 0.25 s window within ±`window` seconds of `target`, so uploads are cut in pauses.
    static func quietPoint(in wav: URL, near target: Double, window: Double = 20) throws -> Double {
        let file = try AVAudioFile(forReading: wav)
        let rate = file.processingFormat.sampleRate
        let start = max(0, target - window)
        file.framePosition = AVAudioFramePosition(start * rate)
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(window * 2 * rate))!
        try file.read(into: buffer)
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return target }
        let step = Int(rate / 4)
        var best = target, quietest = Float.greatestFiniteMagnitude
        var offset = 0
        while offset + step <= Int(buffer.frameLength) {
            var energy: Float = 0
            for i in offset..<(offset + step) { energy += samples[i] * samples[i] }
            if energy < quietest { quietest = energy; best = start + (Double(offset) + Double(step) / 2) / rate }
            offset += step
        }
        return best
    }
}
