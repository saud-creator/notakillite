import Foundation
import Security
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Stores the Groq key in the iOS Keychain (this device only).
enum Keychain {
    private static let service = "Notakillite.Groq"
    static func load() -> String {
        var item: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
    static func save(_ key: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(base as CFDictionary)
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(trimmed.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// User settings, stored with @AppStorage keys of the same names (see SettingsView).
struct ProcessingSettings {
    var transcribe = true
    var transcriber = TranscriberChoice.onDevice
    var language = LectureLanguage.auto
    var model = WhisperModelChoice.recommended
    var cleanup = CleanupMode.voiceIsolation
    var vocabulary = ""
    var aiPrompt = true

    static func current(_ defaults: UserDefaults = .standard) -> ProcessingSettings {
        var value = ProcessingSettings()
        if defaults.object(forKey: "transcribe") != nil { value.transcribe = defaults.bool(forKey: "transcribe") }
        if defaults.object(forKey: "aiPrompt") != nil { value.aiPrompt = defaults.bool(forKey: "aiPrompt") }
        value.transcriber = defaults.string(forKey: "transcriber").flatMap(TranscriberChoice.init(rawValue:)) ?? value.transcriber
        value.language = defaults.string(forKey: "language").flatMap(LectureLanguage.init(rawValue:)) ?? value.language
        value.model = defaults.string(forKey: "model").flatMap(WhisperModelChoice.init(rawValue:)) ?? value.model
        value.cleanup = defaults.string(forKey: "cleanup").flatMap(CleanupMode.init(rawValue:)) ?? value.cleanup
        value.vocabulary = defaults.string(forKey: "vocabulary") ?? ""
        return value
    }
}

struct LectureJob: Identifiable {
    enum Status: Equatable { case queued, running, done, failed(String), cancelled }
    let id = UUID()
    var recording: ImportedRecording
    var order: Int
    var batchID: UUID
    var status: Status = .queued
    var phase = "Waiting"
    var progress = 0.0
    var markdown: URL?
    var audio: URL?
    var words = 0
    var duration = 0.0
    var title: String { recording.title + (recording.recordingName.hasPrefix("Recording ") ? " - \(recording.recordingName)" : "") }
}

struct LectureBatch: Identifiable {
    let id: UUID
    var title: String
    var folder: URL
    var created: Date
}

@MainActor
final class AppModel: ObservableObject {
    @Published var jobs: [LectureJob] = []
    @Published var batches: [LectureBatch] = []
    @Published var message: String?
    @Published private(set) var groqKey: String = Keychain.load()

    private var worker: Task<Void, Never>?
    private var current: (id: UUID, task: Task<Void, Never>)?
    private var runJobs: [UUID] = []   // jobs handled by the current background run, for overall progress
    private let keeper = BackgroundKeeper.shared

    init() {
        if CommandLine.arguments.contains("--ui-demo") { seedDemo() }
    }
    private let fileManager = FileManager.default
    var exportsFolder: URL { fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Lectures", isDirectory: true) }
    var importsFolder: URL { fileManager.temporaryDirectory.appendingPathComponent("imports", isDirectory: true) }

    func saveGroqKey(_ key: String) { Keychain.save(key); groqKey = Keychain.load() }

    // MARK: Import

    /// Copies files the user picked, shared, or pasted, then queues one job per recording.
    func importFiles(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        do {
            let folder = importsFolder.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            var local: [URL] = []
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let copy = folder.appendingPathComponent(url.lastPathComponent)
                try? fileManager.removeItem(at: copy)
                try fileManager.copyItem(at: url, to: copy)
                local.append(copy)
            }
            let recordings = try NoteImporter.expand(local, into: folder.appendingPathComponent("audio", isDirectory: true))
            guard !recordings.isEmpty else { message = "No audio was found. Choose audio files or Notability .note exports."; return }
            let sources = Set(recordings.map(\.sourceName))
            let name = recordings.count == 1 || sources.count == 1 ? recordings[0].title : "\(sources.count) lectures"
            let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd HH.mm"
            let batch = LectureBatch(id: UUID(), title: name, folder: exportsFolder.appendingPathComponent(safeName("\(formatter.string(from: Date())) - \(name)"), isDirectory: true), created: Date())
            batches.insert(batch, at: 0)
            for (index, recording) in recordings.enumerated() { jobs.append(LectureJob(recording: recording, order: index + 1, batchID: batch.id)) }
            message = "Added \(recordings.count) recording\(recordings.count == 1 ? "" : "s")."
            startWorker()
        } catch { message = error.localizedDescription }
    }

    /// Reads audio files, notes, or file URLs from the clipboard.
    func paste() async {
        let board = UIPasteboard.general
        var urls = (board.urls ?? []).filter(\.isFileURL)
        if urls.isEmpty {
            let types = [UTType.audio, .mpeg4Audio, .wav, .mp3, .zip, .data].map(\.identifier)
            for provider in board.itemProviders {
                guard let type = types.first(where: { provider.hasItemConformingToTypeIdentifier($0) }) else { continue }
                if let url = await copyRepresentation(provider, type: type) { urls.append(url) }
            }
        }
        if urls.isEmpty { message = "The clipboard has no audio. In Notability or Files, copy a recording or .note export, then tap Paste." }
        else { importFiles(urls) }
    }

    private func copyRepresentation(_ provider: NSItemProvider, type: String) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url else { continuation.resume(returning: nil); return }
                let ext = url.pathExtension.isEmpty ? (UTType(type)?.preferredFilenameExtension ?? "audio") : url.pathExtension
                let target = FileManager.default.temporaryDirectory.appendingPathComponent("Pasted \(UUID().uuidString.prefix(6)).\(ext)")
                do { try FileManager.default.copyItem(at: url, to: target); continuation.resume(returning: target) } catch { continuation.resume(returning: nil) }
            }
        }
    }

    // MARK: Processing queue (one lecture at a time)

    private func startWorker() {
        runJobs.append(contentsOf: jobs.filter { $0.status == .queued && !runJobs.contains($0.id) }.map(\.id))
        guard worker == nil else { return }
        // Started by the user's import/paste/retry, so iOS 26+ lets it continue in the background.
        keeper.begin(title: "Notakillite: transcribing lectures") { [weak self] in self?.cancelAll() }
        worker = Task { [weak self] in
            while let self, let next = self.jobs.first(where: { $0.status == .queued }) {
                if !self.runJobs.contains(next.id) { self.runJobs.append(next.id) }
                let task = Task { await self.run(jobID: next.id) }
                self.current = (next.id, task)
                await task.value
                self.current = nil
            }
            guard let self else { return }
            let succeeded = self.jobs.filter { self.runJobs.contains($0.id) }.allSatisfy { $0.status == .done }
            self.keeper.end(success: succeeded)
            self.runJobs = []
            self.worker = nil
        }
    }

    /// Stops the running lecture and everything waiting (used when the user stops the Live Activity).
    func cancelAll() {
        for index in jobs.indices where jobs[index].status == .queued { jobs[index].status = .cancelled; jobs[index].phase = "Cancelled" }
        current?.task.cancel()
    }

    private func reportProgress() {
        guard !runJobs.isEmpty else { return }
        let items = jobs.filter { runJobs.contains($0.id) }
        let finished = items.filter { if case .queued = $0.status { return false }; return $0.status != .running }.count
        let running = items.first { $0.status == .running }
        let fraction = (Double(finished) + (running?.progress ?? 0)) / Double(max(items.count, 1))
        let detail = running.map { "\(min(finished + 1, items.count)) of \(items.count) · \($0.title) · \($0.phase)" } ?? "\(finished) of \(items.count) done"
        keeper.update(fraction: fraction, detail: detail)
    }

    func cancel(_ id: UUID) {
        if current?.id == id { current?.task.cancel() }
        else { update(id) { if $0.status == .queued { $0.status = .cancelled; $0.phase = "Cancelled" } } }
    }

    func retry(_ id: UUID) {
        update(id) { $0.status = .queued; $0.phase = "Waiting"; $0.progress = 0 }
        startWorker()
    }

    private func update(_ id: UUID, _ change: (inout LectureJob) -> Void) {
        if let index = jobs.firstIndex(where: { $0.id == id }) { change(&jobs[index]); reportProgress() }
    }

    nonisolated private static func cleanAudio(_ input: URL, mode: CleanupMode, work: URL, progress: @escaping (Double) -> Void) async throws -> ProcessedAudio {
        try AudioProcessor.process(input: input, mode: mode, workFolder: work, progress: progress)
    }

    private func run(jobID: UUID) async {
        guard let job = jobs.first(where: { $0.id == jobID }), let batch = batches.first(where: { $0.id == job.batchID }) else { return }
        let settings = ProcessingSettings.current()
        let key = groqKey
        update(jobID) { $0.status = .running; $0.phase = "Cleaning audio"; $0.progress = 0.01 }
        let work = fileManager.temporaryDirectory.appendingPathComponent("work-\(jobID.uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: work) }
        let audioShare = settings.transcribe ? 0.35 : 1.0
        do {
            let processed = try await Self.cleanAudio(job.recording.file, mode: settings.cleanup, work: work) { fraction in
                Task { @MainActor in self.update(jobID) { $0.phase = "Cleaning audio · \(Int(fraction * 100))%"; $0.progress = fraction * audioShare } }
            }
            try fileManager.createDirectory(at: batch.folder, withIntermediateDirectories: true)
            let prefix = "\(String(format: "%02d", job.order)) - \(safeName(job.title))"
            let audioTarget = batch.folder.appendingPathComponent("\(prefix).m4a")
            try? fileManager.removeItem(at: audioTarget)
            try fileManager.copyItem(at: processed.cleanedM4A, to: audioTarget)
            update(jobID) { $0.audio = audioTarget; $0.duration = processed.duration }

            if settings.transcribe {
                let request = TranscriptionRequest(wav: processed.speechWAV, duration: processed.duration, language: settings.language, vocabulary: settings.vocabulary, model: settings.model)
                let stage: StageCallback = { phase, fraction in Task { @MainActor in self.update(jobID) { $0.phase = phase; $0.progress = audioShare + fraction * (1 - audioShare) } } }
                let transcript = settings.transcriber == .groq
                    ? try await GroqService.transcribe(request, key: key, workFolder: work, stage: stage)
                    : try await WhisperService.shared.transcribe(request, stage: stage)
                try Task.checkCancellation()
                let total = jobs.filter { $0.batchID == batch.id }.count
                let markdown = TranscriptFormatter.lectureMarkdown(title: job.title, recording: job.recording.recordingName, sourceFile: job.recording.sourceName, duration: processed.duration, cleanup: processed.cleanupLabel, transcript: transcript, includePrompt: settings.aiPrompt, number: job.order, total: total)
                let target = batch.folder.appendingPathComponent("\(prefix).md")
                try markdown.write(to: target, atomically: true, encoding: .utf8)
                update(jobID) { $0.markdown = target; $0.words = TranscriptFormatter.wordCount(transcript.segments) }
                try writeIndex(batch)
            }
            update(jobID) { $0.status = .done; $0.progress = 1; $0.phase = $0.markdown != nil ? "Ready for AI · \($0.words) words" : "Cleaned audio ready" }
        } catch {
            if error is CancellationError || Task.isCancelled { update(jobID) { $0.status = .cancelled; $0.phase = "Cancelled" } }
            else { update(jobID) { $0.status = .failed(error.localizedDescription); $0.phase = "Needs attention" } }
        }
    }

    private func writeIndex(_ batch: LectureBatch) throws {
        let done = jobs.filter { $0.batchID == batch.id && $0.markdown != nil }.sorted { $0.order < $1.order }
        let entries = done.map { TranscriptFormatter.IndexEntry(number: $0.order, title: $0.title, duration: $0.duration, words: $0.words, transcript: $0.markdown?.lastPathComponent) }
        try TranscriptFormatter.indexMarkdown(title: batch.title, lectures: entries).write(to: batch.folder.appendingPathComponent("00 - Index.md"), atomically: true, encoding: .utf8)
    }

    /// Sample content for screenshots and UI checks (launch argument --ui-demo). No real audio is used.
    private func seedDemo() {
        let folder = fileManager.temporaryDirectory.appendingPathComponent("demo", isDirectory: true)
        try? fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        let markdown = folder.appendingPathComponent("01 - Anatomy L3.md")
        try? "# Anatomy L3\n".write(to: markdown, atomically: true, encoding: .utf8)
        let course = LectureBatch(id: UUID(), title: "Anatomy week 3", folder: folder, created: Date())
        let arabic = LectureBatch(id: UUID(), title: "محاضرة الجهاز الهضمي", folder: folder, created: Date())
        batches = [course, arabic]
        func recording(_ title: String) -> ImportedRecording { ImportedRecording(file: markdown, title: title, recordingName: "Recording", sourceName: "\(title).note") }
        var done = LectureJob(recording: recording("Abdominal wall"), order: 1, batchID: course.id)
        done.status = .done; done.phase = "Ready for AI · 6,240 words"; done.progress = 1; done.markdown = markdown; done.audio = markdown; done.words = 6240
        var running = LectureJob(recording: recording("Inguinal canal"), order: 2, batchID: course.id)
        running.status = .running; running.phase = "Transcribing 42%"; running.progress = 0.62
        let queued = LectureJob(recording: recording("Rectus sheath"), order: 3, batchID: course.id)
        var failed = LectureJob(recording: recording("الجهاز الهضمي"), order: 1, batchID: arabic.id)
        failed.status = .failed("Groq's free limit was reached. Try again later, or use Whisper on this iPhone."); failed.phase = "Needs attention"
        jobs = [done, running, queued, failed]
        message = "Added 3 recordings."
    }

    func markdownText(_ job: LectureJob) -> String? { job.markdown.flatMap { try? String(contentsOf: $0, encoding: .utf8) } }
    func transcripts(in batch: LectureBatch) -> [URL] {
        ((try? fileManager.contentsOfDirectory(at: batch.folder, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "md" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}

func safeName(_ value: String) -> String {
    let invalid = CharacterSet(charactersIn: "<>:\"/\\|?*").union(.controlCharacters)
    let cleaned = value.precomposedStringWithCompatibilityMapping.unicodeScalars.map { invalid.contains($0) ? "-" : String($0) }.joined()
        .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespaces))
    return cleaned.isEmpty ? "Lecture" : String(cleaned.prefix(100))
}
