import XCTest
@testable import Mentality

/// Which Whisper models each device gets, and how saved settings are read.
final class ModelChoiceTests: XCTestCase {
    /// iPad Pro (M4), 11-inch and 13-inch: both full-size large models, turbo first and recommended.
    func testIPadProM4OffersBothFullSizeLargeModels() {
        for device in ["iPad16,3", "iPad16,4", "iPad16,5", "iPad16,6"] {
            let models = WhisperModel.supported(on: device)
            XCTAssertEqual(Array(models.prefix(2)), [.turbo, .largeV3], device)
            XCTAssertFalse(models.contains(.turboCompact), "\(device) runs the full-size models, so the compressed ones aren't offered")
            XCTAssertFalse(models.contains(.largeV3Compact), device)
            XCTAssertEqual(WhisperModel.recommendedModel(on: device), .turbo, device)
        }
    }

    /// iPhone 15 Pro and Pro Max: the compressed versions of the same two models.
    func testIPhone15ProGetsTheCompressedLargeModels() {
        for device in ["iPhone16,1", "iPhone16,2"] {
            let models = WhisperModel.supported(on: device)
            XCTAssertTrue(models.contains(.turboCompact), device)
            XCTAssertTrue(models.contains(.largeV3Compact), device)
            XCTAssertFalse(models.contains(.turbo), "\(device) doesn't have the memory for the full-size large models")
            XCTAssertFalse(models.contains(.largeV3), device)
            XCTAssertEqual(WhisperModel.recommendedModel(on: device), .turboCompact, device)
        }
    }

    /// The simulator reports the device it simulates, not the Mac it runs on.
    func testThisDeviceGetsItsOwnList() {
        let device = DeviceInfo.identifier
        print("Running on \(device) (\(DeviceInfo.kind)); models offered: \(WhisperModel.offered.map(\.rawValue))")
        XCTAssertFalse(WhisperModel.offered.isEmpty)
        if ["iPad16,3", "iPad16,4", "iPad16,5", "iPad16,6"].contains(device) {
            XCTAssertEqual(Array(WhisperModel.offered.prefix(2)), [.turbo, .largeV3])
            XCTAssertEqual(DeviceInfo.kind, "iPad")
        }
        if device.hasPrefix("iPhone16,") {
            XCTAssertEqual(WhisperModel.recommended, .turboCompact)
            XCTAssertEqual(DeviceInfo.kind, "iPhone")
        }
    }

    func testSavedModelsAreCheckedAgainstThisDevice() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "model-choice-\(UUID().uuidString)"))
        XCTAssertEqual(AppSettings.current(defaults).model, WhisperModel.recommended)
        XCTAssertEqual(AppSettings.current(defaults).cleanup, .deepFilter, "DeepFilterNet is the default noise cleanup")
        XCTAssertEqual(AppSettings.current(defaults).service, .onDevice, "speech stays on the device unless you choose a cloud service")

        defaults.set(WhisperModel.largeV3.rawValue, forKey: AppSettings.Key.model)
        let expected: WhisperModel = WhisperModel.offered.contains(.largeV3) ? .largeV3 : WhisperModel.recommended
        XCTAssertEqual(AppSettings.current(defaults).model, expected, "a model this device can't run falls back to the recommended one")
        defaults.set(WhisperModel.base.rawValue, forKey: AppSettings.Key.model)
        XCTAssertEqual(AppSettings.current(defaults).model, .base)
    }

    func testCloudSettings() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "cloud-\(UUID().uuidString)"))
        defaults.set(SpeechService.openAI.rawValue, forKey: AppSettings.Key.service)
        XCTAssertEqual(AppSettings.current(defaults).cloudModel, "gpt-transcribe", "OpenAI's newest model by default")
        defaults.set("whisper-1", forKey: AppSettings.Key.cloudModel(.openAI))
        XCTAssertEqual(AppSettings.current(defaults).cloudModel, "whisper-1")
        defaults.set("retired-model", forKey: AppSettings.Key.cloudModel(.openAI))
        XCTAssertEqual(AppSettings.current(defaults).cloudModel, "gpt-transcribe", "a model that's no longer offered falls back")

        defaults.set(SpeechService.custom.rawValue, forKey: AppSettings.Key.service)
        defaults.set("my-whisper", forKey: AppSettings.Key.cloudModel(.custom))
        defaults.set(" https://speech.example.com/v1 ", forKey: AppSettings.Key.customBaseURL)
        let custom = AppSettings.current(defaults)
        XCTAssertEqual(custom.cloudModel, "my-whisper")
        XCTAssertEqual(custom.customBaseURL, "https://speech.example.com/v1")
        XCTAssertEqual(custom.engineKey, "custom:my-whisper", "checkpoints made with another engine are not reused")

        defaults.set(SpeechService.onDevice.rawValue, forKey: AppSettings.Key.service)
        XCTAssertEqual(AppSettings.current(defaults).engineKey, WhisperModel.recommended.rawValue)
    }
}
