import SwiftUI

/// The lectures of one import, with progress and actions.
struct CourseView: View {
    @EnvironmentObject private var library: LibraryModel
    let course: Course
    @State private var preview: Lecture?

    var body: some View {
        List {
            Section {
                ForEach(library.lectures(in: course)) { lecture in
                    LectureRow(lecture: lecture, preview: $preview)
                }
            } footer: {
                Text("Files are in Files → On My \(DeviceInfo.kind) → Mentality → Lectures → \(course.folderName).")
            }
        }
        .navigationTitle(course.title)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if library.isRunning {
                    Button(role: .destructive) { library.cancelAll() } label: { Label("Stop all", systemImage: "stop.circle") }
                } else if library.lectures(in: course).contains(where: { $0.status == .queued }) {
                    Button { library.start() } label: { Label("Start", systemImage: "play.circle") }
                }
                let files = library.allOutputs(course)
                if !files.isEmpty {
                    ShareLink(items: files) { Label("Share all transcripts", systemImage: "square.and.arrow.up") }
                }
            }
        }
        .sheet(item: $preview) { lecture in TranscriptPreview(lecture: lecture) }
    }
}

struct LectureRow: View {
    @EnvironmentObject private var library: LibraryModel
    let lecture: Lecture
    @Binding var preview: Lecture?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(String(format: "%02d", lecture.order)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Text(lecture.displayTitle).font(.body.weight(.semibold)).lineLimit(2)
                Spacer()
                if lecture.duration > 0 { Text(LectureMarkdown.timestamp(lecture.duration)).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                statusIcon
            }
            Text(lecture.phase).font(.caption).foregroundStyle(.secondary)
            if lecture.isActive { ProgressView(value: lecture.progress) }
            if let error = lecture.error, lecture.status == .failed { Text(error).font(.caption).foregroundStyle(.red) }
            HStack(spacing: 16) {
                if lecture.isFinished {
                    Button("Read") { preview = lecture }
                    Button("Copy text") {
                        if let text = library.transcriptText(lecture) {
                            UIPasteboard.general.string = text
                            library.message = "Transcript copied. Paste it into your AI."
                        }
                    }
                    let files = library.outputURLs(lecture)
                    if !files.isEmpty { ShareLink(items: files) { Text("Share") } }
                }
                if lecture.status == .queued || lecture.isActive { Button("Cancel", role: .destructive) { library.cancel(lecture.id) } }
                if lecture.status == .failed || lecture.status == .cancelled { Button("Retry") { library.retry(lecture.id) } }
                Spacer()
                if !lecture.isActive {
                    Menu {
                        if lecture.isFinished {
                            Button { library.redo(lecture.id) } label: { Label("Transcribe again", systemImage: "arrow.clockwise") }
                        }
                        Button(role: .destructive) { library.delete(lecture) } label: { Label("Delete lecture", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("More actions")
                }
            }
            .buttonStyle(.borderless)
            .font(.footnote.weight(.semibold))
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var statusIcon: some View {
        switch lecture.status {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .needsReview: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        case .preparing, .transcribing: ProgressView().controlSize(.small)
        case .queued: Image(systemName: "clock").foregroundStyle(.secondary)
        case .cancelled: Image(systemName: "minus.circle").foregroundStyle(.secondary)
        case .failed: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        }
    }
}

/// Shows the finished file as plain text (Arabic lines read right to left automatically).
struct TranscriptPreview: View {
    @EnvironmentObject private var library: LibraryModel
    @Environment(\.dismiss) private var dismiss
    let lecture: Lecture

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(library.transcriptText(lecture) ?? "The transcript file is missing.")
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(lecture.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    let files = library.outputURLs(lecture)
                    if !files.isEmpty { ShareLink(items: files) { Image(systemName: "square.and.arrow.up") } }
                }
            }
        }
    }
}
