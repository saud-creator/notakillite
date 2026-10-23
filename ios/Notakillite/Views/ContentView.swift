import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    /// Notability's note export (a ZIP archive with a .note extension).
    static let notabilityNote = UTType(importedAs: "com.saudcreator.notakillite.notability-note", conformingTo: .zip)
}

/// A file dragged in from Files or another app (iPad drag and drop), copied so it outlives the drag.
struct DroppedFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            let target = FileManager.default.temporaryDirectory.appendingPathComponent("Dropped-\(UUID().uuidString.prefix(6))-\(received.file.lastPathComponent)")
            try FileManager.default.copyItem(at: received.file, to: target)
            return DroppedFile(url: target)
        }
    }
}

/// iPad: sidebar of imports beside the selected import's lectures. iPhone: the same views as a stack.
struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var importing = false
    @State private var showingSettings = false
    @State private var selection: UUID?
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var dropTargeted = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            sidebar
        } detail: {
            if let batch = model.batches.first(where: { $0.id == selection }) {
                BatchView(batch: batch)
            } else {
                EmptyLectures(importing: $importing)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.notabilityNote, .zip, .audio, .folder], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): model.importFiles(urls)
            case .failure(let error): model.message = error.localizedDescription
            }
        }
        .dropDestination(for: DroppedFile.self) { files, _ in
            model.importFiles(files.map(\.url)); return !files.isEmpty
        } isTargeted: { dropTargeted = $0 }
        .overlay { if dropTargeted { DropHint() } }
        .onChange(of: model.batches.first?.id) { _, newest in if let newest { selection = newest } }
        .onAppear { if selection == nil { selection = model.batches.first?.id } }
    }

    private var sidebar: some View {
        List(selection: $selection) {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Lecture audio in. Clean text for AI out.").font(.headline)
                    Text("Import Notability notes (.note), audio or folders. Noise like air conditioning is removed and each lecture becomes a transcript for ChatGPT or Claude.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                Button { importing = true } label: { Label("Import lectures…", systemImage: "square.and.arrow.down") }
                    .keyboardShortcut("o", modifiers: .command)
                Button { Task { await model.paste() } } label: { Label("Paste from clipboard", systemImage: "doc.on.clipboard") }
                    .keyboardShortcut("v", modifiers: [.command, .shift])
            } footer: {
                Text("Keeps working when you leave the app; progress shows on the Lock Screen on iOS 26 and later. On iPad you can also drag files onto this window.")
            }
            if let message = model.message {
                Section { Text(message).font(.footnote) }
            }
            if !model.batches.isEmpty {
                Section("Imports") {
                    ForEach(model.batches) { batch in
                        NavigationLink(value: batch.id) { BatchRow(batch: batch) }
                    }
                }
            }
        }
        .navigationTitle("Notakillite")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings").keyboardShortcut(",", modifiers: .command)
            }
        }
    }
}

struct BatchRow: View {
    @EnvironmentObject private var model: AppModel
    let batch: LectureBatch
    var body: some View {
        let jobs = model.jobs.filter { $0.batchID == batch.id }
        let done = jobs.filter { $0.status == .done }.count
        VStack(alignment: .leading, spacing: 3) {
            Text(batch.title).font(.body.weight(.semibold)).lineLimit(2)
            HStack(spacing: 6) {
                if jobs.contains(where: { $0.status == .running }) { ProgressView().controlSize(.mini) }
                Text("\(done) of \(jobs.count) ready").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct BatchView: View {
    @EnvironmentObject private var model: AppModel
    let batch: LectureBatch
    var body: some View {
        List {
            Section {
                ForEach(model.jobs.filter { $0.batchID == batch.id }) { job in JobRow(job: job) }
            } footer: {
                Text("Saved in Files → On My \(UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone") → Notakillite → Lectures.")
            }
        }
        .navigationTitle(batch.title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if !transcripts.isEmpty {
                    ShareLink(items: transcripts) { Label("Share all transcripts", systemImage: "square.and.arrow.up") }
                }
            }
        }
    }
    private var transcripts: [URL] { model.transcripts(in: batch) }
}

struct EmptyLectures: View {
    @Binding var importing: Bool
    var body: some View {
        ContentUnavailableView {
            Label("No lectures yet", systemImage: "waveform.badge.mic")
        } description: {
            Text("In Notability: open a note → Share → Note format → Open in Notakillite. Or import from Files, paste, or drag files here.")
        } actions: {
            Button("Import lectures…") { importing = true }.buttonStyle(.borderedProminent)
        }
    }
}

struct DropHint: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 18).strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 3, dash: [10]))
            .background(Color.accentColor.opacity(0.08))
            .overlay(Label("Drop lectures to import", systemImage: "square.and.arrow.down").font(.title3.weight(.semibold)))
            .padding(12).allowsHitTesting(false)
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
