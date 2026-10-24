import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    /// Notability's note export (a ZIP archive with a .note extension).
    static let notabilityNote = UTType(importedAs: "com.saudcreator.mentality.notability-note", conformingTo: .zip)
}

/// A file dragged in from Files or another app, copied so it outlives the drag.
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

/// Sidebar of imports (courses) beside the selected course's lectures.
struct ContentView: View {
    @EnvironmentObject private var library: LibraryModel
    @State private var importing = false
    @State private var showingSettings = false
    @State private var selection: UUID?
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var dropTargeted = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            sidebar
        } detail: {
            if let course = library.course(selection) {
                CourseView(course: course)
            } else {
                EmptyLibrary(importing: $importing)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.notabilityNote, .zip, .audio, .folder], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): library.importFiles(urls)
            case .failure(let error): library.message = error.localizedDescription
            }
        }
        .dropDestination(for: DroppedFile.self) { files, _ in
            library.importFiles(files.map(\.url))
            return !files.isEmpty
        } isTargeted: { dropTargeted = $0 }
        .overlay { if dropTargeted { DropHint() } }
        .onChange(of: library.courses.first?.id) { _, newest in if let newest { selection = newest } }
        .onAppear { if selection == nil { selection = library.courses.first?.id } }
    }

    private var sidebar: some View {
        List(selection: $selection) {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Lecture recordings in. Exam-ready text out.").font(.headline)
                    Text("Import Notability notes (.note), audio files or whole folders. Noise and silence are removed, Arabic and English speech is transcribed on this iPad, and every lecture becomes one file for your AI.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                Button { importing = true } label: { Label("Import lectures…", systemImage: "square.and.arrow.down") }
                    .keyboardShortcut("o", modifiers: .command)
                Button { Task { await library.paste() } } label: { Label("Paste from clipboard", systemImage: "doc.on.clipboard") }
                    .keyboardShortcut("v", modifiers: [.command, .shift])
                if library.isImporting { HStack { ProgressView(); Text("Importing…").foregroundStyle(.secondary) } }
            } footer: {
                Text("Keeps working when you switch apps or lock the iPad. Don't swipe the app away in the app switcher: that stops it (it continues on next launch).")
            }
            if let message = library.message {
                Section { Text(message).font(.footnote) }
            }
            if !library.courses.isEmpty {
                Section("Imports") {
                    ForEach(library.courses) { course in
                        NavigationLink(value: course.id) { CourseRow(course: course) }
                            .contextMenu {
                                Button("Delete import and its files", role: .destructive) { library.delete(course) }
                            }
                    }
                }
            }
        }
        .navigationTitle("Mentality")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
                    .keyboardShortcut(",", modifiers: .command)
            }
        }
    }
}

struct CourseRow: View {
    @EnvironmentObject private var library: LibraryModel
    let course: Course
    var body: some View {
        let items = library.lectures(in: course)
        let done = items.filter(\.isFinished).count
        VStack(alignment: .leading, spacing: 3) {
            Text(course.title).font(.body.weight(.semibold)).lineLimit(2)
            HStack(spacing: 6) {
                if items.contains(where: \.isActive) { ProgressView().controlSize(.mini) }
                Text("\(done) of \(items.count) ready").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct EmptyLibrary: View {
    @Binding var importing: Bool
    var body: some View {
        ContentUnavailableView {
            Label("No lectures yet", systemImage: "waveform.badge.mic")
        } description: {
            Text("In Notability: open a note → Share → choose the Note format → Open in Mentality. Or import from Files, paste, or drag recordings onto this window. You can add many lectures at once.")
        } actions: {
            Button("Import lectures…") { importing = true }.buttonStyle(.borderedProminent)
        }
    }
}

struct DropHint: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 18)
            .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 3, dash: [10]))
            .background(Color.accentColor.opacity(0.08))
            .overlay(Label("Drop lectures to import", systemImage: "square.and.arrow.down").font(.title3.weight(.semibold)))
            .padding(12)
            .allowsHitTesting(false)
    }
}
