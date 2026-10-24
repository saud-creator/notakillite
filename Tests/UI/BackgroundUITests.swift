import XCTest

/// The app driven like a person would use it, on the simulator of the device under test:
///
/// 0. The main screens and Settings (sample data), with screenshots.
/// 1. Without the background keep-alive, the system suspends the app soon after you leave it.
/// 2. With it, lectures keep being cleaned and transcribed after pressing Home: the app is never
///    suspended, its status keeps updating every second, every lecture finishes while the app is in
///    the background, and its CPU use stays under the system's background limit.
///
/// The app writes its state to a status file once a second (MENTALITY_AUTOTEST_STATUS, see
/// AutoTest.swift in the app). CI provides the recordings (MENTALITY_BACKGROUND_LECTURES) and a folder
/// for screenshots, status files and transcripts (MENTALITY_UI_OUT).
final class BackgroundUITests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment
    private var deviceLabel: String { environment["MENTALITY_DEVICE_LABEL"] ?? "device" }
    private var outFolder: URL? { environment["MENTALITY_UI_OUT"].map { URL(fileURLWithPath: $0, isDirectory: true) } }

    struct Status: Decodable {
        struct KeepAlive: Decodable {
            var running: Bool
            var disabled: Bool
            var audioPlaying: Bool
            var audioError: String
        }
        struct CPU: Decodable {
            var recent: Double
            var backgroundPeak: Double
            var limit: Double
            var limited: Bool
        }
        struct Lecture: Decodable {
            var title: String
            var status: String
            var phase: String
            var progress: Double
            var words: Int
            var files: [String]
            var error: String?
            var finishedIn: String?
        }
        var beat: Int
        var time: Double
        var appState: String
        var running: Bool
        var keepAlive: KeepAlive
        var cpu: CPU
        var lectures: [Lecture]
        var message: String
    }

    // MARK: 0. Screens

    @MainActor
    func test0_MainScreenAndSettings() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-demo"]
        app.launch()

        let course = app.staticTexts["Anatomy week 3"].firstMatch
        XCTAssertTrue(course.waitForExistence(timeout: 60), "the list of imports is shown")
        if !app.staticTexts["Abdominal wall"].firstMatch.exists {
            course.tap()   // iPhone: the list comes first
        }
        XCTAssertTrue(app.staticTexts["Abdominal wall"].firstMatch.waitForExistence(timeout: 20), "the lectures of the import are shown")
        XCTAssertTrue(element(app, containing: "Ready for AI").exists)
        save(app.screenshot(), as: "1-lectures")

        // Settings (on iPhone, from the list screen).
        let settings = app.buttons["settings"].firstMatch
        if !settings.exists {
            let back = app.navigationBars.buttons["Mentality"].firstMatch
            (back.exists ? back : app.navigationBars.buttons.firstMatch).tap()
        }
        XCTAssertTrue(settings.waitForExistence(timeout: 20), "the Settings button is shown")
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20))
        let turbo = element(app, containing: "large-v3 turbo")
        XCTAssertTrue(turbo.waitForExistence(timeout: 10), "large-v3 turbo is the default model")
        save(app.screenshot(), as: "2-settings")

        // The model menu: both large models on iPad Pro (M4); compressed versions on iPhone.
        turbo.tap()
        let other = element(app, containing: "large-v3 · ")
        XCTAssertTrue(other.waitForExistence(timeout: 10), "the full large-v3 model is offered too")
        save(app.screenshot(), as: "3-models")
        if environment["MENTALITY_EXPECT_FULL_MODELS"] == "1" {
            XCTAssertTrue(element(app, containing: "large-v3 · most accurate").exists, "iPad Pro (M4) offers the full-size large-v3")
            XCTAssertFalse(element(app, containing: "compressed").exists, "iPad Pro (M4) doesn't need the compressed models")
        }
        if environment["MENTALITY_EXPECT_FULL_MODELS"] == "0" {
            XCTAssertTrue(element(app, containing: "compressed, 626 MB").exists, "iPhone gets the compressed turbo model")
            XCTAssertTrue(element(app, containing: "compressed, 947 MB").exists, "iPhone gets the compressed large-v3")
        }
        // Close the menu without changing the model: tap the title bar by position (on iPad the open menu
        // covers the sheet, so XCTest would refuse to tap the bar as an element).
        app.navigationBars["Settings"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(other.waitForNonExistence(timeout: 10), "the model menu closed")

        // The cloud option shows its model and key fields; then back to on-device.
        let service = element(app, containing: "Whisper, private, offline")
        XCTAssertTrue(service.waitForExistence(timeout: 10))
        service.tap()
        let openAI = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "OpenAI")).firstMatch
        XCTAssertTrue(openAI.waitForExistence(timeout: 10), "cloud services are offered")
        openAI.tap()
        XCTAssertTrue(app.secureTextFields.firstMatch.waitForExistence(timeout: 10), "the API key field is shown")
        XCTAssertTrue(element(app, containing: "gpt-transcribe").exists, "OpenAI's newest model is preselected")
        save(app.screenshot(), as: "4-cloud")
        element(app, containing: "OpenAI · cloud").tap()
        let onDevice = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "On this")).firstMatch
        XCTAssertTrue(onDevice.waitForExistence(timeout: 10))
        onDevice.tap()
        XCTAssertTrue(element(app, containing: "Whisper, private, offline").waitForExistence(timeout: 10))

        // Further down: noise cleanup, DeepFilterNet 3 by default.
        let cleanup = element(app, containing: "DeepFilterNet 3")
        for _ in 0..<4 where !cleanup.exists { app.swipeUp() }
        XCTAssertTrue(cleanup.exists, "DeepFilterNet 3 is the default noise cleanup")
        save(app.screenshot(), as: "5-settings-audio")
    }

    // MARK: 1. Without the keep-alive

    @MainActor
    func test1_WithoutTheKeepAliveTheSystemSuspendsTheApp() throws {
        let files = try lectureFiles()
        let status = statusURL("without-keepalive")
        let app = launchForProcessing(files, status: status, keepAlive: false)
        guard let started = waitForStatus(status, timeout: 240, { $0.lectures.contains { ["preparing", "transcribing"].contains($0.status) } }) else {
            app.terminate()
            return XCTFail("processing never started: \(describe(readStatus(status)))")
        }
        XCTAssertFalse(started.keepAlive.running, "the keep-alive is switched off for this test")
        XCUIDevice.shared.press(.home)
        let left = Date()
        defer { app.terminate() }
        while Date().timeIntervalSince(left) < 100 {
            if app.state == .runningBackgroundSuspended {
                let after = Int(Date().timeIntervalSince(left))
                let frozen = readStatus(status)?.beat
                Thread.sleep(forTimeInterval: 6)
                let later = readStatus(status)?.beat
                XCTAssertEqual(frozen, later, "a suspended app does no work")
                record("Without the keep-alive, the system suspended the app \(after) s after leaving it, in the middle of a lecture.", file: "without-keepalive.txt")
                return
            }
            Thread.sleep(forTimeInterval: 1)
        }
        throw XCTSkip("This simulator didn't suspend the app within 100 s even without the keep-alive, so it can't show the difference here.")
    }

    // MARK: 2. With the keep-alive

    @MainActor
    func test2_LecturesKeepProcessingInTheBackground() throws {
        let files = try lectureFiles()
        let status = statusURL("background")
        let app = launchForProcessing(files, status: status, keepAlive: true)
        guard let started = waitForStatus(status, timeout: 300, { s in
            s.running && s.lectures.count == files.count && s.lectures.contains { ["preparing", "transcribing"].contains($0.status) }
        }) else {
            return XCTFail("processing never started: \(describe(readStatus(status)))")
        }
        XCTAssertTrue(started.keepAlive.running, "the keep-alive started with the queue")
        XCTAssertTrue(started.keepAlive.audioPlaying, "the silent audio is playing (\(started.keepAlive.audioError))")
        save(app.screenshot(), as: "6-processing")

        XCUIDevice.shared.press(.home)
        let left = Date()
        var last = started
        var beats = Set<Int>()
        var states: [String: Int] = [:]      // as XCTest sees the app
        var ownStates: [String: Int] = [:]   // as the app itself reports it (UIApplication.applicationState)
        let timeout = Double(environment["MENTALITY_BACKGROUND_TIMEOUT"] ?? "") ?? 1_800
        let finalStates: Set<String> = ["done", "needsReview", "failed", "cancelled"]
        var log: [String] = []
        var lastLog = Date.distantPast
        while true {
            Thread.sleep(forTimeInterval: 2)
            let state = app.state
            let stateName = Self.name(state)
            states[stateName, default: 0] += 1
            if state == .runningBackgroundSuspended || state == .notRunning {
                XCTFail("the app was \(stateName) \(Int(Date().timeIntervalSince(left))) s after leaving it. Last status: \(describe(last))")
                break
            }
            if let now = readStatus(status) {
                last = now
                beats.insert(now.beat)
                ownStates[now.appState, default: 0] += 1
            }
            if Date().timeIntervalSince(lastLog) >= 30 {
                lastLog = Date()
                let line = "\(Int(Date().timeIntervalSince(left))) s: app says \(last.appState) (XCTest: \(stateName)), \(describe(last))"
                log.append(line)
                print(line)
            }
            if last.lectures.count == files.count && last.lectures.allSatisfy({ finalStates.contains($0.status) }) { break }
            if Date().timeIntervalSince(left) > timeout {
                XCTFail("not finished after \(Int(timeout)) s in the background: \(describe(last))")
                break
            }
        }
        let away = Date().timeIntervalSince(left)
        let peak = last.cpu.backgroundPeak
        var summary = [
            "Device: \(deviceLabel)",
            "Time in the background: \(Int(away)) s (the system gives an app about 30 s without a keep-alive)",
            "App state every 2 s while away, as the app reports it: \(ownStates.sorted { $0.key < $1.key }.map { "\($0.key) ×\($0.value)" }.joined(separator: ", "))",
            "App state as XCTest sees it: \(states.sorted { $0.key < $1.key }.map { "\($0.key) ×\($0.value)" }.joined(separator: ", ")) (the simulator does not always update this)",
            "Status updates received: \(beats.count) (the app rewrites its status every second while it runs)",
            "Highest 1-minute CPU use in the background: \(Int(peak * 100)) % of one core (the app's own limit \(Int(last.cpu.limit * 100)) %, the system's limit 80 %)",
            "Keep-alive: running \(last.keepAlive.running), silent audio playing \(last.keepAlive.audioPlaying) \(last.keepAlive.audioError)",
        ]
        for lecture in last.lectures {
            summary.append("Lecture \"\(lecture.title)\": \(lecture.status), \(lecture.words) words, finished in the \(lecture.finishedIn ?? "?") · \(lecture.phase) \(lecture.error ?? "")")
        }
        summary += ["", "Progress while away:"] + log
        record(summary.joined(separator: "\n"), file: "background-summary.txt")

        for lecture in last.lectures {
            XCTAssertTrue(["done", "needsReview"].contains(lecture.status), "\(lecture.title): \(lecture.status) \(lecture.error ?? "")")
            XCTAssertEqual(lecture.finishedIn, "background", "\(lecture.title) finished while the app was in the background")
            XCTAssertGreaterThan(lecture.words, 20, "\(lecture.title) has a real transcript")
        }
        XCTAssertEqual(last.appState, "background")
        XCTAssertGreaterThan(away, 45, "the work went on well beyond the ~30 s any app gets")
        XCTAssertGreaterThan(Double(beats.count), away / 2 * 0.6, "the app kept running the whole time")
        XCTAssertGreaterThan(peak, 0, "CPU use was measured in the background")
        XCTAssertLessThanOrEqual(peak, 0.8, "CPU use stayed under the system's background limit")

        // The transcripts: one Markdown file per lecture, with the spoken content.
        var allText = ""
        for lecture in last.lectures {
            for path in lecture.files where path.hasSuffix(".md") {
                let text = try String(contentsOfFile: path, encoding: .utf8)
                allText += text.lowercased()
                XCTAssertTrue(text.contains("## Transcript"), path)
                if let out = outFolder?.appendingPathComponent("transcripts", isDirectory: true) {
                    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                    try? text.write(to: out.appendingPathComponent("\(deviceLabel) - background - \(URL(fileURLWithPath: path).lastPathComponent)"), atomically: true, encoding: .utf8)
                }
            }
        }
        XCTAssertTrue(allText.contains("exam"), "the lectures mention the exam")
        XCTAssertTrue(allText.contains("deepfilternet"), "the files say which noise cleanup was used")

        // Back in the app: the finished lectures.
        app.activate()
        XCTAssertTrue(element(app, containing: "Ready for AI").waitForExistence(timeout: 30) || element(app, containing: "Needs review").exists)
        save(app.screenshot(), as: "7-finished-in-background")
    }

    // MARK: Helpers

    @MainActor
    private func launchForProcessing(_ files: [String], status: URL, keepAlive: Bool) -> XCUIApplication {
        try? FileManager.default.removeItem(at: status)
        let app = XCUIApplication()
        app.launchEnvironment = [
            "MENTALITY_AUTOTEST": "1",
            "MENTALITY_RESET": "1",
            "MENTALITY_AUTOTEST_IMPORT": files.joined(separator: "|"),
            "MENTALITY_AUTOTEST_STATUS": status.path,
            "MENTALITY_MODEL": environment["MENTALITY_MODEL"] ?? "openai_whisper-base",
            "MENTALITY_CLEANUP": environment["MENTALITY_CLEANUP"] ?? "deepFilter",
        ]
        if let models = environment["MENTALITY_MODELS_DIR"] { app.launchEnvironment["MENTALITY_MODELS_DIR"] = models }
        if !keepAlive { app.launchEnvironment["MENTALITY_DISABLE_KEEPALIVE"] = "1" }
        app.launch()
        return app
    }

    private func lectureFiles() throws -> [String] {
        guard let list = environment["MENTALITY_BACKGROUND_LECTURES"], !list.isEmpty else {
            throw XCTSkip("Set MENTALITY_BACKGROUND_LECTURES (the CI workflow does) to recordings separated by |.")
        }
        let files = list.split(separator: "|").map(String.init)
        for file in files { XCTAssertTrue(FileManager.default.fileExists(atPath: file), "missing \(file)") }
        return files
    }

    private func statusURL(_ name: String) -> URL {
        let folder = outFolder ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("\(deviceLabel)-status-\(name).json")
    }

    private func readStatus(_ url: URL) -> Status? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Status.self, from: data)
    }

    private func waitForStatus(_ url: URL, timeout: Double, _ condition: (Status) -> Bool) -> Status? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let status = readStatus(url), condition(status) { return status }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return nil
    }

    private func describe(_ status: Status?) -> String {
        guard let status else { return "no status yet" }
        let lectures = status.lectures.map { "\($0.title): \($0.status) \(Int($0.progress * 100))% (\($0.phase))\($0.error.map { " error: \($0)" } ?? "")" }
        return "[\(lectures.joined(separator: "; "))] cpu \(Int(status.cpu.recent * 100))%/peak \(Int(status.cpu.backgroundPeak * 100))%, keep-alive \(status.keepAlive.running ? "on" : "off")\(status.keepAlive.audioError.isEmpty ? "" : " (\(status.keepAlive.audioError))"), message: \(status.message)"
    }

    private static func name(_ state: XCUIApplication.State) -> String {
        switch state {
        case .runningForeground: "foreground"
        case .runningBackground: "background"
        case .runningBackgroundSuspended: "suspended"
        case .notRunning: "not running"
        case .unknown: "unknown"
        @unknown default: "unknown"
        }
    }

    @MainActor
    private func element(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    @MainActor
    private func save(_ screenshot: XCUIScreenshot, as name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "\(deviceLabel)-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = outFolder?.appendingPathComponent("screenshots", isDirectory: true) {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: folder.appendingPathComponent("\(deviceLabel)-\(name).png"))
        }
    }

    private func record(_ text: String, file: String) {
        print(text)
        let attachment = XCTAttachment(string: text)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = outFolder {
            try? text.write(to: folder.appendingPathComponent("\(deviceLabel)-\(file)"), atomically: true, encoding: .utf8)
        }
    }
}
