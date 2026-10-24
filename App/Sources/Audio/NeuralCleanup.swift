import AVFoundation
import Darwin
import Foundation
import NoiseModels

/// The neural noise-removal models built into the app.
enum NeuralModel: String, Codable, Sendable {
    case deepFilter, rnnoise

    var title: String {
        switch self {
        case .deepFilter: "DeepFilterNet 3"
        case .rnnoise: "RNNoise"
        }
    }
}

/// Runs a neural noise-removal model over a whole recording, on several CPU cores at once.
///
/// Both models are recurrent: every 10 ms frame depends on the frames before it. So the recording is
/// cut into one segment per core. Each segment starts reading a few seconds early, so the model has
/// settled by the time the segment's own audio begins, and the model's delay is removed, so the cleaned
/// audio lines up sample for sample with the original. Each result is written straight to its place in
/// a 16-bit file. The first segment is identical to a single pass; the others differ from it by less
/// than −35 dB (measured on noisy speech while this was built).
enum NeuralCleanup {
    static let sampleRate = 48_000.0

    struct Options: Sendable {
        var model: NeuralModel
        /// DeepFilterNet only: the most that noise is turned down, in dB. Keeping a trace of the
        /// background avoids the artifacts of total removal, which speech recognition doesn't like.
        var attenuationLimit: Float = 30
        var workers = NeuralCleanup.defaultWorkers
        var minSegmentSeconds = 30.0
        var warmUpSeconds = 5.0

        init(model: NeuralModel) { self.model = model }
    }

    /// All cores but two (the interface and speech recognition keep running), at most four. One in
    /// the background, where the CPU budget is the limit anyway (see `CPUBudget`).
    static var defaultWorkers: Int {
        if CPUBudget.shared.isLimited { return 1 }
        if ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue { return 1 }
        return max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2))
    }

    /// One part of the recording.
    struct Segment: Equatable, Sendable {
        var start: Int       // first sample this segment writes
        var end: Int         // one past the last sample it writes
        var readStart: Int   // where it starts reading (earlier, to warm up the model)
    }

    /// Frame length and delay of a model, in samples at 48 kHz (for tests and diagnostics).
    static func frameInfo(_ model: NeuralModel) throws -> (frame: Int, delay: Int) {
        let denoiser = try makeDenoiser(model, attenuationLimit: 100)
        return (denoiser.frameLength, denoiser.delay)
    }

    private static func makeDenoiser(_ model: NeuralModel, attenuationLimit: Float) throws -> FrameDenoiser {
        do {
            switch model {
            case .deepFilter: return try DeepFilterDenoiser(attenuationLimit: attenuationLimit)
            case .rnnoise: return try RNNoiseDenoiser()
            }
        } catch {
            throw AudioPreparationError.modelUnavailable("\(model.title): \(error.localizedDescription)")
        }
    }

    /// Splits `total` samples into segments on whole frames.
    static func plan(total: Int, options: Options, frame: Int = 480) -> [Segment] {
        let minimum = max(frame, Int(options.minSegmentSeconds * sampleRate))
        let count = max(1, min(options.workers, total / minimum))
        let warmUp = Int(options.warmUpSeconds * sampleRate) / frame * frame
        return (0..<count).map { i in
            let start = i == 0 ? 0 : (total * i / count) / frame * frame
            let end = i == count - 1 ? total : (total * (i + 1) / count) / frame * frame
            return Segment(start: start, end: end, readStart: max(0, start - warmUp))
        }
    }

    /// Cleans `input` (a 48 kHz mono file) into `output`: raw 16-bit little-endian samples at 48 kHz,
    /// exactly as many as the input has.
    static func run(input: URL, output: URL, options: Options, progress: @escaping @Sendable (Double) -> Void) async throws {
        let total = Int(try AVAudioFile(forReading: input).length)
        guard total > 0 else { throw AudioPreparationError.failed("the recording is empty") }
        let probe = try makeDenoiser(options.model, attenuationLimit: options.attenuationLimit)
        let segments = plan(total: total, options: options, frame: probe.frameLength)
        // One model per segment, created here one after another.
        var models = [probe]
        while models.count < segments.count { models.append(try makeDenoiser(options.model, attenuationLimit: options.attenuationLimit)) }
        let denoisers = models

        try? FileManager.default.removeItem(at: output)
        let fd = open(output.path, O_RDWR | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw AudioPreparationError.failed("could not create the cleaned audio file") }
        defer { close(fd) }
        guard ftruncate(fd, off_t(total * 2)) == 0 else {
            throw AudioPreparationError.failed("not enough free space for the cleaned audio")
        }

        let flag = CancelFlag()
        let work = segments.reduce(0) { $0 + ($1.end + probe.delay - $1.readStart) }
        let counter = ProgressCounter(total: work, report: progress)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    let failure = ErrorBox()
                    DispatchQueue.concurrentPerform(iterations: segments.count) { index in
                        do {
                            try clean(segments[index], with: denoisers[index], input: input, total: total, fd: fd, flag: flag, counter: counter)
                        } catch {
                            failure.set(error)
                            flag.cancel()
                        }
                    }
                    if let error = failure.error {
                        continuation.resume(throwing: error)
                    } else if flag.isCancelled {
                        continuation.resume(throwing: CancellationError())
                    } else {
                        continuation.resume()
                    }
                }
            }
        } onCancel: {
            flag.cancel()
        }
    }

    /// Feeds the model from `readStart` to `end` plus its delay and keeps the output for `start..<end`.
    private static func clean(_ segment: Segment, with denoiser: FrameDenoiser, input: URL, total: Int, fd: Int32,
                              flag: CancelFlag, counter: ProgressCounter) throws {
        let file = try AVAudioFile(forReading: input, commonFormat: .pcmFormatFloat32, interleaved: false)
        let frame = denoiser.frameLength, delay = denoiser.delay
        let chunk = frame * 50   // 0.5 s
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(chunk)),
              let samples = buffer.floatChannelData?[0] else {
            throw AudioPreparationError.failed("no memory for noise removal")
        }
        let frameIn = UnsafeMutablePointer<Float>.allocate(capacity: frame)
        let frameOut = UnsafeMutablePointer<Float>.allocate(capacity: frame)
        defer { frameIn.deallocate(); frameOut.deallocate() }

        var pending: [Int16] = []
        pending.reserveCapacity(chunk * 2)
        var pendingStart = segment.start
        func flush() throws {
            guard !pending.isEmpty else { return }
            try pending.withUnsafeBytes { bytes in
                var written = 0
                while written < bytes.count {
                    let n = pwrite(fd, bytes.baseAddress! + written, bytes.count - written, off_t(pendingStart * 2 + written))
                    if n <= 0 { throw AudioPreparationError.failed("could not write the cleaned audio (\(String(cString: strerror(errno))))") }
                    written += n
                }
            }
            pendingStart += pending.count
            pending.removeAll(keepingCapacity: true)
        }

        file.framePosition = AVAudioFramePosition(segment.readStart)
        var fed = segment.readStart            // index of the next input sample given to the model
        let stop = segment.end + delay
        while fed < stop {
            if flag.isCancelled { return }
            CPUBudget.shared.throttle(cancelled: { flag.isCancelled })
            var available = 0
            let position = Int(file.framePosition)
            if position < total {
                try file.read(into: buffer, frameCount: AVAudioFrameCount(min(chunk, total - position)))
                available = Int(buffer.frameLength)
            }
            var offset = 0
            let before = fed
            while offset < chunk && fed < stop {
                let real = max(0, min(frame, available - offset))
                if real > 0 { frameIn.update(from: samples + offset, count: real) }
                if real < frame { (frameIn + real).update(repeating: 0, count: frame - real) }
                denoiser.process(frameIn, frameOut)
                // Output sample k belongs to input sample fed + k − delay; keep those in start..<end.
                let first = max(0, segment.start - (fed - delay))
                let last = min(frame, segment.end - (fed - delay))
                if first < last {
                    for k in first..<last { pending.append(int16(frameOut[k])) }
                }
                fed += frame
                offset += frame
            }
            if pending.count >= chunk { try flush() }
            counter.add(fed - before)
        }
        try flush()
        guard pendingStart == segment.end else {
            throw AudioPreparationError.failed("noise removal stopped early (\(pendingStart) of \(segment.end) samples)")
        }
    }

    static func int16(_ value: Float) -> Int16 {
        let scaled = value * 32_768
        if !(scaled > -32_768) { return Int16.min }
        if !(scaled < 32_767) { return Int16.max }
        return Int16(scaled.rounded())
    }
}

/// A cancel switch shared by worker threads.
final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }
}

/// Keeps the first error thrown by any worker thread.
final class ErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var first: Error?

    var error: Error? {
        lock.lock()
        defer { lock.unlock() }
        return first
    }

    func set(_ error: Error) {
        lock.lock()
        if first == nil { first = error }
        lock.unlock()
    }
}

/// Adds up the work done by several threads and reports it at most every 1 %.
final class ProgressCounter: @unchecked Sendable {
    private let lock = NSLock()
    private let total: Int
    private let report: @Sendable (Double) -> Void
    private var done = 0
    private var reported = -1.0

    init(total: Int, report: @escaping @Sendable (Double) -> Void) {
        self.total = max(1, total)
        self.report = report
    }

    func add(_ amount: Int) {
        lock.lock()
        done += amount
        let fraction = min(1, Double(done) / Double(total))
        let send = fraction - reported >= 0.01 || (fraction >= 1 && reported < 1)
        if send { reported = fraction }
        lock.unlock()
        if send { report(fraction) }
    }
}
