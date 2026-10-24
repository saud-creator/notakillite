import Darwin
import Foundation

/// Keeps the app's CPU use low enough that iPadOS and iOS let it keep running in the background.
///
/// The system stops a background app that uses more than 80 % of one CPU core over 60 seconds (crash
/// reports call this `cpu_resource_fatal`), even an app that is playing audio. So while the app is in
/// the background, heavy work (noise removal, audio conversion, speech recognition) waits here whenever
/// the whole app used more than `backgroundShare` of one core over the last `window` seconds. Work on
/// the Neural Engine doesn't count as CPU time, so Whisper keeps most of its speed. In the foreground
/// nothing is limited and every core is used.
final class CPUBudget: @unchecked Sendable {
    static let shared = CPUBudget()

    /// Allowed average CPU use in the background, as a share of one core (the system's limit is 0.8).
    let backgroundShare: Double
    /// Seconds over which the average is taken.
    let window: Double

    private struct Sample {
        var time: Double
        var cpu: Double
    }

    private let lock = NSLock()
    private var limited = false
    private var samples: [Sample] = []
    private var backgroundSince: Double?
    private var peak = 0.0

    init(backgroundShare: Double = 0.45, window: Double = 10) {
        self.backgroundShare = backgroundShare
        self.window = window
    }

    /// True while the app is in the background.
    var isLimited: Bool {
        lock.lock()
        defer { lock.unlock() }
        return limited
    }

    /// Called when the app enters (true) or leaves (false) the background.
    func setLimited(_ value: Bool) {
        let time = Self.now(), cpu = Self.processCPUSeconds()
        lock.lock()
        defer { lock.unlock() }
        guard value != limited else { return }
        limited = value
        backgroundSince = value ? time : nil
        if value { peak = 0 }
        samples.append(Sample(time: time, cpu: cpu))
    }

    /// CPU time used by the whole app so far (all threads), in seconds.
    static func processCPUSeconds() -> Double {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return 0 }
        let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
        let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
        return user + system
    }

    static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    /// Average CPU use (share of one core) over about the last `seconds` (default: `window`).
    @discardableResult
    func share(over seconds: Double? = nil) -> Double {
        let time = Self.now(), cpu = Self.processCPUSeconds()
        lock.lock()
        defer { lock.unlock() }
        record(time: time, cpu: cpu)
        return average(from: time - (seconds ?? window), time: time, cpu: cpu, minimumSpan: 0.5)
    }

    /// The highest one-minute average while in the background (reported by the automated test).
    var backgroundPeak: Double {
        lock.lock()
        defer { lock.unlock() }
        return peak
    }

    /// Waits (blocking the calling thread) while the background budget is used up. For worker threads.
    func throttle(cancelled: () -> Bool = { false }) {
        while share() > backgroundShare && isLimited && !cancelled() {
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    /// Waits while the background budget is used up. Throws if the task is cancelled.
    func pause() async throws {
        while share() > backgroundShare && isLimited {
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        try Task.checkCancellation()
    }

    // MARK: Private (call with the lock held)

    private func record(time: Double, cpu: Double) {
        if let last = samples.last, time - last.time < 0.1 { return }
        samples.append(Sample(time: time, cpu: cpu))
        while let first = samples.first, time - first.time > 90 { samples.removeFirst() }
        if limited, let since = backgroundSince, time - since >= 5 {
            peak = max(peak, average(from: max(since, time - 60), time: time, cpu: cpu, minimumSpan: 5))
        }
    }

    /// Average from the newest sample taken at or before `start` (or the oldest one) until now.
    private func average(from start: Double, time: Double, cpu: Double, minimumSpan: Double) -> Double {
        guard let reference = samples.last(where: { $0.time <= start }) ?? samples.first else { return 0 }
        let span = time - reference.time
        guard span >= minimumSpan else { return 0 }
        return max(0, cpu - reference.cpu) / span
    }
}
