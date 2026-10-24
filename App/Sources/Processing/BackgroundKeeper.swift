import AVFoundation
import UIKit
import UserNotifications

/// Keeps lecture processing running when you leave the app or lock the iPad or iPhone (iPadOS 18).
///
/// iPadOS 18 has no general "long background job" API for apps like this one, so while lectures are
/// being processed the app plays silence through a mixable audio session (declared `audio` background
/// mode). It never interrupts your music. This works for sideloaded builds; the App Store would not
/// allow it.
///
/// Limits that still apply, and how the app handles them:
/// - CPU: iPadOS stops a background app that keeps a CPU core busy for a minute, so the app limits
///   its own CPU use there (`CPUBudget`). The Neural Engine, which runs Whisper, isn't limited.
/// - GPU: not allowed in the background, so nothing in the app uses it.
/// - Swiping the app away in the app switcher stops everything. Progress is saved regularly, so the
///   next launch continues where it stopped.
@MainActor
final class BackgroundKeeper {
    static let shared = BackgroundKeeper()

    /// The automated tests can switch the keep-alive off, to show what happens without it.
    let disabled = AutoTest.keepAliveDisabled

    private let silence = SilentAudio()
    private var running = false
    private var taskID = UIBackgroundTaskIdentifier.invalid

    func begin(keepAwake: Bool) {
        UIApplication.shared.isIdleTimerDisabled = keepAwake
        guard !running, !disabled else { return }
        running = true
        silence.start()
        taskID = UIApplication.shared.beginBackgroundTask(withName: "Transcribing lectures") { [weak self] in
            // Called if iPadOS still wants to suspend the app; the silent audio normally prevents this.
            guard let self else { return }
            UIApplication.shared.endBackgroundTask(self.taskID)
            self.taskID = .invalid
        }
    }

    func end() {
        UIApplication.shared.isIdleTimerDisabled = false
        guard running else { return }
        running = false
        silence.stop()
        if taskID != .invalid { UIApplication.shared.endBackgroundTask(taskID); taskID = .invalid }
    }

    /// For the automated tests' status file.
    var status: [String: Any] {
        ["running": running, "disabled": disabled, "audioPlaying": silence.isPlaying, "audioError": silence.lastError ?? ""]
    }

    static func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func notify(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

/// Plays silence through a mixable playback session so iPadOS keeps the app running in the background.
/// Restarts itself after phone calls, Siri, route changes (headphones, AirPods) and media resets.
final class SilentAudio {
    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 22_050, channels: 1)!
    private lazy var buffer: AVAudioPCMBuffer = {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 22_050)!
        buffer.frameLength = buffer.frameCapacity
        memset(buffer.floatChannelData![0], 0, Int(buffer.frameLength) * MemoryLayout<Float>.size)
        return buffer
    }()
    private var built = false
    private var running = false
    private var observers: [NSObjectProtocol] = []
    private(set) var lastError: String?

    var isPlaying: Bool { running && engine.isRunning && player.isPlaying }

    func start() {
        running = true
        if observers.isEmpty { observe() }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        } catch {
            lastError = "audio session: \(error.localizedDescription)"
        }
        if !built { build() }
        resume()
    }

    func stop() {
        running = false
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func build() {
        engine = AVAudioEngine()
        player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        built = true
    }

    private func resume() {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            if !engine.isRunning { try engine.start() }
            if !player.isPlaying {
                player.stop()
                player.scheduleBuffer(buffer, at: nil, options: .loops)
                player.play()
            }
            lastError = nil
        } catch {
            lastError = "silent audio: \(error.localizedDescription)"
        }
    }

    private func observe() {
        let center = NotificationCenter.default
        // A phone call, Siri or another app's audio interrupted the session: resume when it ends.
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, self.running,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            self.resume()
        })
        // The audio system restarted: everything has to be set up again.
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.running else { return }
            self.build()
            self.resume()
        })
        // Headphones or AirPods connected or removed: the engine stops itself and has to be restarted.
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
            guard let self, self.running, (note.object as? AVAudioEngine) === self.engine else { return }
            self.player.stop()
            self.resume()
        })
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
}
