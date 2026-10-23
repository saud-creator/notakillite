import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    /// Notability's note export (a ZIP archive with a .note extension).
    static let notabilityNote = UTType(importedAs: "com.saudcreator.notakillite.notability-note", conformingTo: .zip)
}

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var importing = false
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Lecture audio in. Clean text for AI out.").font(.title3.weight(.semibold))
                        Text("Import a Notability note (.note), audio files or a folder. Background noise like air conditioning is removed, then each lecture becomes a transcript for ChatGPT or Claude.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    Button { importing = true } label: { Label("Import lectures…", systemImage: "square.and.arrow.down") }
                    Button { Task { await model.paste() } } label: { Label("Paste from clipboard", systemImage: "doc.on.clipboard") }
                } footer: {
                    Text("In Notability: open the note → Share → Note format (includes recordings) → Open in Notakillite. Or save it to Files and import it here.")
                }

                if let message = model.message {
                    Section { Text(message).font(.footnote) }
                }

                ForEach(model.batches) { batch in
                    Section {
                        ForEach(model.jobs.filter { $0.batchID == batch.id }) { job in JobRow(job: job) }
                    } header: {
                        Text(batch.title)
                    } footer: {
                        let files = model.transcripts(in: batch)
                        if !files.isEmpty {
                            ShareLink(items: files) { Label("Share all transcripts (\(files.count))", systemImage: "square.and.arrow.up") }
                                .font(.footnote.weight(.semibold))
                        }
                    }
                }
            }
            .navigationTitle("Notakillite")
            .toolbar { Button { showingSettings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings") }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.notabilityNote, .zip, .audio, .folder], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): model.importFiles(urls)
                case .failure(let error): model.message = error.localizedDescription
                }
            }
        }
    }
}

struct JobRow: View {
    @EnvironmentObject private var model: AppModel
    let job: LectureJob

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(String(format: "%02d", job.order)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Text(job.title).font(.body.weight(.semibold)).lineLimit(2)
                Spacer()
                statusIcon
            }
            Text(job.phase).font(.caption).foregroundStyle(.secondary)
            if job.status == .running { ProgressView(value: job.progress) }
            if case .failed(let reason) = job.status { Text(reason).font(.caption).foregroundStyle(.red) }
            HStack(spacing: 14) {
                if let markdown = job.markdown {
                    Button("Copy text") { if let text = model.markdownText(job) { UIPasteboard.general.string = text; model.message = "Transcript copied. Paste it into ChatGPT or Claude." } }
                    ShareLink(item: markdown) { Text("Share .md") }
                }
                if let audio = job.audio, job.status == .done { ShareLink(item: audio) { Text("Audio") } }
                if job.status == .running || job.status == .queued { Button("Cancel", role: .destructive) { model.cancel(job.id) } }
                if job.status == .cancelled || job.isFailed { Button("Retry") { model.retry(job.id) } }
            }
            .buttonStyle(.borderless).font(.footnote.weight(.semibold))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var statusIcon: some View {
        switch job.status {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .running: ProgressView().controlSize(.small)
        case .queued: Image(systemName: "clock").foregroundStyle(.secondary)
        case .cancelled: Image(systemName: "minus.circle").foregroundStyle(.secondary)
        case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
    }
}

extension LectureJob {
    var isFailed: Bool { if case .failed = status { return true } else { return false } }
}
