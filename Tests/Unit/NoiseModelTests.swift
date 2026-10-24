import Accelerate
import AVFoundation
import XCTest
@testable import Mentality

/// The neural noise removal built into the app: both models load, the cleaned audio lines up with the
/// original, noise goes down while the voice stays, and the multi-core version matches a single pass.
///
/// The quality tests use real speech and real noise from DeepFilterNet's repository (copied by
/// scripts/build-noise-models.sh); CI points MENTALITY_NOISE_ASSETS at them.
final class NoiseModelTests: XCTestCase {
    func testBothModelsLoadWithTheirFrameAndDelay() throws {
        let dfn = try NeuralCleanup.frameInfo(.deepFilter)
        XCTAssertEqual(dfn.frame, 480)
        XCTAssertEqual(dfn.delay, 1_440)
        let rnn = try NeuralCleanup.frameInfo(.rnnoise)
        XCTAssertEqual(rnn.frame, 480)
        XCTAssertEqual(rnn.delay, 960)
    }

    func testRecordingIsSplitIntoWholeFramesWithWarmUp() {
        var options = NeuralCleanup.Options(model: .deepFilter)
        options.workers = 4
        let total = 48_000 * 600 + 123
        let segments = NeuralCleanup.plan(total: total, options: options)
        XCTAssertEqual(segments.count, 4)
        XCTAssertEqual(segments.first?.start, 0)
        XCTAssertEqual(segments.first?.readStart, 0)
        XCTAssertEqual(segments.last?.end, total)
        for (a, b) in zip(segments, segments.dropFirst()) {
            XCTAssertEqual(a.end, b.start, "no gaps and no overlaps")
            XCTAssertEqual(b.start % 480, 0, "segments start on whole frames")
            XCTAssertEqual(b.readStart, b.start - 240_000, "5 seconds of warm-up")
        }
        options.workers = 8
        XCTAssertEqual(NeuralCleanup.plan(total: 48_000 * 40, options: options).count, 1, "short recordings are not split")
    }

    func testDeepFilterNetRemovesNoiseAndKeepsTheVoice() async throws {
        let (clean, noisy) = try lecture()
        let cleaned = try await denoise(noisy, model: .deepFilter, workers: 1)
        let result = measure(clean: clean, noisy: noisy, cleaned: cleaned)
        print("DeepFilterNet 3: noise in pauses \(String(format: "%.1f", result.noiseDrop)) dB lower, speech level \(String(format: "%+.1f", result.speechChange)) dB")
        XCTAssertGreaterThan(result.noiseDrop, 15, "noise in the pauses should be much lower")
        XCTAssertEqual(result.speechChange, 0, accuracy: 3, "the voice keeps its level")
        XCTAssertEqual(bestLag(reference: clean, signal: cleaned), 0, accuracy: 24, "cleaned audio lines up with the original")
    }

    func testRNNoiseRemovesNoiseAndKeepsTheVoice() async throws {
        let (clean, noisy) = try lecture()
        let cleaned = try await denoise(noisy, model: .rnnoise, workers: 1)
        let result = measure(clean: clean, noisy: noisy, cleaned: cleaned)
        print("RNNoise: noise in pauses \(String(format: "%.1f", result.noiseDrop)) dB lower, speech level \(String(format: "%+.1f", result.speechChange)) dB")
        XCTAssertGreaterThan(result.noiseDrop, 15)
        XCTAssertEqual(result.speechChange, 0, accuracy: 3)
        XCTAssertEqual(bestLag(reference: clean, signal: cleaned), 0, accuracy: 24)
    }

    func testCleaningOnSeveralCoresMatchesOnePass() async throws {
        let (_, noisy) = try lecture()
        var options = NeuralCleanup.Options(model: .deepFilter)
        options.workers = 3
        options.minSegmentSeconds = 15
        let segments = NeuralCleanup.plan(total: noisy.count, options: options)
        XCTAssertEqual(segments.count, 3)

        let started = Date()
        let single = try await denoise(noisy, model: .deepFilter, workers: 1)
        let singleTime = Date().timeIntervalSince(started)
        let parallelStart = Date()
        let parallel = try await denoise(noisy, model: .deepFilter, workers: 3, minSegment: 15)
        let parallelTime = Date().timeIntervalSince(parallelStart)
        print("DeepFilterNet on \(noisy.count / 48_000) s of audio: one core \(String(format: "%.1f", singleTime)) s, three cores \(String(format: "%.1f", parallelTime)) s")

        let firstEnd = segments[1].start
        XCTAssertTrue(single[..<firstEnd] == parallel[..<firstEnd], "the first part is identical to a single pass")
        let difference = vDSP.subtract(single, parallel)
        let below = 10 * log10(Double(vDSP.sumOfSquares(single)) / max(Double(vDSP.sumOfSquares(difference)), 1e-12))
        print("Multi-core result differs from a single pass by \(String(format: "%.1f", below)) dB below the signal")
        XCTAssertGreaterThan(below, 25, "the other parts differ only by a trace")
    }

    // MARK: Helpers

    /// About a minute of lecture: real speech five times with 2-second pauses, real noise under all of
    /// it at 5 dB below the speech.
    private func lecture() throws -> (clean: [Float], noisy: [Float]) {
        guard let folder = ProcessInfo.processInfo.environment["MENTALITY_NOISE_ASSETS"], !folder.isEmpty else {
            throw XCTSkip("Set MENTALITY_NOISE_ASSETS (the CI workflow does) to the folder with DeepFilterNet's test recordings.")
        }
        let base = URL(fileURLWithPath: folder)
        let speech = try Self.read48k(base.appendingPathComponent("clean_freesound_33711.wav"))
        let noise = try Self.read48k(base.appendingPathComponent("noise_freesound_2530.wav"))
        var clean: [Float] = []
        for _ in 0..<5 {
            clean += speech
            clean += [Float](repeating: 0, count: 96_000)
        }
        let speechPower = Double(vDSP.sumOfSquares(speech)) / Double(speech.count)
        let noisePower = Double(vDSP.sumOfSquares(noise)) / Double(noise.count)
        let gain = Float((speechPower / noisePower / pow(10, 0.5)).squareRoot())
        var noisy = clean
        for i in noisy.indices { noisy[i] += gain * noise[i % noise.count] }
        return (clean, noisy)
    }

    private func denoise(_ samples: [Float], model: NeuralModel, workers: Int, minSegment: Double = 30) async throws -> [Float] {
        let folder = TestAudio.folder()
        let input = folder.appendingPathComponent("noisy-48k.wav"), output = folder.appendingPathComponent("cleaned-48k.raw")
        try Self.write48k(samples, to: input)
        var options = NeuralCleanup.Options(model: model)
        options.workers = workers
        options.minSegmentSeconds = minSegment
        try await NeuralCleanup.run(input: input, output: output, options: options) { _ in }
        let data = try Data(contentsOf: output)
        XCTAssertEqual(data.count, samples.count * 2, "one 16-bit sample out for every sample in")
        var ints = [Int16](repeating: 0, count: data.count / 2)
        _ = ints.withUnsafeMutableBytes { data.copyBytes(to: $0) }
        return ints.map { Float(Int16(littleEndian: $0)) / 32_768 }
    }

    /// Noise in the pauses (where the clean speech is silent) and speech level, before and after.
    private func measure(clean: [Float], noisy: [Float], cleaned: [Float]) -> (noiseDrop: Double, speechChange: Double) {
        let window = 4_800
        var noiseIn = 0.0, noiseOut = 0.0, speechIn = 0.0, speechOut = 0.0
        var start = 48_000   // the first second, while the model settles, isn't counted
        while start + window <= clean.count {
            let range = start..<(start + window)
            let level = 10 * log10(Double(vDSP.sumOfSquares(clean[range])) / Double(window) + 1e-12)
            if level < -70 {
                noiseIn += Double(vDSP.sumOfSquares(noisy[range]))
                noiseOut += Double(vDSP.sumOfSquares(cleaned[range]))
            } else if level > -35 {
                speechIn += Double(vDSP.sumOfSquares(clean[range]))
                speechOut += Double(vDSP.sumOfSquares(cleaned[range]))
            }
            start += window
        }
        return (10 * log10(noiseIn / max(noiseOut, 1e-12)), 10 * log10(speechOut / max(speechIn, 1e-12)))
    }

    /// The shift, in samples, at which `signal` matches `reference` best (searched within ±600).
    private func bestLag(reference: [Float], signal: [Float]) -> Double {
        let from = 96_000, length = 144_000
        var best = 0
        var bestValue = -Float.infinity
        reference.withUnsafeBufferPointer { ref in
            signal.withUnsafeBufferPointer { sig in
                for lag in -600...600 {
                    var value: Float = 0
                    vDSP_dotpr(ref.baseAddress! + from, 1, sig.baseAddress! + from + lag, 1, &value, vDSP_Length(length))
                    if value > bestValue {
                        bestValue = value
                        best = lag
                    }
                }
            }
        }
        return Double(best)
    }

    /// Reads a 48 kHz file as mono samples (channels averaged).
    static func read48k(_ url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        XCTAssertEqual(file.processingFormat.sampleRate, 48_000, url.lastPathComponent)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        let channels = Int(file.processingFormat.channelCount), count = Int(buffer.frameLength)
        var mono = [Float](repeating: 0, count: count)
        for channel in 0..<channels {
            let data = buffer.floatChannelData![channel]
            for i in 0..<count { mono[i] += data[i] / Float(channels) }
        }
        return mono
    }

    static func write48k(_ samples: [Float], to url: URL) throws {
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 1, interleaved: true)!
        let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(samples.count)))
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        try file.write(from: buffer)
    }
}

/// The background CPU limiter.
final class CPUBudgetTests: XCTestCase {
    private func busy(_ seconds: Double) {
        let start = Date()
        var x = 0.0
        while Date().timeIntervalSince(start) < seconds { x += sin(x + 1) }
        XCTAssertFalse(x.isNaN)
    }

    func testMeasuresCPUAndOnlyHoldsWorkBackInTheBackground() {
        let budget = CPUBudget(backgroundShare: 0.3, window: 2)
        _ = budget.share()   // starting point
        busy(1.2)
        let used = budget.share()
        XCTAssertGreaterThan(used, 0.6, "a busy thread uses most of one core (measured \(used))")

        XCTAssertFalse(budget.isLimited)
        let foreground = Date()
        budget.throttle()
        XCTAssertLessThan(Date().timeIntervalSince(foreground), 0.1, "in the foreground nothing waits")

        budget.setLimited(true)
        let background = Date()
        budget.throttle()
        let waited = Date().timeIntervalSince(background)
        XCTAssertGreaterThan(waited, 0.5, "in the background, work waits until the average drops under the budget")
        XCTAssertLessThan(waited, 5)
        XCTAssertLessThanOrEqual(budget.share(), 0.35)
        budget.setLimited(false)
        XCTAssertFalse(budget.isLimited)
    }

    /// iPadOS stops a background app that uses more than 80 % of one core over 60 seconds. Fifteen
    /// simulated minutes in the background, with one or two workers doing pieces of work of different
    /// lengths and asking the limiter before each piece, the way the app's workers do (and every 0.2 s
    /// while the budget is used up): no minute may hold more than the budget plus the pieces in
    /// progress, so none comes near the system's limit, and the work keeps moving at about the
    /// budget's pace.
    func testNoMinuteInTheBackgroundComesNearTheSystemLimit() {
        let cases: [[Double]] = [[0.2], [1], [2], [5], [10], [15], [2, 0.1], [5, 0.5], [10, 0.05]]
        for pieces in cases {
            let clock = FakeClock()
            let budget = CPUBudget(backgroundShare: 0.45, window: 10, minute: 60, clock: { [clock] in (clock.time, clock.cpu) })
            budget.setLimited(true)
            let step = 0.05, steps = Int((900 / step).rounded())
            var busyUntil = [Double](repeating: 0, count: pieces.count)
            var nextCheck = [Double](repeating: 0, count: pieces.count)
            var used: [Double] = []   // CPU seconds used in each step
            used.reserveCapacity(steps)
            for k in 0..<steps {
                clock.time = Double(k) * step
                for worker in pieces.indices where busyUntil[worker] <= clock.time + 1e-9 && nextCheck[worker] <= clock.time + 1e-9 {
                    if budget.isOverBudget() {
                        nextCheck[worker] = clock.time + 0.2
                    } else {
                        busyUntil[worker] = clock.time + pieces[worker]
                    }
                }
                let busy = Double(busyUntil.filter { $0 > clock.time + 1e-9 }.count) * step
                used.append(busy)
                clock.cpu += busy
            }
            // The busiest minute, exactly: a sliding sum over 60 seconds.
            let perMinute = Int((60 / step).rounded())
            var sum = used[0..<perMinute].reduce(0, +)
            var busiest = sum
            for i in perMinute..<used.count {
                sum += used[i] - used[i - perMinute]
                busiest = max(busiest, sum)
            }
            let worst = busiest / 60, average = clock.cpu / 900
            let label = "pieces of \(pieces) s"
            print("CPU limiter, \(label): busiest minute \(Int((worst * 100).rounded())) %, average \(Int((average * 100).rounded())) %, reported peak \(Int((budget.backgroundPeak * 100).rounded())) %")
            XCTAssertLessThanOrEqual(worst, 0.45 + pieces.reduce(0, +) / 60 + 0.01, label)
            XCTAssertLessThan(worst, 0.7, "\(label): far from the system's 80 %")
            XCTAssertGreaterThan(average, 0.35, "\(label): the work keeps moving")
            XCTAssertGreaterThanOrEqual(budget.backgroundPeak, worst - 0.01, "\(label): the reported peak is not lower than the real one")
        }
    }
}

/// Time and CPU seconds for the limiter that move only when a test moves them.
private final class FakeClock: @unchecked Sendable {
    var time = 0.0
    var cpu = 0.0
}
