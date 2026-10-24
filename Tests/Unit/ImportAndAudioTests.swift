import AVFoundation
import XCTest
import ZIPFoundation
@testable import Mentality

final class ImportAndAudioTests: XCTestCase {
    /// A Notability "Note" export: a ZIP with Recordings/ and a library.plist that lists the saved order.
    private func makeNote(_ url: URL, recordings: [(String, Data)], libraryOrder: [String]) throws {
        try? FileManager.default.removeItem(at: url)
        let archive = try Archive(url: url, accessMode: .create)
        func add(_ path: String, _ data: Data) throws {
            try archive.addEntry(with: path, type: .file, uncompressedSize: Int64(data.count), provider: { position, size in
                data.subdata(in: Int(position)..<Int(position) + size)
            })
        }
        try add("Lecture 5/Session.plist", Data("<plist/>".utf8))
        try add("Lecture 5/Recordings/library.plist", Data(("bplist00 " + libraryOrder.joined(separator: " ")).utf8))
        for (name, data) in recordings { try add("Lecture 5/Recordings/\(name)", data) }
        try add("Lecture 5/Images/page1.png", Data([0x89, 0x50]))
    }

    func testNotabilityNoteExportGivesRecordingsInSavedOrder() throws {
        let folder = TestAudio.folder()
        let wav = folder.appendingPathComponent("tone.wav")
        try TestAudio.writeSpeechLike(wav, pattern: [(1, 0.5)], amplitude: 0.3)
        let audio = try Data(contentsOf: wav)
        let note = folder.appendingPathComponent("Lecture 5.note")
        try makeNote(note, recordings: [("a1b2.m4a", audio), ("c3d4.m4a", audio), ("ffff", audio)], libraryOrder: ["c3d4.m4a", "ffff", "a1b2.m4a"])
        let recordings = try NoteImporter.expand([note], into: folder.appendingPathComponent("out"))
        XCTAssertEqual(recordings.count, 3, "files without an extension inside Recordings/ are detected by their content")
        XCTAssertEqual(recordings.map(\.title), ["Lecture 5", "Lecture 5", "Lecture 5"])
        XCTAssertEqual(recordings.map(\.recordingName), ["Recording 1", "Recording 2", "Recording 3"])
        XCTAssertTrue(recordings[0].file.lastPathComponent.hasSuffix("c3d4.m4a"))
        XCTAssertTrue(recordings[1].file.lastPathComponent.hasSuffix("ffff"))
        XCTAssertTrue(recordings[2].file.lastPathComponent.hasSuffix("a1b2.m4a"))
        XCTAssertTrue(recordings.allSatisfy { FileManager.default.fileExists(atPath: $0.file.path) })
    }

    func testFoldersOfAudioImportInNaturalOrderAndNoAudioIsExplained() throws {
        let folder = TestAudio.folder()
        let lectures = folder.appendingPathComponent("Week 3", isDirectory: true)
        try FileManager.default.createDirectory(at: lectures, withIntermediateDirectories: true)
        for name in ["Lecture 10.wav", "Lecture 2.wav", "notes.pdf"] {
            try TestAudio.writeSpeechLike(lectures.appendingPathComponent(name), pattern: [(0.5, 0)], amplitude: 0.2)
        }
        let recordings = try NoteImporter.expand([lectures], into: folder.appendingPathComponent("out"))
        XCTAssertEqual(recordings.map(\.title), ["Lecture 2", "Lecture 10"])

        let empty = folder.appendingPathComponent("Empty.note")
        try makeNote(empty, recordings: [], libraryOrder: [])
        XCTAssertThrowsError(try NoteImporter.expand([empty], into: folder.appendingPathComponent("out2"))) { error in
            XCTAssertTrue(error.localizedDescription.contains("Note"), error.localizedDescription)
        }
    }

    /// Decoding, the filters and 16 kHz output for the modes without a neural network. (The tone
    /// below isn't a real voice, and the neural models are right to treat it as noise; they get real
    /// speech in the next test.)
    func testAudioIsDecodedFilteredAndResampledTo16kHz() async throws {
        let folder = TestAudio.folder()
        let input = folder.appendingPathComponent("lecture.wav")
        // 44.1 kHz with background hiss, like a phone recording.
        let duration = try TestAudio.writeSpeechLike(input, pattern: [(3, 1), (3, 1)], amplitude: 0.4, rate: 44_100, noise: 0.01)
        for mode in CleanupMode.allCases where mode.neuralModel == nil {
            let audio = try await AudioPreparer.prepare(input: input, mode: mode, keepCleanedAudio: true, folder: folder.appendingPathComponent(mode.rawValue)) { _ in }
            print("\(mode.rawValue): \(audio.cleanupLabel)")
            XCTAssertEqual(audio.duration, duration, accuracy: 0.05, mode.rawValue)
            let speech = try AVAudioFile(forReading: audio.speech)
            XCTAssertEqual(speech.fileFormat.sampleRate, 16_000)
            XCTAssertEqual(speech.fileFormat.channelCount, 1)
            XCTAssertEqual(Double(speech.length) / 16_000, duration, accuracy: 0.1, mode.rawValue)
            XCTAssertTrue(FileManager.default.fileExists(atPath: audio.original.path))
            if mode == .none {
                XCTAssertEqual(audio.speech, audio.original)
            } else {
                XCTAssertNotNil(audio.cleanedM4A)
                let analysis = try SpeechDetector.analyze(audio.speech)
                XCTAssertEqual(analysis.speechSeconds, 6, accuracy: 1.0, "\(mode.rawValue): \(audio.cleanupLabel)")
            }
            XCTAssertFalse(audio.cleanupLabel.isEmpty)
        }
    }

    /// DeepFilterNet and RNNoise inside the whole preparation: real speech (from DeepFilterNet's test
    /// recordings) at 44.1 kHz with hiss under it, as a phone might record a lecture.
    func testNeuralCleanupInsideThePreparation() async throws {
        guard let assets = ProcessInfo.processInfo.environment["MENTALITY_NOISE_ASSETS"], !assets.isEmpty else {
            throw XCTSkip("Set MENTALITY_NOISE_ASSETS (the CI workflow does) to test the noise models on real speech.")
        }
        let voice = try NoiseModelTests.read48k(URL(fileURLWithPath: assets).appendingPathComponent("clean_freesound_33711.wav"))
        let speech = TestAudio.resample(voice, from: 48_000, to: 44_100)
        let pause = [Float](repeating: 0, count: 88_200)
        var seed: UInt32 = 7
        let samples = (speech + pause + speech + pause).map { value -> Float in
            seed = seed &* 1_103_515_245 &+ 12345
            return value + (Float(seed % 2000) / 1000 - 1) * 0.01
        }
        let folder = TestAudio.folder()
        let input = folder.appendingPathComponent("phone-recording.wav")
        try TestAudio.write(samples, rate: 44_100, to: input)
        let duration = Double(samples.count) / 44_100, spoken = 2 * Double(speech.count) / 44_100

        for mode in CleanupMode.allCases where mode.neuralModel != nil {
            let audio = try await AudioPreparer.prepare(input: input, mode: mode, keepCleanedAudio: true, folder: folder.appendingPathComponent(mode.rawValue)) { _ in }
            print("\(mode.rawValue): \(audio.cleanupLabel)")
            XCTAssertTrue(audio.cleanupLabel.hasPrefix(mode.shortLabel), "the built-in model ran: \(audio.cleanupLabel)")
            XCTAssertTrue(audio.cleanupLabel.contains("dB lower"), "the hiss was removed: \(audio.cleanupLabel)")
            XCTAssertNotEqual(audio.speech, audio.original, "the cleaned audio goes to speech recognition")
            XCTAssertNotNil(audio.cleanedM4A)
            XCTAssertEqual(audio.duration, duration, accuracy: 0.05, mode.rawValue)
            let file = try AVAudioFile(forReading: audio.speech)
            XCTAssertEqual(file.fileFormat.sampleRate, 16_000)
            XCTAssertEqual(file.fileFormat.channelCount, 1)
            XCTAssertEqual(Double(file.length) / 16_000, duration, accuracy: 0.1, mode.rawValue)
            let analysis = try SpeechDetector.analyze(audio.speech)
            XCTAssertGreaterThan(analysis.speechSeconds, spoken * 0.5, "\(mode.rawValue): the voice is still there")
            XCTAssertLessThan(analysis.speechSeconds, duration, mode.rawValue)
        }
    }

    /// A lecturer who pauses a lot (2 s of speech, then 8 s of silence) in a noisy room. DeepFilterNet
    /// removes the noise between sentences very well, and that must not look like "the voice was
    /// removed": the louder half of this recording falls by about 20 dB, its loudest tenth by about 2 dB.
    func testNoiseRemovalIsKeptWhenTheLecturerPausesALot() async throws {
        guard let assets = ProcessInfo.processInfo.environment["MENTALITY_NOISE_ASSETS"], !assets.isEmpty else {
            throw XCTSkip("Set MENTALITY_NOISE_ASSETS (the CI workflow does) to test the noise models on real speech.")
        }
        let voice = try NoiseModelTests.read48k(URL(fileURLWithPath: assets).appendingPathComponent("clean_freesound_33711.wav"))
        var clean = [Float](repeating: 0, count: 48_000)
        var start = 0
        while clean.count < 48_000 * 60 {
            if start + 96_000 > voice.count { start = 0 }
            clean += voice[start..<(start + 96_000)]
            clean += [Float](repeating: 0, count: 384_000)
            start += 81_600
        }
        let noisy = TestAudio.mix(clean, TestAudio.roomNoise(count: clean.count, rate: 48_000), snr: 8)
        let folder = TestAudio.folder()
        let input = folder.appendingPathComponent("pauses-a-lot.wav")
        try TestAudio.write(noisy, rate: 48_000, to: input)
        let audio = try await AudioPreparer.prepare(input: input, mode: .deepFilter, keepCleanedAudio: false, folder: folder.appendingPathComponent("work")) { _ in }
        XCTAssertTrue(audio.cleanupLabel.hasPrefix(CleanupMode.deepFilter.shortLabel), "the cleaned audio was kept: \(audio.cleanupLabel)")
        XCTAssertTrue(audio.cleanupLabel.contains("dB lower"), audio.cleanupLabel)
        XCTAssertNotEqual(audio.speech, audio.original)
    }

    func testLibraryIsSavedAndInterruptedLecturesResume() throws {
        let url = TestAudio.folder().appendingPathComponent("library.json")
        let course = Course(title: "C", folderName: "c")
        var running = Lecture(courseID: course.id, order: 1, title: "A", recordingName: "Recording", sourceName: "a.note", sourceFile: "x/a.m4a")
        running.status = .transcribing
        var done = Lecture(courseID: course.id, order: 2, title: "B", recordingName: "Recording", sourceName: "b.note", sourceFile: "y/b.m4a")
        done.status = .done
        try LibraryData(courses: [course], lectures: [running, done]).save(to: url)
        var loaded = LibraryData.load(from: url)
        XCTAssertEqual(loaded.lectures.count, 2)
        XCTAssertEqual(loaded.recoverInterrupted(), 1)
        XCTAssertEqual(loaded.lectures.map(\.status), [.queued, .done])
    }
}
