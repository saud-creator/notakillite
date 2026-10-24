import Foundation

/// Finds moments where the lecturer stressed something or mentioned the exam ("this is important",
/// "احفظوا هذا", "it always comes in the exam"…), so the exam-question AI can start from them.
/// Keyword based and deliberately simple: the AI is told to check every hint in context.
enum EmphasisFinder {
    enum Kind: String, Codable, Sendable { case exam, stressed }

    struct Hint: Equatable, Sendable {
        var start: Double
        var kind: Kind
        var text: String
    }

    /// Phrases are matched as whole words after normalisation (case, punctuation, Arabic letter forms).
    static let examCues = [
        // English
        "exam", "exams", "examination question", "final exam", "midterm", "mid term", "quiz", "quizzes", "test you", "tested",
        "in the test", "on the test", "mcq", "mcqs", "osce", "will be asked", "they always ask", "favorite question",
        "favourite question", "comes in the exam", "came in the exam", "past paper", "past papers", "question bank",
        // Arabic (Saudi/Gulf and MSA)
        "امتحان", "الامتحان", "للامتحان", "بالامتحان", "والامتحان", "امتحانات", "الامتحانات",
        "اختبار", "الاختبار", "للاختبار", "بالاختبار", "والاختبار", "الاختبارات", "اختبارات",
        "الفاينل", "فاينل", "بالفاينل", "الميد", "الميدترم", "ميدترم", "كويز", "الكويز", "بالكويز",
        "سؤال امتحان", "يجي سؤال", "جاء سؤال", "جا سؤال", "بيجي سؤال", "راح يجي", "بيجيكم", "يجيكم", "حيجيكم", "يجي في",
    ]

    static let stressCues = [
        // English
        "important", "very important", "most important", "key point", "key points", "take home", "high yield",
        "must know", "need to know", "memorize", "memorise", "remember this", "remember that", "don't forget", "do not forget",
        "make sure", "pay attention", "focus on", "write this down", "be careful", "common mistake", "keep in mind",
        // Arabic
        "مهم", "مهمه", "مهمين", "المهم", "اهم", "الاهم", "نقطه مهمه", "مهم جدا",
        "احفظوا", "احفظوه", "احفظوها", "احفظ", "احفظو", "ركزوا", "ركزو", "ركز", "ركزي", "انتبهوا", "انتبهو", "انتبه",
        "لاحظوا", "تذكروا", "لا تنسون", "لا تنسوا", "خذوها", "اكتبوا", "اكتبوها", "انتبهوا لها", "دايم يجي", "دائما يجي",
    ]

    private static let foldedExam = Set(examCues.map(fold))
    private static let foldedStress = Set(stressCues.map(fold))

    /// Normalised text with unified Arabic letter forms, padded with spaces for whole-word matching.
    static func fold(_ text: String) -> String {
        var s = TranscriptQuality.normalize(text)
        s = s.replacingOccurrences(of: "\u{0640}", with: "")   // tatweel
        let map: [Character: Character] = ["أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه", "ى": "ي", "ؤ": "و", "ئ": "ي", "’": "'"]
        s = String(s.map { map[$0] ?? $0 })
        return " " + s + " "
    }

    static func kind(of text: String) -> Kind? {
        let key = fold(text)
        if foldedExam.contains(where: { key.contains($0) }) { return .exam }
        if foldedStress.contains(where: { key.contains($0) }) { return .stressed }
        return nil
    }

    static func hints(_ segments: [SpeechSegment], limit: Int = 80) -> [Hint] {
        var out: [Hint] = []
        for segment in segments where !segment.marker {
            let text = TranscriptText.collapse(segment.text)
            guard let kind = kind(of: text) else { continue }
            let clipped = text.count > 320 ? String(text.prefix(317)) + "…" : text
            if let last = out.last, last.text == clipped { continue }
            out.append(Hint(start: segment.start, kind: kind, text: clipped))
            if out.count >= limit { break }
        }
        return out
    }
}
