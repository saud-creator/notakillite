import AVFoundation
import Foundation

/// Finds pauses and speech in a recording, and plans the pieces Whisper transcribes.
///
/// The silence threshold adapts to each recording (its noise floor + 6 dB, kept between −60 and
/// −25 dB). A fixed threshold fails on cleaned, loudness-normalised audio, where pauses sit well above
/// −35 dB. Ported from Notakillite's `silencesFromLevels` / `chooseCuts`.
enum SpeechDetector {
    static let windowSeconds = 0.1

    struct Analysis: Sendable {
        var levels: [Double]          // dBFS per 100 ms
        var duration: Double
        var silences: [TimeRange]
        var threshold: Double
        var speech: [TimeRange]
        /// Everything except long, clearly silent stretches: what is sent to Whisper. Broader than
        /// `speech`, so a quiet lecturer close to the noise floor is never dropped.
        var keep: [TimeRange]
        var speechSeconds: Double { speech.reduce(0) { $0 + $1.length } }
    }

    /// Reads a 16 kHz mono file once and returns its level map, pauses and speech.
    static func analyze(_ url: URL) throws -> Analysis {
        let (levels, duration) = try self.levels(of: url)
        let (silences, threshold) = self.silences(levels)
        let (clearlySilent, _) = self.silences(levels, minSeconds: 3, margin: 3)
        return Analysis(levels: levels, duration: duration, silences: silences, threshold: threshold,
                        speech: speech(from: silences, duration: duration), keep: speech(from: clearlySilent, duration: duration))
    }

    static func level(_ samples: UnsafeBufferPointer<Float>) -> Double {
        guard !samples.isEmpty else { return -120 }
        var sum: Float = 0
        for s in samples { sum += s * s }
        let rms = (sum / Float(samples.count)).squareRoot()
        return max(-120, 20 * log10(Double(rms) + 1e-10))
    }

    /// dBFS of every 100 ms window.
    static func levels(of url: URL) throws -> ([Double], Double) {
        let file = try AVAudioFile(forReading: url)
        let rate = file.processingFormat.sampleRate
        let window = AVAudioFrameCount(rate * windowSeconds)
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: window * 600)!
        var levels: [Double] = []
        levels.reserveCapacity(Int(Double(file.length) / Double(window)) + 1)
        while file.framePosition < file.length {
            try Task.checkCancellation()
            try file.read(into: buffer)
            guard buffer.frameLength > 0, let channel = buffer.floatChannelData?[0] else { break }
            var offset = 0
            let count = Int(buffer.frameLength)
            while offset < count {
                let n = min(Int(window), count - offset)
                levels.append(level(UnsafeBufferPointer(start: channel + offset, count: n)))
                offset += n
            }
        }
        return (levels, Double(file.length) / rate)
    }

    static func levels(of samples: [Float], rate: Double = 16_000) -> [Double] {
        let window = Int(rate * windowSeconds)
        var levels: [Double] = []
        samples.withUnsafeBufferPointer { all in
            var offset = 0
            while offset < all.count {
                let n = min(window, all.count - offset)
                levels.append(level(UnsafeBufferPointer(rebasing: all[offset..<(offset + n)])))
                offset += n
            }
        }
        return levels
    }

    /// Pauses of at least `minSeconds` below an adaptive threshold.
    static func silences(_ levels: [Double], minSeconds: Double = 0.4, margin: Double = 6) -> ([TimeRange], Double) {
        guard !levels.isEmpty else { return ([], -60) }
        let sorted = levels.sorted()
        let floor = sorted[Int(Double(sorted.count - 1) * 0.1)]
        let threshold = min(-25, max(-60, floor + margin))
        var out: [TimeRange] = []
        var start = -1
        for i in 0...levels.count {
            let quiet = i < levels.count && levels[i] < threshold
            if quiet && start < 0 { start = i }
            if !quiet && start >= 0 {
                if Double(i - start) * windowSeconds >= minSeconds - 1e-9 {
                    out.append(TimeRange(start: Double(start) * windowSeconds, end: Double(i) * windowSeconds))
                }
                start = -1
            }
        }
        return (out, threshold)
    }

    static func speech(from silences: [TimeRange], duration: Double) -> [TimeRange] {
        var speech: [TimeRange] = []
        var cursor = 0.0
        for s in silences.sorted(by: { $0.start < $1.start }) {
            if s.start > cursor { speech.append(TimeRange(start: cursor, end: min(s.start, duration))) }
            cursor = max(cursor, s.end)
        }
        if cursor < duration { speech.append(TimeRange(start: cursor, end: duration)) }
        return speech.filter { $0.length > 0.05 }
    }

    /// Cut points in pauses near every `target` seconds (used for ~5-minute quality-check parts).
    static func cuts(duration: Double, silences: [TimeRange], target: Double = 300, window: Double = 60) -> [Double] {
        var cuts: [Double] = [0]
        while duration - cuts.last! > target + window {
            let ideal = cuts.last! + target
            let candidates = silences.map { ($0.start + $0.end) / 2 }.filter { abs($0 - ideal) <= window && $0 > cuts.last! + 30 }
            cuts.append(candidates.min(by: { abs($0 - ideal) < abs($1 - ideal) }) ?? ideal)
        }
        return Array(cuts.dropFirst())
    }

    /// Plans the audio pieces sent to Whisper from `keep` (audio that isn't clearly silent).
    ///
    /// Neighbouring stretches are merged across pauses of up to `shortGap`, and across pauses of up to
    /// `maxGap` when either side is shorter than `targetSeconds`: very short clips make Whisper invent
    /// text ("Thank you."). Longer stretches are split at their quietest moment so no piece is longer
    /// than `maxSeconds`. Pieces are transcribed independently, so a mistake in one never carries over.
    static func chunks(speech keep: [TimeRange], levels: [Double], duration: Double, maxSeconds: Double = 28,
                       targetSeconds: Double = 10, shortGap: Double = 1.5, maxGap: Double = 5,
                       padding: Double = 0.25, minSeconds: Double = 0.6) -> [TimeRange] {
        var chunks: [TimeRange] = []
        var current: TimeRange?
        func flush() {
            guard let c = current else { return }
            for part in split(c, levels: levels, maxSeconds: maxSeconds) where part.length >= minSeconds { chunks.append(part) }
            current = nil
        }
        for interval in keep {
            let padded = TimeRange(start: max(0, interval.start - padding), end: min(duration, interval.end + padding))
            if var c = current, padded.end - c.start <= maxSeconds,
               padded.start - c.end <= shortGap || ((c.length < targetSeconds || padded.length < targetSeconds) && padded.start - c.end <= maxGap) {
                c.end = max(c.end, padded.end)
                current = c
            } else {
                flush()
                current = padded
            }
        }
        flush()
        // Padding can make neighbours overlap slightly; keep them in order without overlap.
        for i in chunks.indices.dropFirst() where chunks[i].start < chunks[i - 1].end {
            chunks[i].start = chunks[i - 1].end
        }
        return chunks.filter { $0.length >= minSeconds }
    }

    /// Splits a range longer than `maxSeconds` at its quietest 100 ms between 40 % and 100 % of
    /// `maxSeconds` (the latest one when several are equally quiet).
    static func split(_ range: TimeRange, levels: [Double], maxSeconds: Double) -> [TimeRange] {
        var parts: [TimeRange] = []
        var cursor = range.start
        while range.end - cursor > maxSeconds {
            let searchFrom = cursor + maxSeconds * 0.4, searchTo = cursor + maxSeconds
            var best = searchTo, quietest = Double.greatestFiniteMagnitude
            var i = Int((searchFrom / windowSeconds).rounded(.up))
            while (Double(i) + 1) * windowSeconds <= searchTo + 1e-9, i < levels.count {
                if i >= 0, levels[i] <= quietest { quietest = levels[i]; best = (Double(i) + 0.5) * windowSeconds }
                i += 1
            }
            best = min(max(best, cursor + 1), searchTo)
            parts.append(TimeRange(start: cursor, end: best))
            cursor = best
        }
        parts.append(TimeRange(start: cursor, end: range.end))
        return parts
    }
}

/// Reads parts of a 16 kHz mono file as Float samples.
enum AudioSamples {
    static func read(_ url: URL, range: TimeRange) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        let rate = file.processingFormat.sampleRate
        let startFrame = AVAudioFramePosition(max(0, range.start) * rate)
        guard startFrame < file.length else { return [] }
        file.framePosition = startFrame
        let frames = AVAudioFrameCount(min(Double(file.length - startFrame), max(0, range.length) * rate))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else { return [] }
        try file.read(into: buffer, frameCount: frames)
        guard let channel = buffer.floatChannelData?[0] else { return [] }
        return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    }
}
