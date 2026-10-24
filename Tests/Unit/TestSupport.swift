import AVFoundation
import XCTest
@testable import Mentality

enum TestAudio {
    static func folder(_ name: String = UUID().uuidString) -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("mentality-tests/\(name)", isDirectory: true)
        try? FileManager.default.removeItem(at: url)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Writes a 16 kHz mono WAV: `pattern` alternates (seconds of tone, seconds of silence).
    @discardableResult
    static func writeSpeechLike(_ url: URL, pattern: [(Double, Double)], amplitude: Float, rate: Double = 16_000, noise: Float = 0) throws -> Double {
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
        let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        var total = 0.0
        var seed: UInt32 = 12345
        func random() -> Float { seed = seed &* 1_103_515_245 &+ 12345; return Float(seed % 2000) / 1000 - 1 }
        for (tone, silence) in pattern {
            for (seconds, voiced) in [(tone, true), (silence, false)] where seconds > 0 {
                let frames = AVAudioFrameCount(seconds * rate)
                let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)!
                buffer.frameLength = frames
                let data = buffer.floatChannelData![0]
                for i in 0..<Int(frames) {
                    let t = Double(i) / rate
                    // A "voice": a few harmonics with a slow syllable-like envelope.
                    let envelope = Float(0.6 + 0.4 * sin(2 * .pi * 3 * t))
                    let tone = Float(sin(2 * .pi * 180 * t) + 0.5 * sin(2 * .pi * 360 * t) + 0.25 * sin(2 * .pi * 720 * t)) / 1.75
                    data[i] = (voiced ? amplitude * envelope * tone : 0) + noise * random()
                }
                try file.write(from: buffer)
                total += seconds
            }
        }
        return total
    }

    static func repeating(_ tone: Double, _ silence: Double, count: Int) -> [(Double, Double)] { Array(repeating: (tone, silence), count: count) }

    /// Writes samples as a 16-bit mono WAV file.
    static func write(_ samples: [Float], rate: Double, to url: URL) throws {
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
        let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(samples.count)))
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        try file.write(from: buffer)
    }

    /// Changes the sample rate by linear interpolation (good enough for test recordings).
    static func resample(_ samples: [Float], from source: Double, to target: Double) -> [Float] {
        guard !samples.isEmpty else { return [] }
        let count = Int(Double(samples.count) * target / source)
        return (0..<count).map { i in
            let position = Double(i) * source / target
            let index = min(Int(position), samples.count - 1), next = min(index + 1, samples.count - 1)
            let fraction = Float(position - Double(index))
            return samples[index] + (samples[next] - samples[index]) * fraction
        }
    }

    static func fixture(_ name: String, _ ext: String) throws -> URL {
        try XCTUnwrap(Bundle(for: BundleToken.self).url(forResource: name, withExtension: ext), "missing fixture \(name).\(ext)")
    }
}

final class BundleToken {}

/// Deterministic, varied "lecture" sentences so the quality check sees natural text.
enum FakeText {
    static let vocabulary = """
    abdomen artery vein nerve fascia ligament tendon muscle oblique transversus rectus sheath inguinal canal femoral
    pelvis lumbar thoracic diaphragm umbilicus peritoneum mesentery liver spleen kidney ureter bladder prostate testis
    ovary uterus aorta celiac trunk superior inferior mesenteric portal hepatic renal adrenal iliac crest spine tubercle
    lateral medial anterior posterior deep superficial layer membrane aponeurosis conjoint falx cremaster spermatic cord
    ring hernia direct indirect triangle boundary floor roof wall content supply drainage lymph node innervation segment
    dermatome reflex clinical sign symptom pain swelling incision surgery approach landmark palpation percussion
    """.split(whereSeparator: { $0.isWhitespace }).map(String.init)

    static func sentence(_ n: Int, words: Int = 9) -> String {
        var state = UInt64(n &* 2_654_435_761 &+ 97)
        var out: [String] = []
        for _ in 0..<words {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            out.append(vocabulary[Int((state >> 33) % UInt64(vocabulary.count))])
        }
        let text = out.joined(separator: " ")
        return String(text.prefix(1)).uppercased() + String(text.dropFirst()) + "."
    }
}

/// A speech engine scripted by the audio it receives: loud pieces "loop", quiet pieces are fine.
final class FakeEngine: SpeechEngine, @unchecked Sendable {
    var loopAbove: Float = 0.3   // the loud test tone peaks at 0.42, the quiet one at 0.21
    var calls = 0
    var piecesSeen = 0
    var failAfterCalls: Int?
    var settingsSeen: [DecodeSettings] = []
    private var counter = 0

    var label: String { get async { "Fake engine" } }

    struct Stop: Error {}

    func transcribe(_ pieces: [[Float]], settings: DecodeSettings) async throws -> [PieceResult] {
        if let limit = failAfterCalls, calls >= limit { throw Stop() }
        calls += 1
        piecesSeen += pieces.count
        settingsSeen.append(settings)
        return pieces.map { samples in
            let peak = samples.map(abs).max() ?? 0
            let seconds = Double(samples.count) / 16_000
            if peak > loopAbove {
                // The failure seen in real lectures: the same sentence over and over.
                let s = "So deep membranous fascia is called fascia of the thigh."
                return PieceResult(segments: stride(from: 0.0, to: max(seconds - 2, 1), by: 3).map { SpeechSegment(start: $0, end: $0 + 2.8, text: s) }, language: "en")
            }
            counter += 1
            return PieceResult(segments: [SpeechSegment(start: 0.3, end: max(0.5, seconds - 0.3), text: FakeText.sentence(counter, words: max(3, Int(seconds * 2))))], language: counter % 3 == 0 ? "en" : "ar")
        }
    }
}
