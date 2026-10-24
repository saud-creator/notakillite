import Foundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The app's state: imported courses and lectures, and the processing queue.
///
/// Lectures are processed one at a time on the Neural Engine. While one is being transcribed, the
/// next one's audio is cleaned on the CPU at the same time, so the M4 never waits on audio work.
/// Everything is saved to disk, so a closed app resumes where it stopped.
@MainActor
final class LibraryModel: ObservableObject {
    @Published private(set) var courses: [Course] = []
    @Published private(set) var lectures: [Lecture] = []
    @Published var message: String?
    @Published private(set) var isRunning = false
    @Published private(set) var isImporting = false

    private var worker: Task<Void, Never>?
    private var current: (id: UUID, task: Task<Void, Never>)?
    private var prepared: [UUID: Task<PreparedAudio, Error>] = [:]
    private var lastSave = Date.distantPast
    private let demo: Bool
    private let keeper = BackgroundKeeper.shared

    init(demo: Bool = false) {
        self.demo = demo
        if demo { seedDemo(); return }
        var data = LibraryData.load()
        let resumed = data.recoverInterrupted()
        courses = data.courses
        lectures = data.lectures
        if resumed > 0 || lectures.contains(where: { $0.status == .queued }) {
            message = "Continuing \(lectures.filter { $0.status == .queued }.count) lecture(s) from where they stopped."
            start()
        }
    }

    // MARK: Queries

    func lectures(in course: Course) -> [Lecture] { lectures.filter { $0.courseID == course.id }.sorted { $0.order < $1.order } }
    func course(_ id: UUID?) -> Course? { courses.first { $0.id == id } }
    var queuedCount: Int { lectures.filter { $0.status == .queued || $0.isActive }.count }

    func outputURLs(_ lecture: Lecture) -> [URL] {
        guard let course = course(lecture.courseID) else { return [] }
        let folder = Storage.courseFolder(course)
        return lecture.outputs.map { folder.appendingPathComponent($0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    func transcriptText(_ lecture: Lecture) -> String? {
        outputURLs(lecture).first { $0.pathExtension == "md" || $0.pathExtension == "txt" }.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    }

    func allOutputs(_ course: Course) -> [URL] {
        let folder = Storage.courseFolder(course)
        let files = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
        return files.filter { ["md", "txt"].contains($0.pathExtension) }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    // MARK: Import

    /// Copies the picked, shared, dropped or pasted files into the app and queues one lecture per recording.
    func importFiles(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        isImporting = true
        message = "Importing \(urls.count) item\(urls.count == 1 ? "" : "s")…"
        Task.detached(priority: .userInitiated) {
            let result = Result { try Self.copyIn(urls) }
            await MainActor.run { self.finishImport(result) }
        }
    }

    nonisolated private static func copyIn(_ urls: [URL]) throws -> (title: String, recordings: [ImportedRecording]) {
        let fm = FileManager.default
        let staging = Storage.folder(Storage.sources.appendingPathComponent("import-\(UUID().uuidString)", isDirectory: true))
        defer { try? fm.removeItem(at: staging) }
        var local: [URL] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let copy = staging.appendingPathComponent(url.lastPathComponent)
            try? fm.removeItem(at: copy)
            try fm.copyItem(at: url, to: copy)
            local.append(copy)
        }
        var recordings = try NoteImporter.expand(local, into: Storage.folder(staging.appendingPathComponent("audio", isDirectory: true)))
        // Move every recording into its own permanent folder.
        for i in recordings.indices {
            let folder = Storage.folder(Storage.sources.appendingPathComponent(recordings[i].id.uuidString, isDirectory: true))
            let target = folder.appendingPathComponent(recordings[i].file.lastPathComponent)
            try? fm.removeItem(at: target)
            try fm.moveItem(at: recordings[i].file, to: target)
            recordings[i].file = target
        }
        let sources = Set(recordings.map(\.sourceName))
        let title = recordings.count == 1 || sources.count == 1 ? (recordings.first?.title ?? "Lectures") : "\(sources.count) lectures"
        return (title, recordings)
    }

    private func finishImport(_ result: Result<(title: String, recordings: [ImportedRecording]), Error>) {
        isImporting = false
        switch result {
        case .failure(let error):
            message = error.localizedDescription
        case .success(let (title, recordings)):
            guard !recordings.isEmpty else { message = "No audio was found. Choose audio files or Notability .note exports."; return }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd HH.mm"
            let course = Course(title: title, folderName: safeFileName("\(formatter.string(from: Date())) - \(title)"))
            courses.insert(course, at: 0)
            for (index, recording) in recordings.enumerated() {
                let relative = "\(recording.id.uuidString)/\(recording.file.lastPathComponent)"
                lectures.append(Lecture(id: recording.id, courseID: course.id, order: index + 1, title: recording.title,
                                        recordingName: recording.recordingName, sourceName: recording.sourceName, sourceFile: relative))
            }
            message = "Added \(recordings.count) recording\(recordings.count == 1 ? "" : "s")."
            save(force: true)
            start()
        }
    }

    /// Reads audio files, notes, or file URLs from the clipboard.
    func paste() async {
        let board = UIPasteboard.general
        var urls = (board.urls ?? []).filter(\.isFileURL)
        if urls.isEmpty {
            let types = [UTType.audio, .mpeg4Audio, .wav, .mp3, .zip, .data].map(\.identifier)
            for provider in board.itemProviders {
                guard let type = types.first(where: { provider.hasItemConformingToTypeIdentifier($0) }) else { continue }
                if let url = await Self.copyRepresentation(provider, type: type) { urls.append(url) }
            }
        }
        if urls.isEmpty { message = "The clipboard has no audio. In Notability or Files, copy a recording or a .note export, then paste." }
        else { importFiles(urls) }
    }

    nonisolated private static func copyRepresentation(_ provider: NSItemProvider, type: String) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url else { continuation.resume(returning: nil); return }
                let ext = url.pathExtension.isEmpty ? (UTType(type)?.preferredFilenameExtension ?? "m4a") : url.pathExtension
                let target = FileManager.default.temporaryDirectory.appendingPathComponent("Pasted \(UUID().uuidString.prefix(6)).\(ext)")
                do { try FileManager.default.copyItem(at: url, to: target); continuation.resume(returning: target) }
                catch { continuation.resume(returning: nil) }
            }
        }
    }

    // MARK: Queue control

    func start() {
        guard worker == nil, !demo else { return }
        guard lectures.contains(where: { $0.status == .queued }) else { return }
        let settings = AppSettings.current()
        isRunning = true
        keeper.begin(keepAwake: settings.keepAwake)
        if settings.notify { BackgroundKeeper.requestNotificationPermission() }
        worker = Task { [weak self] in
            await self?.runQueue()
            guard let self else { return }
            self.worker = nil
            self.isRunning = false
            self.keeper.end()
        }
    }

    func cancel(_ id: UUID) {
        if current?.id == id { current?.task.cancel() }
        prepared.removeValue(forKey: id)?.cancel()
        update(id) { if $0.status == .queued { $0.status = .cancelled; $0.phase = "Cancelled" } }
        save(force: true)
    }

    func cancelAll() {
        for lecture in lectures where lecture.status == .queued { cancel(lecture.id) }
        current?.task.cancel()
    }

    func retry(_ id: UUID) {
        update(id) { $0.status = .queued; $0.phase = "Waiting"; $0.progress = 0; $0.error = nil }
        save(force: true)
        start()
    }

    /// Starts this lecture over: new audio cleanup and transcription with the current settings.
    func redo(_ id: UUID) {
        guard let lecture = lectures.first(where: { $0.id == id }), !lecture.isActive else { return }
        try? FileManager.default.removeItem(at: Storage.workFolder(lecture))
        retry(id)
    }

    func delete(_ lecture: Lecture) {
        cancel(lecture.id)
        let fm = FileManager.default
        try? fm.removeItem(at: Storage.workFolder(lecture))
        try? fm.removeItem(at: Storage.sources.appendingPathComponent(lecture.id.uuidString, isDirectory: true))
        for url in outputURLs(lecture) { try? fm.removeItem(at: url) }
        lectures.removeAll { $0.id == lecture.id }
        if let course = course(lecture.courseID) {
            if lectures.contains(where: { $0.courseID == course.id }) { try? writeIndex(course) }
            else { courses.removeAll { $0.id == course.id }; try? fm.removeItem(at: Storage.courseFolder(course)) }
        }
        save(force: true)
    }

    func delete(_ course: Course) {
        for lecture in lectures(in: course) { delete(lecture) }
        courses.removeAll { $0.id == course.id }
        try? FileManager.default.removeItem(at: Storage.courseFolder(course))
        save(force: true)
    }

    // MARK: Processing

    private func runQueue() async {
        let settings = AppSettings.current()
        var finished: [Lecture] = []
        while let next = lectures.first(where: { $0.status == .queued }) {
            let task = Task { await self.process(next.id, settings: settings) }
            current = (next.id, task)
            await task.value
            current = nil
            if let done = lectures.first(where: { $0.id == next.id }) {
                if done.isFinished { finished.append(done) }
                if done.status == .failed, done.error?.contains("speech model") == true { break }   // no model: stop the run
            }
        }
        for task in prepared.values { task.cancel() }
        prepared.removeAll()
        save(force: true)
        if settings.notify, !finished.isEmpty {
            let review = finished.filter { $0.status == .needsReview }.count
            BackgroundKeeper.notify(title: "\(finished.count) lecture\(finished.count == 1 ? "" : "s") transcribed",
                                    body: review > 0 ? "\(review) need a quick review (marked ⚠)." : "Ready to give to your AI.")
        }
    }

    private func process(_ id: UUID, settings: AppSettings) async {
        guard let lecture = lectures.first(where: { $0.id == id }), let course = course(lecture.courseID) else { return }
        do {
            // 1. Audio (may already be running in parallel, started while the previous lecture transcribed).
            update(id) { $0.status = .preparing; $0.phase = "Cleaning audio"; $0.progress = 0.01; $0.error = nil }
            save(force: true)
            let preparation = preparedAudio(for: lecture, settings: settings)
            let audio = try await withTaskCancellationHandler { try await preparation.value } onCancel: { preparation.cancel() }
            prepared[id] = nil
            update(id) { $0.duration = audio.duration }

            // 2. Model (downloaded once, then loaded once per run).
            update(id) { $0.status = .transcribing; $0.phase = "Loading speech model"; $0.progress = 0.25 }
            try await WhisperEngine.shared.load(settings.model, workers: settings.workers) { [weak self] text, fraction in
                Task { @MainActor in self?.update(id) { $0.phase = text; $0.progress = 0.25 + fraction * 0.03 } }
            }

            // 3. Start cleaning the next lecture's audio while this one transcribes.
            if let following = lectures.first(where: { $0.status == .queued && $0.id != id }) {
                _ = preparedAudio(for: following, settings: settings, background: true)
            }

            // 4. Transcribe, check quality, repair.
            var options = TranscriptionPipeline.Options()
            options.language = settings.language.whisperCode
            options.vocabulary = settings.vocabulary
            options.batchSize = max(4, settings.workers * 2)
            let pipeline = TranscriptionPipeline(engine: WhisperEngine.shared, options: options, device: UIDevice.current.model)
            let checkpoint = Storage.workFolder(lecture).appendingPathComponent("checkpoint.json")
            let transcript = try await pipeline.run(audio: audio, checkpoint: checkpoint) { [weak self] text, fraction in
                Task { @MainActor in self?.update(id) { $0.phase = text; $0.progress = 0.28 + fraction * 0.7 } }
            }
            try Task.checkCancellation()

            // 5. Files.
            let total = lectures.filter { $0.courseID == course.id }.count
            let outputs = try writeOutputs(lecture, course: course, total: total, audio: audio, transcript: transcript, settings: settings)
            update(id) {
                $0.outputs = outputs.files
                $0.cleanedAudio = outputs.audio
                $0.words = transcript.words
                $0.qualityLabel = transcript.quality.label
                $0.status = transcript.quality.status == .needsReview ? .needsReview : .done
                $0.phase = transcript.quality.status == .needsReview ? "Needs review · \(transcript.words) words · parts marked ⚠" : "Ready for AI · \(transcript.words) words"
                $0.progress = 1
                $0.finished = Date()
            }
            try? writeIndex(course)
            // Free space: prepared audio and checkpoint are no longer needed. The imported source stays.
            try? FileManager.default.removeItem(at: Storage.workFolder(lecture))
        } catch {
            prepared.removeValue(forKey: id)?.cancel()
            if error is CancellationError || Task.isCancelled {
                update(id) { $0.status = .cancelled; $0.phase = "Cancelled" }
            } else {
                update(id) { $0.status = .failed; $0.phase = "Needs attention"; $0.error = error.localizedDescription }
            }
        }
        save(force: true)
    }

    /// Returns the (possibly already running) audio preparation for a lecture.
    @discardableResult
    private func preparedAudio(for lecture: Lecture, settings: AppSettings, background: Bool = false) -> Task<PreparedAudio, Error> {
        if let task = prepared[lecture.id] { return task }
        let id = lecture.id
        let source = Storage.sources.appendingPathComponent(lecture.sourceFile)
        let folder = Storage.workFolder(lecture)
        let mode = settings.cleanup, keep = settings.keepCleanedAudio
        let report: @Sendable (Double) -> Void = { [weak self] fraction in
            Task { @MainActor in
                self?.update(id) { item in
                    guard item.status == .preparing || (background && item.status == .queued) else { return }
                    item.phase = background && item.status == .queued ? "Cleaning audio in advance · \(Int(fraction * 100))%" : "Cleaning audio · \(Int(fraction * 100))%"
                    if item.status == .preparing { item.progress = 0.01 + fraction * 0.24 }
                }
            }
        }
        let task = Task.detached(priority: background ? .utility : .userInitiated) { () throws -> PreparedAudio in
            if let reused = PreparedRecord.load(in: folder, mode: mode, keepCleaned: keep) { report(1); return reused }
            let audio = try AudioPreparer.prepare(input: source, mode: mode, keepCleanedAudio: keep, folder: folder, progress: report)
            PreparedRecord.save(audio, in: folder, mode: mode, keepCleaned: keep)
            return audio
        }
        prepared[id] = task
        return task
    }

    private func writeOutputs(_ lecture: Lecture, course: Course, total: Int, audio: PreparedAudio, transcript: LectureTranscript,
                              settings: AppSettings) throws -> (files: [String], audio: String?) {
        let folder = Storage.courseFolder(course)
        let info = LectureInfo(title: lecture.displayTitle, course: course.title, number: lecture.order, total: total,
                               sourceFile: lecture.sourceName, recording: lecture.recordingName, cleanup: audio.cleanupLabel)
        let instructions = settings.includeInstructions ? settings.instructions : nil
        var files: [String] = []
        let fm = FileManager.default
        for old in lecture.outputs { try? fm.removeItem(at: folder.appendingPathComponent(old)) }
        if settings.format != .text {
            let name = "\(lecture.fileStem).md"
            try LectureMarkdown.markdown(info, transcript: transcript, instructions: instructions).write(to: folder.appendingPathComponent(name), atomically: true, encoding: .utf8)
            files.append(name)
        }
        if settings.format != .markdown {
            let name = "\(lecture.fileStem).txt"
            try LectureMarkdown.plainText(info, transcript: transcript, instructions: instructions).write(to: folder.appendingPathComponent(name), atomically: true, encoding: .utf8)
            files.append(name)
        }
        var audioName: String?
        if let cleaned = audio.cleanedM4A, fm.fileExists(atPath: cleaned.path) {
            let name = "\(lecture.fileStem) (clean audio).m4a"
            let target = folder.appendingPathComponent(name)
            try? fm.removeItem(at: target)
            try fm.copyItem(at: cleaned, to: target)
            audioName = name
            files.append(name)
        }
        return (files, audioName)
    }

    private func writeIndex(_ course: Course) throws {
        let entries = lectures(in: course).filter(\.isFinished).map {
            LectureMarkdown.IndexEntry(number: $0.order, title: $0.displayTitle, duration: $0.duration, words: $0.words,
                                       quality: $0.status == .needsReview ? "⚠ needs review" : "ok",
                                       file: $0.outputs.first { $0.hasSuffix(".md") || $0.hasSuffix(".txt") })
        }
        try LectureMarkdown.index(course: course.title, lectures: entries)
            .write(to: Storage.courseFolder(course).appendingPathComponent("00 - Index.md"), atomically: true, encoding: .utf8)
    }

    // MARK: State

    private func update(_ id: UUID, _ change: (inout Lecture) -> Void) {
        guard let index = lectures.firstIndex(where: { $0.id == id }) else { return }
        change(&lectures[index])
        save(force: false)
    }

    private func save(force: Bool) {
        guard !demo else { return }
        guard force || Date().timeIntervalSince(lastSave) > 5 else { return }
        lastSave = Date()
        try? LibraryData(courses: courses, lectures: lectures).save()
    }

    /// Sample content for screenshots (launch argument --ui-demo). No real audio is used.
    private func seedDemo() {
        let anatomy = Course(title: "Anatomy week 3", folderName: "demo")
        let arabic = Course(title: "محاضرات الجهاز الهضمي", folderName: "demo-ar")
        courses = [anatomy, arabic]
        func lecture(_ course: Course, _ order: Int, _ title: String, _ status: Lecture.Status, _ phase: String, _ progress: Double) -> Lecture {
            var l = Lecture(courseID: course.id, order: order, title: title, recordingName: "Recording", sourceName: "\(title).note", sourceFile: "")
            l.status = status; l.phase = phase; l.progress = progress; l.duration = 2950
            if status == .done { l.words = 6240 }
            return l
        }
        lectures = [
            lecture(anatomy, 1, "Abdominal wall", .done, "Ready for AI · 6,240 words", 1),
            lecture(anatomy, 2, "Inguinal canal", .transcribing, "Transcribing 42%", 0.58),
            lecture(anatomy, 3, "Rectus sheath", .queued, "Cleaning audio in advance · 64%", 0),
            lecture(arabic, 1, "الكبد والبنكرياس", .needsReview, "Needs review · 5,120 words · parts marked ⚠", 1),
        ]
        message = "Added 3 recordings."
        isRunning = true
    }
}

/// Remembers finished audio preparation so a resumed lecture doesn't redo it.
struct PreparedRecord: Codable {
    var speech: String
    var cleaned: String?
    var duration: Double
    var cleanupLabel: String
    var mode: CleanupMode
    var keepCleaned: Bool

    static func file(in folder: URL) -> URL { folder.appendingPathComponent("prepared.json") }

    static func save(_ audio: PreparedAudio, in folder: URL, mode: CleanupMode, keepCleaned: Bool) {
        let record = PreparedRecord(speech: audio.speech.lastPathComponent, cleaned: audio.cleanedM4A?.lastPathComponent, duration: audio.duration,
                                    cleanupLabel: audio.cleanupLabel, mode: mode, keepCleaned: keepCleaned)
        try? JSONEncoder().encode(record).write(to: file(in: folder), options: .atomic)
    }

    static func load(in folder: URL, mode: CleanupMode, keepCleaned: Bool) -> PreparedAudio? {
        guard let data = try? Data(contentsOf: file(in: folder)), let r = try? JSONDecoder().decode(PreparedRecord.self, from: data),
              r.mode == mode, r.keepCleaned == keepCleaned else { return nil }
        let fm = FileManager.default
        let original = folder.appendingPathComponent("original-16k.wav"), speech = folder.appendingPathComponent(r.speech)
        let cleaned = r.cleaned.map { folder.appendingPathComponent($0) }
        guard fm.fileExists(atPath: original.path), fm.fileExists(atPath: speech.path) else { return nil }
        return PreparedAudio(original: original, speech: speech, cleanedM4A: cleaned.flatMap { fm.fileExists(atPath: $0.path) ? $0 : nil },
                             duration: r.duration, cleanupLabel: r.cleanupLabel)
    }
}
