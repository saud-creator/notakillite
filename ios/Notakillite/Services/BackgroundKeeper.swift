import AVFoundation
import BackgroundTasks
import Foundation

/// Keeps lecture processing running after the user leaves the app.
///
/// - iOS/iPadOS 26 and later: a Continuous Background Task (`BGContinuedProcessingTask`). The system
///   shows progress in a Live Activity and the user can stop it from there.
/// - iOS/iPadOS 18–25 (or if the system refuses the task): a silent, mixable audio session keeps the
///   app alive while jobs run (the app declares the `audio` background mode). This is for sideloaded
///   builds; it never interrupts the user's own music.
///
/// Work in the background stays off the GPU (iOS forbids it there): Whisper runs on the Neural
/// Engine/CPU and noise cleanup on the CPU.
@MainActor
final class BackgroundKeeper {
    enum Mode: String { case none, continuedTask, silentAudio }
    static let shared = BackgroundKeeper()

    private(set) var mode = Mode.none
    private let silence = SilentAudio()
    private var onExpire: (() -> Void)?
    private var title = "Transcribing lectures"
    private var finished = false
    private var task: AnyObject?   // BGContinuedProcessingTask (iOS 26+)
    private var lastFraction = 0.0, lastDetail = "Starting…"

    /// Call when processing starts in response to the user (import, paste, retry).
    func begin(title: String, onExpire: @escaping () -> Void) {
        guard mode == .none else { return }
        self.title = title; self.onExpire = onExpire; finished = false
        #if compiler(>=6.2)
        if #available(iOS 26.0, *), startContinuedTask() { mode = .continuedTask; return }
        #endif
        silence.start()
        mode = .silentAudio
    }

    func update(fraction: Double, detail: String) {
        lastFraction = min(max(fraction, 0), 1); lastDetail = detail
        #if compiler(>=6.2)
        if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask { report(task) }
        #endif
    }

    func end(success: Bool) {
        finished = true
        #if compiler(>=6.2)
        if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
            task.progress.completedUnitCount = task.progress.totalUnitCount
            task.setTaskCompleted(success: success)
        }
        #endif
        task = nil
        if mode == .silentAudio { silence.stop() }
        mode = .none
    }

    #if compiler(>=6.2)
    @available(iOS 26.0, *)
    private func startContinuedTask() -> Bool {
        guard let bundle = Bundle.main.bundleIdentifier else { return false }
        // Each run gets its own identifier, matching "<bundle id>.lectures.*" in Info.plist.
        let identifier = "\(bundle).lectures.\(UUID().uuidString)"
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
            MainActor.assumeIsolated {
                guard let task = task as? BGContinuedProcessingTask, let self else { task.setTaskCompleted(success: false); return }
                self.attach(task)
            }
        }
        guard registered else { return false }
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: "Starting…")
        request.strategy = .fail   // If the system can't start it now, fall back to silent audio.
        do { try BGTaskScheduler.shared.submit(request); return true } catch { return false }
    }

    @available(iOS 26.0, *)
    private func attach(_ task: BGContinuedProcessingTask) {
        if finished || mode != .continuedTask { task.setTaskCompleted(success: true); return }
        self.task = task
        task.progress.totalUnitCount = 1000
        task.expirationHandler = { [weak self] in
            // The user stopped it from the Live Activity, or the system needed the resources.
            DispatchQueue.main.async { self?.expired() }
        }
        report(task)
    }

    @available(iOS 26.0, *)
    private func report(_ task: BGContinuedProcessingTask) {
        task.progress.completedUnitCount = Int64(lastFraction * 999)
        task.updateTitle(title, subtitle: lastDetail)
    }
    #endif

    private func expired() {
        let handler = onExpire
        task = nil
        mode = .none
        handler?()
    }
}

/// Plays silence through a mixable playback session so iOS keeps the app running in the background.
final class SilentAudio {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var configured = false
    private var running = false
    private var observer: NSObjectProtocol?

    func start() {
        running = true
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        if !configured {
            let format = AVAudioFormat(standardFormatWithSampleRate: 22_050, channels: 1)!
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 22_050)!
            buffer.frameLength = buffer.frameCapacity
            memset(buffer.floatChannelData![0], 0, Int(buffer.frameLength) * MemoryLayout<Float>.size)
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            observer = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                // Resume after a phone call or another app's audio interruption ends.
                guard let self, self.running,
                      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
                self.resume()
            }
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

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
}
