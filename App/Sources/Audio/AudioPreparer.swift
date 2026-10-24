import AudioToolbox
import AVFoundation
import Foundation

enum CleanupMode: String, CaseIterable, Identifiable, Codable, Sendable {
    case voiceIsolation, lowCut, none
    var id: String { rawValue }
    var label: String {
        switch self {
        case .voiceIsolation: "Apple Voice Isolation (removes AC, fans, chatter)"
        case .lowCut: "Light: remove rumble and hum only"
        case .none: "Off: use the original audio"
        }
    }
    var shortLabel: String {
        switch self {
        case .voiceIsolation: "Apple Voice Isolation + rumble filter"
        case .lowCut: "Rumble filter"
        case .none: "None"
        }
    }
}

/// The audio files one lecture needs. Both WAVs are 16 kHz mono, the format Whisper expects.
struct PreparedAudio: Codable, Equatable, Sendable {
    var original: URL          // decoded source, no processing: used when a part fails the quality check
    var speech: URL            // after noise cleanup: used for the first transcription pass
    var cleanedM4A: URL?       // cleaned audio for the user to keep or listen to
    var duration: Double
    var cleanupLabel: String
}

enum AudioPreparationError: LocalizedError {
    case unreadable(String), failed(String)
    var errorDescription: String? {
        switch self {
        case .unreadable(let name): "\(name) has no readable audio, is damaged, or is protected."
        case .failed(let reason): "Audio processing failed: \(reason)"
        }
    }
}

/// Decodes any recording, removes background noise on-device, and writes 16 kHz speech audio.
///
/// Runs on the CPU only, so it keeps working in the background (iPadOS doesn't allow GPU work there).
enum AudioPreparer {
    static let workRate = 48_000.0
    static let speechRate = 16_000.0

    /// Apple's machine-learning voice isolation effect ('vois'), built into iPadOS.
    static var voiceIsolationDescription: AudioComponentDescription {
        AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: 0x766F_6973,
                                  componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
    }

    static var voiceIsolationAvailable: Bool {
        var description = voiceIsolationDescription
        return AudioComponentFindNext(nil, &description) != nil
    }

    static var speechFormat: AVAudioFormat {
        AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: speechRate, channels: 1, interleaved: true)!
    }

    static func prepare(input: URL, mode: CleanupMode, keepCleanedAudio: Bool, folder: URL,
                        progress: @escaping @Sendable (Double) -> Void) throws -> PreparedAudio {
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let source: AVAudioFile
        do { source = try AVAudioFile(forReading: input) } catch { throw AudioPreparationError.unreadable(input.lastPathComponent) }
        guard source.length > 0 else { throw AudioPreparationError.unreadable(input.lastPathComponent) }

        // 1. Decode to 48 kHz mono so every source format reaches the effects the same way.
        let mono48 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: workRate, channels: 1, interleaved: false)!
        let decoded = folder.appendingPathComponent("decoded-48k.caf")
        try convert(source, to: decoded, format: mono48) { progress($0 * 0.2) }
        defer { try? fm.removeItem(at: decoded) }

        // 2. The untouched original at 16 kHz, kept for retries.
        let original = folder.appendingPathComponent("original-16k.wav")
        try convert(try AVAudioFile(forReading: decoded), to: original, format: speechFormat) { progress(0.2 + $0 * 0.15) }

        let duration = Double(try AVAudioFile(forReading: decoded).length) / workRate
        if mode == .none {
            progress(1)
            return PreparedAudio(original: original, speech: original, cleanedM4A: nil, duration: duration, cleanupLabel: CleanupMode.none.shortLabel)
        }

        // 3. Noise cleanup, rendered offline (faster than real time).
        let speech = folder.appendingPathComponent("speech-16k.wav")
        let cleaned = keepCleanedAudio ? folder.appendingPathComponent("cleaned.m4a") : nil
        let usedIsolation = try render(decoded: decoded, isolation: mode == .voiceIsolation && voiceIsolationAvailable,
                                       speech: speech, cleaned: cleaned) { progress(0.35 + $0 * 0.6) }

        // 4. Safety net: if cleanup removed most of the voice, transcribe the original instead.
        let before = try loudness(original), after = try loudness(speech)
        progress(1)
        if after < before - 20 || after < -65 {
            try? fm.removeItem(at: speech)
            return PreparedAudio(original: original, speech: original, cleanedM4A: cleaned, duration: duration,
                                 cleanupLabel: "None (cleanup removed too much of the voice, so the original audio was used)")
        }
        var label = usedIsolation ? CleanupMode.voiceIsolation.shortLabel : CleanupMode.lowCut.shortLabel
        if mode == .voiceIsolation && !usedIsolation { label += " (Voice Isolation not available on this device)" }
        return PreparedAudio(original: original, speech: speech, cleanedM4A: cleaned, duration: duration, cleanupLabel: label)
    }

    /// Plays the decoded audio through a rumble filter (and Voice Isolation) in offline mode.
    private static func render(decoded: URL, isolation: Bool, speech: URL, cleaned: URL?, progress: (Double) -> Void) throws -> Bool {
        let input = try AVAudioFile(forReading: decoded)
        let format = input.processingFormat
        let total = input.length
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let lowCut = AVAudioUnitEQ(numberOfBands: 1)
        lowCut.bands[0].filterType = .highPass
        lowCut.bands[0].frequency = 80
        lowCut.bands[0].bypass = false
        engine.attach(player)
        engine.attach(lowCut)
        engine.connect(player, to: lowCut, format: format)
        if isolation {
            let effect = AVAudioUnitEffect(audioComponentDescription: voiceIsolationDescription)
            engine.attach(effect)
            engine.connect(lowCut, to: effect, format: format)
            engine.connect(effect, to: engine.mainMixerNode, format: format)
        } else {
            engine.connect(lowCut, to: engine.mainMixerNode, format: format)
        }
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
        try engine.start()
        player.scheduleFile(input, at: nil)
        player.play()
        defer { player.stop(); engine.stop() }

        let fm = FileManager.default
        try? fm.removeItem(at: speech)
        let speechFile = try AVAudioFile(forWriting: speech, settings: speechFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        guard let toSpeech = AVAudioConverter(from: format, to: speechFile.processingFormat) else { throw AudioPreparationError.failed("no converter") }
        var cleanedFile: AVAudioFile?
        if let cleaned {
            try? fm.removeItem(at: cleaned)
            let aac: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: workRate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000]
            cleanedFile = try AVAudioFile(forWriting: cleaned, settings: aac, commonFormat: .pcmFormatFloat32, interleaved: false)
        }
        let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: engine.manualRenderingMaximumFrameCount)!
        var stalls = 0
        while engine.manualRenderingSampleTime < total {
            try Task.checkCancellation()
            let remaining = AVAudioFrameCount(total - engine.manualRenderingSampleTime)
            let status = try engine.renderOffline(min(buffer.frameCapacity, remaining), to: buffer)
            switch status {
            case .success:
                stalls = 0
                try cleanedFile?.write(from: buffer)
                try appendConverted(buffer, with: toSpeech, to: speechFile)
                progress(Double(engine.manualRenderingSampleTime) / Double(total))
            case .insufficientDataFromInputNode, .cannotDoInCurrentContext:
                stalls += 1
                if stalls > 10_000 { throw AudioPreparationError.failed("the audio engine stalled") }
            case .error: throw AudioPreparationError.failed("the audio engine stopped")
            @unknown default: throw AudioPreparationError.failed("unknown render status")
            }
        }
        return isolation
    }

    /// Streams any readable file into `destination` in `format`, resampling and mixing to mono.
    static func convert(_ source: AVAudioFile, to destination: URL, format: AVAudioFormat, progress: (Double) -> Void) throws {
        try? FileManager.default.removeItem(at: destination)
        let output = try AVAudioFile(forWriting: destination, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        guard let converter = AVAudioConverter(from: source.processingFormat, to: output.processingFormat) else {
            throw AudioPreparationError.unreadable(source.url.lastPathComponent)
        }
        if source.processingFormat.channelCount > 1 { converter.downmix = true }
        let input = AVAudioPCMBuffer(pcmFormat: source.processingFormat, frameCapacity: 32_768)!
        let ratio = output.processingFormat.sampleRate / source.processingFormat.sampleRate
        var finished = false
        while !finished {
            try Task.checkCancellation()
            let out = AVAudioPCMBuffer(pcmFormat: output.processingFormat, frameCapacity: AVAudioFrameCount(Double(input.frameCapacity) * ratio) + 1024)!
            var readError: Error?
            let status = converter.convert(to: out, error: nil) { _, inputStatus in
                // AVAudioFile throws (rather than returning 0 frames) when read at the end of the file.
                if source.framePosition >= source.length { inputStatus.pointee = .endOfStream; return nil }
                do {
                    try source.read(into: input)
                    if input.frameLength == 0 { inputStatus.pointee = .endOfStream; return nil }
                    inputStatus.pointee = .haveData
                    return input
                } catch { readError = error; inputStatus.pointee = .endOfStream; return nil }
            }
            if let readError { throw AudioPreparationError.failed(readError.localizedDescription) }
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
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        if out.frameLength > 0 { try file.write(from: out) }
    }

    /// Average loudness of the louder half of the recording, in dBFS (ignores pauses).
    static func loudness(_ url: URL) throws -> Double {
        let (levels, _) = try SpeechDetector.levels(of: url)
        guard !levels.isEmpty else { return -120 }
        let loud = levels.sorted().suffix(max(1, levels.count / 2))
        return loud.reduce(0, +) / Double(loud.count)
    }
}
