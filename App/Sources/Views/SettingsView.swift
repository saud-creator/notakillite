import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppSettings.Key.service) private var service = SpeechService.onDevice.rawValue
    @AppStorage(AppSettings.Key.model) private var model = WhisperModel.recommended.rawValue
    @AppStorage(AppSettings.Key.language) private var language = LectureLanguage.auto.rawValue
    @AppStorage(AppSettings.Key.cleanup) private var cleanup = CleanupMode.deepFilter.rawValue
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

    private var selectedService: SpeechService { SpeechService(rawValue: service) ?? .onDevice }
    private var selectedCleanup: CleanupMode { CleanupMode(rawValue: cleanup) ?? .deepFilter }

    private var selectedModel: WhisperModel {
        guard let stored = WhisperModel(rawValue: model), stored == .base || WhisperModel.offered.contains(stored) else { return WhisperModel.recommended }
        return stored
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Speech to text", selection: $service) {
                        ForEach(SpeechService.allCases) { Text($0.title).tag($0.rawValue) }
                    }
                } header: { Text("Speech recognition") } footer: {
                    Text(selectedService.isCloud
                         ? "Uses your own API key. Useful for a second opinion on a hard lecture or when the \(DeviceInfo.kind) is busy. The service charges your account per minute of speech."
                         : "Private and free: audio never leaves this \(DeviceInfo.kind), and it works offline once the model is downloaded.")
                }

                if selectedService.isCloud {
                    CloudServiceSection(service: selectedService).id(selectedService)
                } else {
                    whisperSection
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
                    Text("Auto works for lectures that switch between Arabic and English. Vocabulary helps spell drug names and technical terms: keep it short and separate terms with commas.")
                }

                Section {
                    Picker("Noise cleanup", selection: $cleanup) {
                        ForEach(CleanupMode.allCases) { Text($0.label).tag($0.rawValue) }
                    }
                    Text(selectedCleanup.detail).font(.footnote).foregroundStyle(.secondary)
                    Toggle("Save cleaned audio next to the transcript", isOn: $keepCleanedAudio)
                } header: { Text("Audio") } footer: {
                    Text("Silence is always cut out before transcription. If a part fails the quality check, it is transcribed again from the original audio automatically.")
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
                    if !selectedService.isCloud {
                        Stepper("Pieces transcribed in parallel: \(min(workers, 4))", value: $workers, in: 1...4)
                    }
                    Toggle("Keep the screen on while working", isOn: $keepAwake)
                    Toggle("Notify me when lectures are ready", isOn: $notify)
                } header: { Text("Performance") } footer: {
                    Text("4 pieces at a time is the fastest on iPad Pro M4. Lower it if the \(DeviceInfo.kind) gets hot. Changes apply to the next run.")
                }

                Section("Working in the background on \(DeviceInfo.system)") {
                    Text("Processing continues when you switch apps or lock the \(DeviceInfo.kind). \(DeviceInfo.system) stops background apps that keep the CPU busy, so in the background the app paces its CPU work (mostly noise removal); speech recognition runs on the Neural Engine and keeps most of its speed. With the app open, everything runs at full speed. If you swipe the app away in the app switcher, or the system closes it, the work continues from the last saved point when you open the app again.")
                        .font(.footnote)
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    @ViewBuilder private var whisperSection: some View {
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
            .buttonStyle(.borderless)
            .id(refresh)
            if let downloadStatus { Text(downloadStatus).font(.footnote).foregroundStyle(.secondary) }
        } header: { Text("Whisper on this \(DeviceInfo.kind)") } footer: {
            Text(WhisperModel.offered.contains(.largeV3)
                 ? "Runs on the Neural Engine; audio never leaves the \(DeviceInfo.kind). Both large models can stay downloaded, so you can switch between them at any time. Download on Wi-Fi with the app open; after that it works offline."
                 : "Runs on the Neural Engine; audio never leaves the \(DeviceInfo.kind). This \(DeviceInfo.kind) gets compressed versions of the large models, made to fit its memory. Download on Wi-Fi with the app open; after that it works offline.")
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

/// Model, address and API key of a cloud speech service.
struct CloudServiceSection: View {
    let service: SpeechService
    @AppStorage private var model: String
    @AppStorage(AppSettings.Key.customBaseURL) private var baseURL = ""
    @State private var key = ""
    @State private var hasKey = false
    @State private var checking = false
    @State private var result: String?
    @State private var resultOK = false

    init(service: SpeechService) {
        self.service = service
        _model = AppStorage(wrappedValue: service.defaultModel, AppSettings.Key.cloudModel(service))
    }

    var body: some View {
        Section {
            if service.models.isEmpty {
                LabeledContent("Model") {
                    TextField("whisper-1", text: $model)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                TextField("Address, e.g. https://api.example.com/v1", text: $baseURL)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            } else {
                Picker("Model", selection: $model) {
                    ForEach(service.models) { Text($0.title).tag($0.id) }
                }
            }
            SecureField(hasKey ? "Key saved · type a new one to replace it" : "API key", text: $key)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            HStack {
                Button(checking ? "Checking…" : "Save and check") { saveAndCheck() }
                    .disabled(checking || (key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hasKey && service != .custom))
                Spacer()
                if checking { ProgressView() }
                else if hasKey { Button("Remove key", role: .destructive) { remove() } }
            }
            .buttonStyle(.borderless)
            if let result {
                Label(result, systemImage: resultOK ? "checkmark.circle" : "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(resultOK ? .green : .red)
            }
            if let page = service.keyPage { Link("Get a \(service.name) API key", destination: page) }
        } header: {
            Text("\(service.name) · model and API key")
        } footer: {
            Text("Only speech is uploaded: silence is cut out on this \(DeviceInfo.kind) first, and noise removal and the quality check still run here. Your key is kept in this \(DeviceInfo.kind)'s Keychain and is never written into transcripts.")
        }
        .onAppear { hasKey = KeyStore.key(for: service) != nil }
    }

    private func saveAndCheck() {
        let typed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if !typed.isEmpty { try KeyStore.save(typed, for: service.rawValue) }
        } catch {
            result = error.localizedDescription
            resultOK = false
            return
        }
        key = ""
        hasKey = KeyStore.key(for: service) != nil
        let config = CloudConfig(service: service, model: AppSettings.cloudModel(for: service), apiKey: KeyStore.key(for: service) ?? "",
                                 baseURL: baseURL)
        checking = true
        result = nil
        Task {
            let engine = CloudSpeechEngine(config: config)
            engine.maxAttempts = 2
            do {
                try await engine.check()
                result = "It works: \(service.name) answered using \(config.model)."
                resultOK = true
            } catch {
                result = error.localizedDescription
                resultOK = false
            }
            checking = false
        }
    }

    private func remove() {
        KeyStore.delete(service.rawValue)
        hasKey = false
        result = "Key removed from this \(DeviceInfo.kind)."
        resultOK = true
    }
}
