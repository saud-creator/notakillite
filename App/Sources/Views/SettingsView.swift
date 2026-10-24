import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppSettings.Key.model) private var model = WhisperModel.turbo.rawValue
    @AppStorage(AppSettings.Key.language) private var language = LectureLanguage.auto.rawValue
    @AppStorage(AppSettings.Key.cleanup) private var cleanup = CleanupMode.voiceIsolation.rawValue
    @AppStorage(AppSettings.Key.vocabulary) private var vocabulary = ""
    @AppStorage(AppSettings.Key.format) private var format = OutputFormat.markdown.rawValue
    @AppStorage(AppSettings.Key.includeInstructions) private var includeInstructions = true
    @AppStorage(AppSettings.Key.instructions) private var instructions = LectureMarkdown.defaultInstructions
    @AppStorage(AppSettings.Key.keepCleanedAudio) private var keepCleanedAudio = true
    @AppStorage(AppSettings.Key.workers) private var workers = 4
    @AppStorage(AppSettings.Key.keepAwake) private var keepAwake = true
    @AppStorage(AppSettings.Key.notify) private var notify = true

    @State private var downloadStatus: String?
    @State private var downloading = false
    @State private var refresh = 0

    private var selectedModel: WhisperModel { WhisperModel(rawValue: model) ?? .turbo }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Model", selection: $model) {
                        ForEach(WhisperModel.offered) { Text($0.title).tag($0.rawValue) }
                    }
                    Text(selectedModel.detail).font(.footnote).foregroundStyle(.secondary)
                    let ready = WhisperEngine.isDownloaded(selectedModel)
                    HStack {
                        Label(ready ? "Downloaded" : "Not downloaded yet", systemImage: ready ? "checkmark.circle" : "icloud.and.arrow.down")
                            .foregroundStyle(ready ? .green : .secondary)
                        Spacer()
                        if downloading { ProgressView() }
                        else if ready {
                            Button("Delete", role: .destructive) { WhisperEngine.delete(selectedModel); Task { await WhisperEngine.shared.unload() }; refresh += 1 }
                        } else {
                            Button("Download now") { download() }
                        }
                    }
                    .id(refresh)
                    if let downloadStatus { Text(downloadStatus).font(.footnote).foregroundStyle(.secondary) }
                } header: { Text("Speech recognition (on this iPad)") } footer: {
                    Text("Runs on the M4's Neural Engine; audio never leaves the iPad. Download on Wi-Fi with the app open; after that it works offline.")
                }

                Section {
                    Picker("Language", selection: $language) {
                        ForEach(LectureLanguage.allCases) { Text($0.label).tag($0.rawValue) }
                    }
                    VStack(alignment: .leading) {
                        Text("Course vocabulary")
                        TextField("e.g. inguinal ligament, cremaster, paracentesis", text: $vocabulary, axis: .vertical)
                            .lineLimit(2...5)
                    }
                } header: { Text("Lecture language") } footer: {
                    Text("Auto works for lectures that switch between Arabic and English. Vocabulary helps Whisper spell drug names and technical terms (keep it short).")
                }

                Section {
                    Picker("Noise cleanup", selection: $cleanup) {
                        ForEach(CleanupMode.allCases) { Text($0.label).tag($0.rawValue) }
                    }
                    Toggle("Save cleaned audio next to the transcript", isOn: $keepCleanedAudio)
                } header: { Text("Audio") } footer: {
                    Text("Silence is always skipped before transcription. If a part fails the quality check, it is re-transcribed from the original audio automatically.")
                }

                Section {
                    Picker("File type", selection: $format) {
                        ForEach(OutputFormat.allCases) { Text($0.label).tag($0.rawValue) }
                    }
                    Toggle("Add instructions for the AI", isOn: $includeInstructions)
                    if includeInstructions {
                        TextEditor(text: $instructions).frame(minHeight: 160).font(.footnote)
                        Button("Reset instructions") { instructions = LectureMarkdown.defaultInstructions }
                    }
                } header: { Text("Output") } footer: {
                    Text("One file per lecture. Each starts with these instructions and a list of moments where the lecturer mentioned the exam or stressed a point.")
                }

                Section {
                    Stepper("Pieces transcribed in parallel: \(min(workers, 4))", value: $workers, in: 1...4)
                    Toggle("Keep the screen on while working", isOn: $keepAwake)
                    Toggle("Notify me when lectures are ready", isOn: $notify)
                } header: { Text("Performance") } footer: {
                    Text("4 is the fastest on iPad Pro M4 (WhisperKit gets slower with more on iPad). Lower it if the iPad gets hot. Changes apply to the next run.")
                }

                Section("Working in the background on iPadOS 18") {
                    Text("Processing continues when you switch apps or lock the iPad. iPadOS doesn't allow the GPU in the background, so the app uses the Neural Engine and CPU throughout. If you swipe the app away in the app switcher, or iPadOS closes it, the work stops and continues from the last saved point when you open the app again.")
                        .font(.footnote)
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func download() {
        downloading = true
        let choice = selectedModel
        Task {
            do {
                try await WhisperEngine.shared.load(choice, workers: workers) { text, _ in
                    Task { @MainActor in downloadStatus = text }
                }
                downloadStatus = "\(choice.shortName) is ready."
            } catch {
                downloadStatus = error.localizedDescription
            }
            downloading = false
            refresh += 1
        }
    }
}
