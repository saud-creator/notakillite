import AVFoundation
import UIKit
import UserNotifications

/// Keeps lecture processing running when you leave the app or lock the iPad (iPadOS 18).
///
/// iPadOS 18 has no general "long background job" API for apps like this one, so the app plays
/// silence through a mixable audio session (declared `audio` background mode). It never interrupts
/// your music. This works for sideloaded builds; the App Store would not allow it.
///
/// Limits that still apply: no GPU in the background (Whisper runs on the Neural Engine and CPU, so it
/// is a bit slower), and swiping the app away in the app switcher stops everything. Progress is saved
/// regularly, so the next launch continues where it stopped.
@MainActor
final class BackgroundKeeper {
    static let shared = BackgroundKeeper()

    private let silence = SilentAudio()
    private var running = false
    private var taskID = UIBackgroundTaskIdentifier.invalid

    func begin(keepAwake: Bool) {
        UIApplication.shared.isIdleTimerDisabled = keepAwake
        guard !running else { return }
        running = true
        silence.start()
        taskID = UIApplication.shared.beginBackgroundTask(withName: "Transcribing lectures") { [weak self] in
            // Called if iPadOS still wants to suspend us; the silent audio normally prevents this.
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
final class SilentAudio {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var configured = false
    private var running = false
    private var observers: [NSObjectProtocol] = []

    func start() {
        running = true
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        if !configured {
            let format = AVAudioFormat(standardFormatWithSampleRate: 22_050, channels: 1)!
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 22_050)!
            buffer.frameLength = buffer.frameCapacity
            memset(buffer.floatChannelData![0], 0, Int(buffer.frameLength) * MemoryLayout<Float>.size)
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            let center = NotificationCenter.default
            // Resume after a phone call, Siri, or another app's audio interruption ends.
            observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                guard let self, self.running,
                      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
                self.resume()
            })
            observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, self.running else { return }
                self.resume()
            })
            configured = true
        }
        resume()
    }

    private func resume() {
        try? AVAudioSession.sharedInstance().setActive(true)
        if !engine.isRunning { try? engine.start() }
        player.play()
    }

    func stop() {
        running = false
        player.pause()
        engine.pause()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
}
