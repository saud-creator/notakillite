import AudioToolbox
import AVFoundation
import Foundation

enum CleanupMode: String, CaseIterable, Identifiable, Codable, Sendable {
    case deepFilter, rnnoise, voiceIsolation, lowCut, none
    var id: String { rawValue }

    var label: String {
        switch self {
        case .deepFilter: "DeepFilterNet 3 · best (recommended)"
        case .rnnoise: "RNNoise · fast, lighter"
        case .voiceIsolation: "Apple Voice Isolation"
        case .lowCut: "Light · rumble and hum only"
        case .none: "Off · original audio"
        }
    }

    var shortLabel: String {
        switch self {
        case .deepFilter: "DeepFilterNet 3 + rumble filter"
        case .rnnoise: "RNNoise + rumble filter"
        case .voiceIsolation: "Apple Voice Isolation + rumble filter"
        case .lowCut: "Rumble filter"
        case .none: "None"
        }
    }

    var detail: String {
        switch self {
        case .deepFilter: "A state-of-the-art neural network for speech, built into the app. Removes air conditioning, fans, traffic and chatter while keeping the voice natural. Uses all CPU cores."
        case .rnnoise: "A small, very fast neural network from Xiph. Removes steady noise well; less effective on chatter."
        case .voiceIsolation: "Apple's built-in voice isolation."
        case .lowCut: "Only removes low rumble and electrical hum."
        case .none: "Whisper gets the recording as it is."
        }
    }

    var neuralModel: NeuralModel? {
        switch self {
        case .deepFilter: .deepFilter
        case .rnnoise: .rnnoise
        default: nil
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
    case unreadable(String), failed(String), modelUnavailable(String)
    var errorDescription: String? {
        switch self {
        case .unreadable(let name): "\(name) has no readable audio, is damaged, or is protected."
        case .failed(let reason): "Audio processing failed: \(reason)"
        case .modelUnavailable(let reason): "The noise removal model could not start: \(reason)"
        }
    }
}

/// Decodes any recording, removes background noise on the device, and writes 16 kHz speech audio.
///
/// Runs on the CPU only, so it keeps working in the background (iPadOS doesn't allow GPU work there).
enum AudioPreparer {
    static let workRate = 48_000.0
    static let speechRate = 16_000.0

    /// Apple's machine-learning voice isolation effect ('vois'), built into iPadOS and iOS.
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

    /// The decoded recording is kept as 16-bit audio (half the space of 32-bit floats).
    static var decodedFormat: AVAudioFormat {
        AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: workRate, channels: 1, interleaved: true)!
    }

    static var cleanedAudioSettings: [String: Any] {
        [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: workRate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000]
    }

    static func prepare(input: URL, mode: CleanupMode, keepCleanedAudio: Bool, folder: URL,
                        progress: @escaping @Sendable (Double) -> Void) async throws -> PreparedAudio {
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let source: AVAudioFile
        do { source = try AVAudioFile(forReading: input) } catch { throw AudioPreparationError.unreadable(input.lastPathComponent) }
        guard source.length > 0 else { throw AudioPreparationError.unreadable(input.lastPathComponent) }
        try checkFreeSpace(seconds: Double(source.length) / source.fileFormat.sampleRate, in: folder)

        // 1. Decode to 48 kHz mono so every source format reaches the cleanup the same way.
        let decoded = folder.appendingPathComponent("decoded-48k.caf")
        try convert(source, to: decoded, format: decodedFormat) { progress($0 * 0.15) }
        defer { try? fm.removeItem(at: decoded) }

        // 2. The untouched original at 16 kHz, kept for retries.
        let original = folder.appendingPathComponent("original-16k.wav")
        try convert(try AVAudioFile(forReading: decoded), to: original, format: speechFormat) { progress(0.15 + $0 * 0.1) }

        let total = try AVAudioFile(forReading: decoded).length
        let duration = Double(total) / workRate
        if mode == .none {
            progress(1)
            return PreparedAudio(original: original, speech: original, cleanedM4A: nil, duration: duration, cleanupLabel: CleanupMode.none.shortLabel)
        }

        // 3. Noise cleanup.
        let speech = folder.appendingPathComponent("speech-16k.wav")
        let cleaned = keepCleanedAudio ? folder.appendingPathComponent("cleaned.m4a") : nil
        var used = mode
        var note = ""
        if let model = mode.neuralModel {
            do {
                try await neural(model, decoded: decoded, total: Int(total), folder: folder, speech: speech, cleaned: cleaned) { progress(0.25 + $0 * 0.72) }
            } catch AudioPreparationError.modelUnavailable(let reason) {
                // Should never happen (the models are part of the app), but never lose a lecture over it.
                used = voiceIsolationAvailable ? .voiceIsolation : .lowCut
                note = " (\(mode.shortLabel) could not start: \(reason))"
            }
        }
        if used.neuralModel == nil {
            let isolation = used == .voiceIsolation && voiceIsolationAvailable
            if used == .voiceIsolation && !isolation {
                used = .lowCut
                note += " (Apple Voice Isolation is not available on this device)"
            }
            try render(decoded: decoded, isolation: isolation, speech: speech, cleaned: cleaned) { progress(0.25 + $0 * 0.72) }
        }

        // 4. Safety net: if cleanup removed the voice itself (its loudest moments fell far), transcribe the
        //    original instead, with only the rumble filter.
        let before = try levelSummary(original), after = try levelSummary(speech)
        if after.loud < before.loud - 20 || after.loud < -65 {
            if used != .lowCut, (try? render(decoded: decoded, isolation: false, speech: speech, cleaned: cleaned, progress: { _ in })) != nil {
                progress(1)
                return PreparedAudio(original: original, speech: speech, cleanedM4A: cleaned, duration: duration,
                                     cleanupLabel: "Rumble filter only (\(used.shortLabel.replacingOccurrences(of: " + rumble filter", with: "")) took away too much of the voice, so it was not used)")
            }
            try? fm.removeItem(at: speech)
            progress(1)
            return PreparedAudio(original: original, speech: original, cleanedM4A: cleaned, duration: duration,
                                 cleanupLabel: "None (cleanup removed too much of the voice, so the original audio was used)")
        }
        progress(1)
        // Report what the cleanup did, measured on the background noise between words.
        let reduction = before.floor - after.floor
        let effect = reduction >= 1 ? "background noise \(Int(reduction.rounded())) dB lower" : "no measurable background noise to remove"
        return PreparedAudio(original: original, speech: speech, cleanedM4A: cleaned, duration: duration,
                             cleanupLabel: "\(used.shortLabel) (\(effect))\(note)")
    }

    /// Temporary audio needs about 260 kB per second of recording (≈ 1.4 GB for 90 minutes).
    static func checkFreeSpace(seconds: Double, in folder: URL) throws {
        let needed = Int64(seconds * 260_000) + 200_000_000
        let values = try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        if let available = values?.volumeAvailableCapacityForImportantUsage, available > 0, available < needed {
            let gb = { (bytes: Int64) in String(format: "%.1f GB", Double(bytes) / 1e9) }
            throw AudioPreparationError.failed("not enough free space. This recording needs about \(gb(needed)) while it is processed; \(gb(available)) is free.")
        }
    }

    /// Neural noise removal on all cores, then the rumble filter, the kept audio and 16 kHz speech.
    private static func neural(_ model: NeuralModel, decoded: URL, total: Int, folder: URL, speech: URL, cleaned: URL?,
                               progress: @escaping @Sendable (Double) -> Void) async throws {
        let raw = folder.appendingPathComponent("cleaned-48k.raw")
        defer { try? FileManager.default.removeItem(at: raw) }
        try await NeuralCleanup.run(input: decoded, output: raw, options: NeuralCleanup.Options(model: model)) { progress($0 * 0.85) }
        try finish(raw: raw, total: total, speech: speech, cleaned: cleaned) { progress(0.85 + $0 * 0.15) }
    }

    /// Reads the cleaned 16-bit audio, filters rumble, and writes the kept audio and 16 kHz speech.
    private static func finish(raw: URL, total: Int, speech: URL, cleaned: URL?, progress: (Double) -> Void) throws {
        let fm = FileManager.default
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: workRate, channels: 1, interleaved: false)!
        let handle = try FileHandle(forReadingFrom: raw)
        defer { try? handle.close() }
        try? fm.removeItem(at: speech)
        let speechFile = try AVAudioFile(forWriting: speech, settings: speechFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        guard let toSpeech = AVAudioConverter(from: format, to: speechFile.processingFormat) else { throw AudioPreparationError.failed("no converter") }
        var cleanedFile: AVAudioFile?
        if let cleaned {
            try? fm.removeItem(at: cleaned)
            cleanedFile = try AVAudioFile(forWriting: cleaned, settings: cleanedAudioSettings, commonFormat: .pcmFormatFloat32, interleaved: false)
        }
        var filter = HighPass(cutoff: 80, sampleRate: workRate)
        let chunk = 48_000
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(chunk)),
              let out = buffer.floatChannelData?[0] else { throw AudioPreparationError.failed("no memory") }
        var ints = [Int16](repeating: 0, count: chunk)
        var done = 0
        while done < total {
            try Task.checkCancellation()
            CPUBudget.shared.throttle()
            let count = min(chunk, total - done)
            guard let data = try handle.read(upToCount: count * 2), data.count == count * 2 else {
                throw AudioPreparationError.failed("the cleaned audio is incomplete")
            }
            _ = ints.withUnsafeMutableBufferPointer { data.copyBytes(to: $0) }
            for i in 0..<count { out[i] = Float(Int16(littleEndian: ints[i])) / 32_768 }
            filter.apply(out, count: count)
            buffer.frameLength = AVAudioFrameCount(count)
            try cleanedFile?.write(from: buffer)
            try appendConverted(buffer, with: toSpeech, to: speechFile)
            done += count
            progress(Double(done) / Double(total))
        }
        try flush(toSpeech, to: speechFile)
    }

    /// Plays the decoded audio through a rumble filter (and Voice Isolation) in offline mode.
    /// Effect latency is compensated, so timestamps and the end of the lecture stay exact.
    private static func render(decoded: URL, isolation: Bool, speech: URL, cleaned: URL?, progress: (Double) -> Void) throws {
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
        var latency = lowCut.auAudioUnit.latency
        if isolation {
            let effect = AVAudioUnitEffect(audioComponentDescription: voiceIsolationDescription)
            engine.attach(effect)
            engine.connect(lowCut, to: effect, format: format)
            engine.connect(effect, to: engine.mainMixerNode, format: format)
            latency += effect.auAudioUnit.latency
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
            cleanedFile = try AVAudioFile(forWriting: cleaned, settings: cleanedAudioSettings, commonFormat: .pcmFormatFloat32, interleaved: false)
        }
        let latencyFrames = AVAudioFramePosition(max(0, latency) * format.sampleRate)
        let end = total + latencyFrames
        var skip = latencyFrames
        let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: engine.manualRenderingMaximumFrameCount)!
        var stalls = 0
        var rounds = 0
        while engine.manualRenderingSampleTime < end {
            try Task.checkCancellation()
            rounds += 1
            if rounds % 12 == 0 { CPUBudget.shared.throttle() }
            let remaining = AVAudioFrameCount(end - engine.manualRenderingSampleTime)
            let status = try engine.renderOffline(min(buffer.frameCapacity, remaining), to: buffer)
            switch status {
            case .success:
                stalls = 0
                var output = buffer
                if skip > 0 {
                    // Drop the effects' start-up delay so audio stays aligned with the original.
                    if AVAudioFramePosition(buffer.frameLength) <= skip { skip -= AVAudioFramePosition(buffer.frameLength); continue }
                    output = dropFirst(Int(skip), of: buffer)
                    skip = 0
                }
                try cleanedFile?.write(from: output)
                try appendConverted(output, with: toSpeech, to: speechFile)
                progress(min(1, Double(engine.manualRenderingSampleTime) / Double(end)))
            case .insufficientDataFromInputNode, .cannotDoInCurrentContext:
                stalls += 1
                if stalls > 10_000 { throw AudioPreparationError.failed("the audio engine stalled") }
            case .error: throw AudioPreparationError.failed("the audio engine stopped")
            @unknown default: throw AudioPreparationError.failed("unknown render status")
            }
        }
        try flush(toSpeech, to: speechFile)
    }

    private static func dropFirst(_ frames: Int, of buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        let count = Int(buffer.frameLength) - frames
        let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: AVAudioFrameCount(max(count, 1)))!
        out.frameLength = AVAudioFrameCount(max(count, 0))
        for channel in 0..<Int(buffer.format.channelCount) {
            if let from = buffer.floatChannelData?[channel], let to = out.floatChannelData?[channel], count > 0 {
                to.update(from: from + frames, count: count)
            }
        }
        return out
    }

    /// Writes what the resampler still holds (its last few milliseconds).
    private static func flush(_ converter: AVAudioConverter, to file: AVAudioFile) throws {
        while true {
            let out = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096)!
            let status = converter.convert(to: out, error: nil) { _, inputStatus in
                inputStatus.pointee = .endOfStream
                return nil
            }
            if out.frameLength > 0 { try file.write(from: out) }
            if status != .haveData || out.frameLength == 0 { break }
        }
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
        var rounds = 0
        while !finished {
            try Task.checkCancellation()
            rounds += 1
            if rounds % 4 == 0 { CPUBudget.shared.throttle() }
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

    /// Loudness of the loudest tenth of the recording (the voice at its strongest) and its noise floor
    /// (10th percentile), in speech-band dBFS. The loudest tenth is speech in any lecture, so good noise
    /// removal leaves it nearly unchanged; the louder half would also hold the noise between sentences
    /// and could fall by 20 dB when that noise is removed well.
    static func levelSummary(_ url: URL) throws -> (loud: Double, floor: Double) {
        let (levels, _) = try SpeechDetector.levels(of: url)
        guard !levels.isEmpty else { return (-120, -120) }
        let sorted = levels.sorted()
        let loud = sorted.suffix(max(1, sorted.count / 10))
        return (loud.reduce(0, +) / Double(loud.count), sorted[Int(Double(sorted.count - 1) * 0.1)])
    }
}
