import Foundation
import UIKit

/// Hooks for the automated tests on the simulator; all of them are off in normal use.
///
/// The UI tests start the app with these environment variables to import real recordings, process
/// them, and follow what the app does while it is in the background:
///
/// - `MENTALITY_AUTOTEST=1` turns the hooks on.
/// - `MENTALITY_RESET=1` starts with an empty library.
/// - `MENTALITY_AUTOTEST_IMPORT` lists recordings to import, separated by `|`.
/// - `MENTALITY_AUTOTEST_STATUS` is a file the app rewrites every second with its state (JSON).
/// - `MENTALITY_MODEL` and `MENTALITY_CLEANUP` choose the Whisper model and the noise cleanup.
/// - `MENTALITY_DISABLE_KEEPALIVE=1` switches off the background keep-alive, to show it is needed.
enum AutoTest {
    private static var environment: [String: String] { ProcessInfo.processInfo.environment }

    static var isActive: Bool { environment["MENTALITY_AUTOTEST"] == "1" }

    /// True while the app only hosts the unit tests: then it shows sample data and processes nothing,
    /// so lectures left over from another test run can't interfere.
    static var isHostingUnitTests: Bool {
        environment["XCTestConfigurationFilePath"] != nil || environment["XCTestBundlePath"] != nil
    }
    static var keepAliveDisabled: Bool { isActive && environment["MENTALITY_DISABLE_KEEPALIVE"] == "1" }

    static var importPaths: [String] {
        guard isActive else { return [] }
        return (environment["MENTALITY_AUTOTEST_IMPORT"] ?? "").split(separator: "|").map(String.init).filter { !$0.isEmpty }
    }

    static var statusFile: URL? {
        guard isActive, let path = environment["MENTALITY_AUTOTEST_STATUS"], !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path)
    }

    /// Runs when the app starts, before the library is loaded.
    static func prepareLaunch() {
        guard isActive else { return }
        let fm = FileManager.default
        if environment["MENTALITY_RESET"] == "1" {
            try? fm.removeItem(at: Storage.support)
            try? fm.removeItem(at: Storage.lectures)
        }
        let defaults = UserDefaults.standard
        defaults.set(SpeechService.onDevice.rawValue, forKey: AppSettings.Key.service)
        defaults.set(false, forKey: AppSettings.Key.notify)
        defaults.set(false, forKey: AppSettings.Key.keepAwake)
        if let model = environment["MENTALITY_MODEL"], WhisperModel(rawValue: model) != nil {
            defaults.set(model, forKey: AppSettings.Key.model)
        }
        if let cleanup = environment["MENTALITY_CLEANUP"], CleanupMode(rawValue: cleanup) != nil {
            defaults.set(cleanup, forKey: AppSettings.Key.cleanup)
        }
        if let path = statusFile?.deletingLastPathComponent() {
            try? fm.createDirectory(at: path, withIntermediateDirectories: true)
        }
    }
}

/// Writes the app's state to the status file once a second. The timer runs on the main thread, so a
/// status file that keeps changing also shows the app is running, not suspended.
@MainActor
final class AutoTestReporter {
    private(set) static var shared: AutoTestReporter?

    private let file: URL
    private weak var library: LibraryModel?
    private var timer: Timer?
    private var finishedIn: [UUID: String] = [:]
    private var beats = 0

    private init(file: URL, library: LibraryModel) {
        self.file = file
        self.library = library
    }

    static func start(library: LibraryModel) {
        guard shared == nil, let file = AutoTest.statusFile else { return }
        let reporter = AutoTestReporter(file: file, library: library)
        shared = reporter
        reporter.write()
        let timer = Timer(timeInterval: 1, repeats: true) { _ in
            MainActor.assumeIsolated { reporter.write() }
        }
        RunLoop.main.add(timer, forMode: .common)
        reporter.timer = timer
    }

    /// Remembers whether a lecture finished while the app was in the foreground or the background.
    func noteFinished(_ id: UUID) {
        finishedIn[id] = Self.appState == "background" ? "background" : "foreground"
        write()
    }

    private static var appState: String {
        switch UIApplication.shared.applicationState {
        case .active: "active"
        case .inactive: "inactive"
        case .background: "background"
        @unknown default: "unknown"
        }
    }

    func write() {
        guard let library else { return }
        beats += 1
        let budget = CPUBudget.shared
        let lectures: [[String: Any]] = library.lectures.sorted { $0.added != $1.added ? $0.added < $1.added : $0.order < $1.order }.map { lecture in
            var item: [String: Any] = [
                "title": lecture.displayTitle,
                "status": lecture.status.rawValue,
                "phase": lecture.phase,
                "progress": lecture.progress,
                "words": lecture.words,
                "files": library.outputURLs(lecture).map(\.path),
            ]
            if let error = lecture.error { item["error"] = error }
            if let place = finishedIn[lecture.id] { item["finishedIn"] = place }
            return item
        }
        let status: [String: Any] = [
            "beat": beats,
            "time": Date().timeIntervalSince1970,
            "appState": Self.appState,
            "running": library.isRunning,
            "keepAlive": BackgroundKeeper.shared.status,
            "cpu": [
                "recent": budget.share(),
                "backgroundPeak": budget.backgroundPeak,
                "limit": budget.backgroundShare,
                "limited": budget.isLimited,
            ] as [String: Any],
            "lectures": lectures,
            "message": library.message ?? "",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: file, options: .atomic)
    }
}
