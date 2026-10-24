import Accelerate
import CDeepFilter
import CRNNoise
import Foundation

/// A noise-removal model that cleans 48 kHz mono audio in fixed-size frames.
public protocol FrameDenoiser: AnyObject {
    /// Samples per frame (480, which is 10 ms at 48 kHz, for both models).
    var frameLength: Int { get }
    /// How many samples the cleaned output lags behind the input.
    var delay: Int { get }
    /// Cleans one frame. `input` and `output` hold `frameLength` samples in the range −1…1.
    func process(_ input: UnsafeMutablePointer<Float>, _ output: UnsafeMutablePointer<Float>)
}

public enum NoiseModelError: LocalizedError {
    case unavailable(String)
    public var errorDescription: String? {
        switch self { case .unavailable(let reason): reason }
    }
}

/// RNNoise by Xiph: a small recurrent network trained on speech. Very fast; best on steady noise.
public final class RNNoiseDenoiser: FrameDenoiser {
    private let state: OpaquePointer
    public let frameLength: Int
    /// Two frames (960 samples, 20 ms): one for overlap-add and one because the network looks a frame
    /// ahead (since the 0.2 release). Measured against clean speech while this was built.
    public var delay: Int { frameLength * 2 }
    private var scaled: [Float]

    public init() throws {
        guard let state = rnnoise_create(nil) else { throw NoiseModelError.unavailable("RNNoise could not start.") }
        self.state = state
        frameLength = Int(rnnoise_get_frame_size())
        scaled = [Float](repeating: 0, count: frameLength)
    }

    public func process(_ input: UnsafeMutablePointer<Float>, _ output: UnsafeMutablePointer<Float>) {
        // RNNoise works on 16-bit sample values.
        var up: Float = 32_768, down: Float = 1 / 32_768
        let count = vDSP_Length(frameLength)
        scaled.withUnsafeMutableBufferPointer { buffer in
            guard let scaledInput = buffer.baseAddress else { return }
            vDSP_vsmul(input, 1, &up, scaledInput, 1, count)
            _ = rnnoise_process_frame(state, output, scaledInput)
        }
        vDSP_vsmul(output, 1, &down, output, 1, count)
    }

    deinit { rnnoise_destroy(state) }
}

/// DeepFilterNet 3: a state-of-the-art full-band (48 kHz) speech enhancement network.
public final class DeepFilterDenoiser: FrameDenoiser {
    private let state: OpaquePointer
    public let frameLength: Int
    /// STFT window (960) minus hop (480), plus two frames of model lookahead: 1,440 samples (30 ms).
    public var delay: Int { frameLength * 3 }

    /// The DeepFilterNet 3 model shipped with the app.
    public static var bundledModel: URL? { Bundle.module.url(forResource: "DeepFilterNet3_onnx", withExtension: "tar.gz") }

    /// - Parameter attenuationLimit: the most that noise is turned down, in dB (100 or more = no limit).
    ///   A limit keeps a little background and avoids the distortions that can confuse speech recognition.
    public init(model: URL? = DeepFilterDenoiser.bundledModel, attenuationLimit: Float = 100) throws {
        guard let model, FileManager.default.fileExists(atPath: model.path) else {
            throw NoiseModelError.unavailable("The DeepFilterNet model file is missing from the app.")
        }
        // df_create stops the app if the model can't be read, so the file is checked above first.
        guard let state = model.path.withCString({ df_create($0, attenuationLimit, nil) }) else {
            throw NoiseModelError.unavailable("DeepFilterNet could not start.")
        }
        self.state = state
        frameLength = Int(df_get_frame_length(state))
    }

    public func process(_ input: UnsafeMutablePointer<Float>, _ output: UnsafeMutablePointer<Float>) {
        _ = df_process_frame(state, input, output)
    }

    deinit { df_free(state) }
}
