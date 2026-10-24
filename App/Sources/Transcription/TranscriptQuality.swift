import Foundation

/// Transcript quality audit, ported from Notakillite's `companion/transcript-quality.mjs` and checked
/// against the same shared fixture (Tests/Fixtures/quality-cases.json).
///
/// It detects speech-recognition failures (repetition loops, invented text, impossible timing, output
/// that doesn't match the audio) before a transcript is called "Ready". It never edits text; it reports
/// suspicious time ranges so the pipeline can re-transcribe them from the audio.
///
/// Background: on the Windows app, Whisper once repeated one sentence 971 times across a 42-minute
/// lecture and the file was still marked ready. This check exists so that cannot happen silently.
enum TranscriptQuality {
    struct Config: Sendable {
        var compressionRatio = 2.4
        var compressionMinChars = 60
        var compressionMaxChars = 400
        var tinySegmentSeconds = 0.3
        var tinySegmentMinWords = 4
        var maxWordsPerSecond = 6.5
        var rateWindowSeconds = 10.0
        var ngram = 4
        var ngramMaxRepeats = 3
        var repeatMinWords = 5
        var similarity = 0.9
        var repeatWindowSeconds = 120.0
        var repeatMaxInWindow = 3
        var backToBackMax = 2
        var ttrWindowWords = 300
        var minTypeTokenRatio = 0.18
        var dominantShare = 0.15
        var dominantMinWords = 60
        var maxWordsPerMinute = 300.0
        var silenceTextMinWords = 4
        var missingTextSpeechSeconds = 60.0
        var missingTextMaxWords = 10
        var identicalPieceMinWords = 30
    }

    struct Finding: Equatable, Sendable {
        var start: Double
        var end: Double
        var kind: String
        var detail: String
        var count = 1
    }

    struct Piece: Equatable, Sendable {
        var index: Int
        var start: Double
        var end: Double
        var range: TimeRange { TimeRange(start: start, end: end) }
    }

    struct PieceReport: Equatable, Sendable {
        var piece: Piece
        var words: Int
        var speechSeconds: Double
        var ok: Bool
        var reasons: [String]
    }

    struct Report: Sendable {
        var ok: Bool
        var findings: [Finding]
        var pieces: [PieceReport]
        var words: Int
        var distinctWordRatio: Double
        var kinds: [String] { Array(Set(findings.map(\.kind))).sorted() }
    }

    // MARK: Text helpers

    private static func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    private static func isLetter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: return true
        default: return false
        }
    }

    private static func isApostrophe(_ scalar: Unicode.Scalar) -> Bool { scalar == "'" || scalar == "\u{2019}" }

    /// NFKC, lower case, punctuation and marks replaced by spaces, whitespace collapsed.
    static func normalize(_ text: String) -> String {
        let lowered = text.precomposedStringWithCompatibilityMapping.lowercased()
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for scalar in lowered.unicodeScalars {
            if isLetterOrNumber(scalar) || isApostrophe(scalar) {
                if pendingSpace && !out.isEmpty { out.append(" ") }
                pendingSpace = false
                out.append(scalar)
            } else {
                pendingSpace = true
            }
        }
        return String(out)
    }

    /// Words: runs of letters/numbers, optionally joined by an apostrophe followed by letters ("don't").
    static func words(_ text: String) -> [String] {
        let scalars = Array(normalize(text).unicodeScalars)
        var result: [String] = []
        var i = 0
        while i < scalars.count {
            guard isLetterOrNumber(scalars[i]) else { i += 1; continue }
            var j = i
            while j < scalars.count, isLetterOrNumber(scalars[j]) { j += 1 }
            while j + 1 < scalars.count, isApostrophe(scalars[j]), isLetter(scalars[j + 1]) {
                j += 1
                while j < scalars.count, isLetter(scalars[j]) { j += 1 }
            }
            var word = String.UnicodeScalarView()
            word.append(contentsOf: scalars[i..<j])
            result.append(String(word))
            i = j
        }
        return result
    }

    /// Bytes of UTF-8 text divided by their zlib-compressed size (Whisper's repetition measure).
    static func compressionRatio(_ text: String) -> Double {
        let data = Data(text.utf8)
        guard !data.isEmpty else { return 0 }
        // NSData's .zlib is raw DEFLATE; add the 6 header/checksum bytes of a zlib stream.
        guard let compressed = try? (data as NSData).compressed(using: .zlib) else { return 0 }
        return Double(data.count) / Double(compressed.length + 6)
    }

    private static func trigrams(_ text: String) -> Set<UInt64> {
        let units = Array((" " + text + " ").utf16)
        var set = Set<UInt64>()
        guard units.count >= 3 else { return set }
        for i in 0...(units.count - 3) {
            set.insert(UInt64(units[i]) << 32 | UInt64(units[i + 1]) << 16 | UInt64(units[i + 2]))
        }
        return set
    }

    /// Dice similarity of character trigrams (0–1).
    static func similarity(_ a: String, _ b: String) -> Double {
        if a == b { return 1 }
        let x = trigrams(a), y = trigrams(b)
        let shared = x.intersection(y).count
        return 2 * Double(shared) / Double(max(1, x.count + y.count))
    }

    struct Sentence {
        var start: Double
        var end: Double
        var norm: String
        var words: Int
    }

    private static let sentenceEnds: Set<Character> = [".", "?", "!", "؟", "。"]

    /// Splits text after sentence-ending punctuation that is followed by whitespace.
    static func splitSentences(_ text: String) -> [String] {
        var pieces: [String] = []
        var current = ""
        var previous: Character?
        var skippingSpace = false
        for character in text {
            if character.isWhitespace, let p = previous, sentenceEnds.contains(p) || skippingSpace {
                if !skippingSpace { pieces.append(current); current = "" }
                skippingSpace = true
                previous = character
                continue
            }
            skippingSpace = false
            current.append(character)
            previous = character
        }
        pieces.append(current)
        return pieces
    }

    static func sentences(_ segments: [SpeechSegment]) -> [Sentence] {
        var out: [Sentence] = []
        for segment in segments where !segment.marker {
            for piece in splitSentences(segment.text) {
                let norm = normalize(piece)
                if !norm.isEmpty { out.append(Sentence(start: segment.start, end: segment.end, norm: norm, words: norm.split(separator: " ").count)) }
            }
        }
        return out
    }

    // MARK: Known artifacts

    private static let artifactPatterns: [NSRegularExpression] = [
        "^(subtitles|captions|transcription|transcript) (by|from) (the )?amara ?(\\.? ?org)( community)?$",
        "^sous titres réalisés (par|para) la communauté d ?amara ?\\.? ?org$",
        "^untertitel (der|von) amara ?\\.? ?org ?community$",
        "^(please )?(like and )?subscribe( to (my|our|the) channel)?$",
        "^ترجمة نانسي قنقر$",
        "^(اشتركوا|اشترك) في القناة$",
        "^(subtitles|subtitled) by .{0,40}$",
        "^(thanks|thank you) for watching$",
    ].map { try! NSRegularExpression(pattern: $0) }

    /// Text Whisper is known to invent from subtitle training data. Matched only against a whole segment.
    static func isKnownArtifact(_ text: String) -> Bool {
        let norm = normalize(text)
        guard !norm.isEmpty, norm.utf16.count < 80 else { return false }
        let range = NSRange(norm.startIndex..., in: norm)
        return artifactPatterns.contains { $0.firstMatch(in: norm, range: range) != nil }
    }

    // MARK: Pieces

    /// Pieces covering [0, duration], starting at 0 and at each cut.
    static func pieces(duration: Double, cuts: [Double]) -> [Piece] {
        let starts = ([0] + cuts.filter { $0 > 0 && $0 < duration }).sorted()
        return starts.enumerated().map { index, start in
            Piece(index: index, start: start, end: index + 1 < starts.count ? starts[index + 1] : duration)
        }
    }

    // MARK: Audit

    static func audit(_ segments: [SpeechSegment], duration: Double? = nil, pieces givenPieces: [Piece]? = nil,
                      speech: [TimeRange]? = nil, config c: Config = Config()) -> Report {
        var findings: [Finding] = []
        func add(_ start: Double, _ end: Double, _ kind: String, _ detail: String) {
            findings.append(Finding(start: start, end: max(end, start), kind: kind, detail: detail))
        }
        let total = duration ?? segments.last?.end ?? 0
        var pieces = givenPieces ?? []
        if pieces.isEmpty {
            let count = Int(floor(total / 300))
            pieces = self.pieces(duration: total, cuts: count > 0 ? (1...count).map { Double($0) * 300 } : [])
        }
        let spoken = segments.filter { !$0.marker }

        // 1. Per segment
        for segment in spoken {
            let count = words(segment.text).count
            let length = segment.end - segment.start
            if length < c.tinySegmentSeconds && count >= c.tinySegmentMinWords {
                add(segment.start, segment.end, "impossible-timing", "\(count) words in \(String(format: "%.2f", length)) s")
            }
            let text = normalize(segment.text)
            let chars = text.utf16.count
            if chars >= c.compressionMinChars && chars <= c.compressionMaxChars {
                let ratio = compressionRatio(text)
                if ratio > c.compressionRatio { add(segment.start, segment.end, "compressible", "compression ratio \(String(format: "%.2f", ratio))") }
            }
            let tokens = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
            var grams: [String: Int] = [:]
            if tokens.count >= c.ngram {
                for i in 0...(tokens.count - c.ngram) { grams[tokens[i..<(i + c.ngram)].joined(separator: " "), default: 0] += 1 }
            }
            let worst = grams.values.max() ?? 0
            let allowed = c.ngramMaxRepeats * max(1, Int(ceil(Double(tokens.count) / 75)))
            if worst > allowed { add(segment.start, segment.end, "internal-repetition", "a \(c.ngram)-word phrase repeats \(worst)×") }
        }

        // 1b. Speaking rate over 10-second windows; each segment's words spread evenly over its duration.
        struct Counted { var start: Double; var end: Double; var n: Int }
        let counted = spoken.map { Counted(start: $0.start, end: max($0.end, $0.start + 0.05), n: words($0.text).count) }
        var first = 0
        for i in counted.indices {
            let window = TimeRange(start: counted[i].start, end: counted[i].start + c.rateWindowSeconds)
            while first < i && counted[first].end <= window.start { first += 1 }
            var sum = 0.0
            var last = i
            var j = first
            while j < counted.count && counted[j].start < window.end {
                let item = TimeRange(start: counted[j].start, end: counted[j].end)
                sum += Double(counted[j].n) * item.overlap(window) / item.length
                last = j
                j += 1
            }
            if sum / c.rateWindowSeconds > c.maxWordsPerSecond {
                add(window.start, counted[last].end, "impossible-rate", "\(String(format: "%.1f", sum / c.rateWindowSeconds)) words/s over \(Int(c.rateWindowSeconds)) s")
            }
        }

        // 2. Repeated sentences across segments (lecturer emphasis stays allowed)
        let list = sentences(segments)
        var run = 1
        for i in list.indices {
            let s = list[i]
            if s.words < c.repeatMinWords { run = 1; continue }
            if i > 0, list[i - 1].words >= c.repeatMinWords, similarity(list[i - 1].norm, s.norm) >= c.similarity { run += 1 } else { run = 1 }
            if run > c.backToBackMax { add(list[i - run + 1].start, s.end, "repeated-sentence", "same sentence \(run)× in a row") }
            var inWindow = 1
            var earliest = s
            var j = i - 1
            while j >= 0 && s.start - list[j].start <= c.repeatWindowSeconds {
                let other = list[j]
                if other.words >= c.repeatMinWords && similarity(other.norm, s.norm) >= c.similarity { inWindow += 1; earliest = other }
                j -= 1
            }
            if inWindow > c.repeatMaxInWindow {
                add(earliest.start, s.end, "repeated-sentence", "same sentence \(inWindow)× within \(Int(c.repeatWindowSeconds / 60)) min")
            }
        }

        // 3. Vocabulary diversity over sliding word windows
        struct StreamWord { var w: String; var start: Double; var end: Double }
        var stream: [StreamWord] = []
        for segment in spoken { for w in words(segment.text) { stream.append(StreamWord(w: w, start: segment.start, end: segment.end)) } }
        var i = 0
        while i + c.ttrWindowWords <= stream.count {
            let slice = stream[i..<(i + c.ttrWindowWords)]
            let ratio = Double(Set(slice.map(\.w)).count) / Double(slice.count)
            if ratio < c.minTypeTokenRatio { add(slice.first!.start, slice.last!.end, "low-diversity", "only \(Int((ratio * 100).rounded())) % distinct words") }
            i += max(1, c.ttrWindowWords / 2)
        }

        // 4. Pieces: dominant sentence, output vs. speech, identical pieces
        struct Measured { var piece: Piece; var words: Int; var speechSeconds: Double; var text: String }
        var measured: [Measured] = []
        for piece in pieces {
            let inPiece = spoken.filter { $0.start >= piece.start && $0.start < piece.end }
            let pieceWords = inPiece.reduce(0) { $0 + words($1.text).count }
            let speechSeconds = speech.map { $0.reduce(0) { $0 + $1.overlap(piece.range) } } ?? (piece.end - piece.start)
            var counts: [String: (words: Int, times: Int)] = [:]
            for s in sentences(inPiece) where s.words >= c.repeatMinWords {
                var x = counts[s.norm] ?? (0, 0)
                x.words += s.words; x.times += 1
                counts[s.norm] = x
            }
            let topWords = counts.values.filter { $0.times >= 3 }.map { $0.words }.max() ?? 0
            if pieceWords >= c.dominantMinWords && Double(topWords) / Double(pieceWords) > c.dominantShare {
                add(piece.start, piece.end, "dominant-sentence", "one sentence is \(Int((Double(topWords) / Double(pieceWords) * 100).rounded())) % of the words")
            }
            if speechSeconds > 30 && Double(pieceWords) / (speechSeconds / 60) > c.maxWordsPerMinute {
                add(piece.start, piece.end, "excess-output", "\(Int((Double(pieceWords) / (speechSeconds / 60)).rounded())) words per minute of speech")
            }
            if speech != nil && speechSeconds >= c.missingTextSpeechSeconds && pieceWords <= c.missingTextMaxWords {
                add(piece.start, piece.end, "missing-text", "\(Int(speechSeconds.rounded())) s of speech but \(pieceWords) words")
            }
            measured.append(Measured(piece: piece, words: pieceWords, speechSeconds: (speechSeconds * 10).rounded() / 10,
                                     text: normalize(inPiece.map(\.text).joined(separator: " "))))
        }
        if let speech {
            for segment in spoken {
                let count = words(segment.text).count
                let length = segment.end - segment.start
                let voiced = speech.reduce(0) { $0 + $1.overlap(segment) }
                if count >= c.silenceTextMinWords && length >= 1 && voiced / length < 0.1 {
                    add(segment.start, segment.end, "text-over-silence", "\(count) words where the audio is silent")
                }
            }
        }
        var seen: [String: Measured] = [:]
        for item in measured where item.words >= c.identicalPieceMinWords {
            if let twin = seen[item.text] {
                add(twin.piece.start, twin.piece.end, "identical-pieces", "same text as another part of the lecture")
                add(item.piece.start, item.piece.end, "identical-pieces", "same text as another part of the lecture")
            } else {
                seen[item.text] = item
            }
        }

        let reports = measured.map { item -> PieceReport in
            let range = item.piece.range
            let reasons = findings.filter { f in range.overlap(TimeRange(start: f.start, end: f.end)) > 0 || (f.start >= range.start && f.start < range.end) }
            var kinds: [String] = []
            for f in reasons where !kinds.contains(f.kind) { kinds.append(f.kind) }
            return PieceReport(piece: item.piece, words: item.words, speechSeconds: item.speechSeconds, ok: reasons.isEmpty, reasons: kinds)
        }
        let distinct = stream.isEmpty ? 0 : (Double(Set(stream.map(\.w)).count) / Double(stream.count) * 1000).rounded() / 1000
        return Report(ok: findings.isEmpty, findings: merge(findings), pieces: reports, words: stream.count, distinctWordRatio: distinct)
    }

    /// Merges overlapping findings of the same kind so reports stay short.
    static func merge(_ findings: [Finding]) -> [Finding] {
        let sorted = findings.enumerated().sorted { a, b in
            if a.element.kind != b.element.kind { return a.element.kind < b.element.kind }
            if a.element.start != b.element.start { return a.element.start < b.element.start }
            return a.offset < b.offset
        }.map(\.element)
        var out: [Finding] = []
        for f in sorted {
            if var last = out.last, last.kind == f.kind, f.start <= last.end + 1 {
                last.end = max(last.end, f.end); last.count += 1
                out[out.count - 1] = last
            } else {
                out.append(f)
            }
        }
        return out.enumerated().sorted { a, b in a.element.start != b.element.start ? a.element.start < b.element.start : a.offset < b.offset }.map(\.element)
    }

    /// 0 (unusable) to 1 (clean); used to pick the best of several attempts.
    static func score(_ report: Report) -> Double {
        let span = report.findings.reduce(0) { $0 + max(1, $1.end - $1.start) }
        let total = max(1, report.pieces.reduce(0) { $0 + ($1.piece.end - $1.piece.start) })
        return max(0, 1 - span / total) * (report.ok ? 1 : 0.9)
    }
}
