import XCTest
@testable import Mentality

/// Finding a downloaded Whisper model on disk.
final class ModelStorageTests: XCTestCase {
    /// The downloader keeps its bookkeeping in a hidden folder with the same name as the model. The app
    /// must still find the real model folder, or it would show the model as not downloaded and try to
    /// download it again before every lecture (which fails without internet).
    func testDownloadedModelIsFoundNextToTheDownloadersOwnFolder() throws {
        let base = TestAudio.folder()
        let repo = base.appendingPathComponent("models/argmaxinc/whisperkit-coreml")
        let bookkeeping = repo.appendingPathComponent(".cache/huggingface/download/\(WhisperModel.base.rawValue)/AudioEncoder.mlmodelc")
        let model = repo.appendingPathComponent(WhisperModel.base.rawValue)
        let fm = FileManager.default
        for folder in [bookkeeping, model.appendingPathComponent("AudioEncoder.mlmodelc"), base.appendingPathComponent("models/openai/whisper-base")] {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        try Data("x".utf8).write(to: bookkeeping.deletingLastPathComponent().appendingPathComponent("config.json.metadata"))
        try Data("{}".utf8).write(to: model.appendingPathComponent("config.json"))

        XCTAssertNil(WhisperEngine.localFolder(.base, in: base), "a model that never finished loading doesn't count")
        try Data().write(to: model.appendingPathComponent(WhisperEngine.readyMarker))
        XCTAssertEqual(WhisperEngine.localFolder(.base, in: base)?.resolvingSymlinksInPath().path, model.resolvingSymlinksInPath().path)
        XCTAssertNil(WhisperEngine.localFolder(.small, in: base), "other models are not mistaken for it")
    }
}
