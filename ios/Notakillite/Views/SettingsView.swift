import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage("transcribe") private var transcribe = true
    @AppStorage("transcriber") private var transcriber: TranscriberChoice = .onDevice
    @AppStorage("language") private var language: LectureLanguage = .auto
    @AppStorage("model") private var whisperModel: WhisperModelChoice = .recommended
    @AppStorage("cleanup") private var cleanup: CleanupMode = .voiceIsolation
    @AppStorage("vocabulary") private var vocabulary = ""
    @AppStorage("aiPrompt") private var aiPrompt = true
    @State private var keyDraft = ""

    private var backgroundText: String {
        if #available(iOS 26.0, *) {
            return "You can leave the app while lectures are processed. Progress appears on the Lock Screen, where you can also stop it. Closing the app from the app switcher stops the work."
        }
        return "You can leave the app while lectures are processed: it keeps running by holding a silent audio session (this does not interrupt your music). Closing the app from the app switcher stops the work."
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Noise cleanup", selection: $cleanup) { ForEach(CleanupMode.allCases) { Text($0.label).tag($0) } }
                } header: { Text("Cleanup") } footer: {
                    Text(AudioProcessor.voiceIsolationAvailable ? "Apple Voice Isolation runs on this iPhone and removes steady noise like air conditioning." : "Voice Isolation is not available on this device; the original audio is used.")
                }
                Section {
                    Toggle("Make a text transcript (.md)", isOn: $transcribe)
                    Picker("Engine", selection: $transcriber) { ForEach(TranscriberChoice.allCases) { Text($0.label).tag($0) } }
                    Picker("Lecture language", selection: $language) { ForEach(LectureLanguage.allCases) { Text($0.label).tag($0) } }
                    if transcriber == .onDevice {
                        Picker("Model", selection: $whisperModel) { ForEach(WhisperModelChoice.allCases) { Text($0.label).tag($0) } }
                    }
                    TextField("Course vocabulary (optional)", text: $vocabulary, axis: .vertical).lineLimit(1...3)
                    Toggle("Add ChatGPT/Claude instructions at the top", isOn: $aiPrompt)
                } header: { Text("Transcript") } footer: {
                    Text(transcriber == .onDevice ? "Free and private. The model downloads once on first use (Wi-Fi recommended)." : "Audio is uploaded to Groq. Free tier with daily limits.")
                }
                .disabled(!transcribe)
                Section {
                    Text(backgroundText).font(.footnote)
                } header: { Text("Working in the background") }
                if transcriber == .groq {
                    Section {
                        SecureField(model.groqKey.isEmpty ? "Paste your Groq API key" : "Key saved · paste to replace", text: $keyDraft)
                        Button("Save key") { model.saveGroqKey(keyDraft); keyDraft = "" }.disabled(keyDraft.count < 20)
                        if !model.groqKey.isEmpty { Button("Remove key", role: .destructive) { model.saveGroqKey("") } }
                        Link("Get a free key at console.groq.com/keys", destination: URL(string: "https://console.groq.com/keys")!)
                    } header: { Text("Groq API key") } footer: { Text("Stored in the iPhone Keychain and sent only to Groq.") }
                }
            }
            .navigationTitle("Settings")
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}
