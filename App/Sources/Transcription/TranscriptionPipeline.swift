import Foundation

/// Turns prepared lecture audio into a checked transcript:
///
/// 1. Finds speech and pauses (adaptive threshold) and plans ≤ 28-second pieces of speech only, so
///    silence is never sent to Whisper (it invents text on silence).
/// 2. Transcribes the pieces independently, several at a time. No decoded text is fed into the next
///    piece, which is what let one repeated sentence take over a whole lecture in the old Windows app.
/// 3. Audits the transcript in ~5-minute parts (`TranscriptQuality`). Failing parts are re-transcribed
///    with other settings: original (un-cleaned) audio, shorter pieces, a fixed language, sampling.
///    The best version of each part is kept.
/// 4. Parts that still fail are replaced by a visible ⚠ marker. Nothing is guessed.
///
/// Progress is saved after every batch (`checkpoint`), so a lecture continues where it stopped if
/// the app is closed.
struct TranscriptionPipeline {
    struct Options: Sendable {
        var language: String?            // nil = auto per piece
        var vocabulary = ""
        var batchSize = 8                // pieces per engine call (progress and checkpoint granularity)
        var partSeconds = 300.0          // quality-check part length
        var maxAttemptsPerPart = 4
        var retryBudgetShare = 1.0       // re-process at most this share of the lecture
        var quality = TranscriptQuality.Config()
        /// Model, language and vocabulary: a saved checkpoint made with other settings is discarded.
        var checkpointKey = ""
    }

    typealias Stage = @Sendable (String, Double) -> Void

    let engine: SpeechEngine
    var options: Options
    var device = "iPad"

    struct Checkpoint: Codable {
        var key: String?
        var chunks: [TimeRange]
        var results: [Int: PieceResult]
    }

    func run(audio: PreparedAudio, checkpoint: URL?, stage: Stage) async throws -> LectureTranscript {
        stage("Finding speech and pauses", 0)
        let analysis = try SpeechDetector.analyze(audio.speech)
        let duration = max(audio.duration, analysis.duration)
        let chunks = SpeechDetector.chunks(speech: analysis.keep, levels: analysis.levels, duration: duration)
        let parts = TranscriptQuality.pieces(duration: duration, cuts: SpeechDetector.cuts(duration: duration, silences: analysis.silences, target: options.partSeconds))

        // First pass, resuming from the checkpoint when the plan is unchanged.
        var saved = checkpoint.flatMap { try? JSONDecoder().decode(Checkpoint.self, from: Data(contentsOf: $0)) }
        if saved?.chunks != chunks || saved?.key != options.checkpointKey { saved = Checkpoint(key: options.checkpointKey, chunks: chunks, results: [:]) }
        var results = saved!.results
        let settings = DecodeSettings(language: options.language, temperature: 0, vocabulary: options.vocabulary)
        let todo = chunks.indices.filter { results[$0] == nil }
        var index = 0
        while index < todo.count {
            try Task.checkCancellation()
            let batch = Array(todo[index..<min(index + options.batchSize, todo.count)])
            let doneSoFar = chunks.count - todo.count + index
            stage("Transcribing \(percent(doneSoFar, chunks.count))", 0.02 + 0.78 * Double(doneSoFar) / Double(max(1, chunks.count)))
            try await CPUBudget.shared.pause()   // in the background, wait while the CPU budget is used up
            let samples = try batch.map { try AudioSamples.read(audio.speech, range: chunks[$0]) }
            let out = try await engine.transcribe(samples, settings: settings)
            for (n, chunkIndex) in batch.enumerated() where n < out.count { results[chunkIndex] = out[n] }
            if let checkpoint {
                try? JSONEncoder().encode(Checkpoint(key: options.checkpointKey, chunks: chunks, results: results)).write(to: checkpoint, options: .atomic)
            }
            index += batch.count
        }
        var artifacts = 0
        var segments = Self.place(chunks.indices.compactMap { i in results[i].map { (chunks[i], $0) } }, artifacts: &artifacts)
        let languages = Self.languageShares(chunks.indices.compactMap { i in results[i].map { (chunks[i], $0.language) } })

        // Quality check and recovery.
        stage("Checking quality", 0.8)
        let report = TranscriptQuality.audit(segments, duration: duration, pieces: parts, speech: analysis.speech, config: options.quality)
        var repairs: [QualityInfo.Part] = [], unresolved: [QualityInfo.Part] = []
        var attempts = 0
        if !report.ok {
            let failing = report.pieces.filter { !$0.ok }
            var spent = 0.0
            let budget = duration * options.retryBudgetShare
            let dominant = languages.max(by: { $0.value < $1.value })?.key
            for (n, part) in failing.enumerated() {
                try Task.checkCancellation()
                let piece = part.piece
                let partSpeech = analysis.speech.filter { $0.end > piece.start && $0.start < piece.end }
                let partKeep = analysis.keep.filter { $0.end > piece.start && $0.start < piece.end }
                func check(_ list: [SpeechSegment]) -> TranscriptQuality.Report {
                    TranscriptQuality.audit(list, duration: piece.end, pieces: [piece], speech: partSpeech, config: options.quality)
                }
                let current = segments.filter { $0.start >= piece.start && $0.start < piece.end }
                var best = (name: "first pass", segments: current, report: check(current), artifacts: 0)
                var bestScore = TranscriptQuality.score(best.report)
                var strategies: [(name: String, source: URL, maxSeconds: Double, settings: DecodeSettings)] = []
                if audio.original != audio.speech { strategies.append(("original audio", audio.original, 28, settings)) }
                strategies.append(("shorter pieces", audio.speech, 12, settings))
                var fixed = settings
                fixed.language = options.language == nil ? (dominant ?? "ar") : nil
                strategies.append((options.language == nil ? "fixed language" : "automatic language", audio.speech, 28, fixed))
                var sampled = settings
                sampled.temperature = 0.4
                strategies.append(("sampling", audio.original, 20, sampled))

                var tries = 0
                for strategy in strategies {
                    if tries >= options.maxAttemptsPerPart || spent + piece.range.length > budget { break }
                    tries += 1; attempts += 1
                    spent += piece.range.length
                    stage("Checking quality · re-transcribing part \(n + 1) of \(failing.count) (\(strategy.name))", 0.8 + 0.18 * Double(n) / Double(failing.count))
                    let ranges = SpeechDetector.chunks(speech: partKeep.map { TimeRange(start: max($0.start, piece.start), end: min($0.end, piece.end)) },
                                                       levels: analysis.levels, duration: piece.end, maxSeconds: strategy.maxSeconds)
                        .filter { $0.start >= piece.start }
                    try await CPUBudget.shared.pause()
                    let samples = try ranges.map { try AudioSamples.read(strategy.source, range: $0) }
                    let out = try await engine.transcribe(samples, settings: strategy.settings)
                    var removed = 0
                    let candidate = Self.place(Array(zip(ranges, out)), artifacts: &removed)
                    let audit = check(candidate)
                    let score = TranscriptQuality.score(audit)
                    if score > bestScore || (audit.ok && !best.report.ok) {
                        best = (strategy.name, candidate, audit, removed)
                        bestScore = score
                    }
                    if audit.ok { break }
                }
                segments = segments.filter { !($0.start >= piece.start && $0.start < piece.end) } + best.segments
                segments.sort { $0.start != $1.start ? $0.start < $1.start : $0.end < $1.end }
                if best.name != "first pass" { artifacts += best.artifacts }
                if best.report.ok {
                    if best.name != "first pass" { repairs.append(.init(start: piece.start, end: piece.end, detail: best.name)) }
                } else {
                    let reasons = best.report.kinds.joined(separator: ", ")
                    unresolved.append(.init(start: piece.start, end: piece.end, detail: reasons))
                    // Keep everything outside the bad ranges; replace the bad ranges with a visible marker.
                    for bad in Self.mergeRanges(best.report.findings.map { TimeRange(start: max(piece.start, $0.start), end: min(piece.end, max($0.end, $0.start + 1))) }) {
                        segments = segments.filter { $0.marker || $0.end <= bad.start || $0.start >= bad.end }
                        segments.append(SpeechSegment(start: bad.start, end: bad.end, text: "Not reliably transcribed (\(LectureMarkdown.timestamp(bad.start))–\(LectureMarkdown.timestamp(bad.end))). Check the audio. Reason: \(reasons).", marker: true))
                    }
                    segments.sort { $0.start != $1.start ? $0.start < $1.start : $0.end < $1.end }
                }
            }
        }
        stage("Quality check complete", 1)
        let status: QualityInfo.Status = !unresolved.isEmpty ? .needsReview : (!repairs.isEmpty ? .repaired : .ok)
        return LectureTranscript(segments: segments, model: await engine.label, device: device, duration: duration,
                                 speechSeconds: analysis.speechSeconds, languages: languages,
                                 quality: QualityInfo(status: status, repairs: repairs, unresolved: unresolved, artifactsRemoved: artifacts, attempts: attempts))
    }

    private func percent(_ done: Int, _ total: Int) -> String { "\(Int(Double(done) / Double(max(total, 1)) * 100))%" }

    /// Moves piece-relative segments to lecture time, drops known Whisper artifacts and empty text,
    /// keeps times inside their piece, orders them, and merges only exact duplicates.
    static func place(_ pieces: [(TimeRange, PieceResult)], artifacts: inout Int) -> [SpeechSegment] {
        var out: [SpeechSegment] = []
        for (range, result) in pieces {
            for s in result.segments {
                let text = TranscriptText.collapse(s.text)
                if text.isEmpty { continue }
                if TranscriptQuality.isKnownArtifact(text) { artifacts += 1; continue }
                let start = min(range.end, range.start + max(0, s.start))
                let end = min(range.end, max(start, range.start + s.end))
                out.append(SpeechSegment(start: start, end: end, text: text, language: result.language))
            }
        }
        out.sort { $0.start != $1.start ? $0.start < $1.start : $0.end < $1.end }
        var merged: [SpeechSegment] = []
        for s in out {
            if let last = merged.last, abs(last.start - s.start) < 0.05, abs(last.end - s.end) < 0.05,
               TranscriptQuality.normalize(last.text) == TranscriptQuality.normalize(s.text) { continue }
            merged.append(s)
        }
        return merged
    }

    static func languageShares(_ items: [(TimeRange, String?)]) -> [String: Double] {
        var seconds: [String: Double] = [:]
        for (range, language) in items { if let language, !language.isEmpty { seconds[language, default: 0] += range.length } }
        let total = seconds.values.reduce(0, +)
        guard total > 0 else { return [:] }
        return seconds.mapValues { ($0 / total * 100).rounded() / 100 }
    }

    static func mergeRanges(_ list: [TimeRange]) -> [TimeRange] {
        var out: [TimeRange] = []
        for x in list.sorted(by: { $0.start < $1.start }) {
            if let last = out.last, x.start <= last.end + 5 { out[out.count - 1].end = max(last.end, x.end) } else { out.append(x) }
        }
        return out
    }
}
