import Darwin
import Foundation

/// Which device the app runs on, without touching UIKit (safe from any thread).
enum DeviceInfo {
    /// Model identifier such as "iPad16,6" (iPad Pro 13-inch M4) or "iPhone16,1" (iPhone 15 Pro).
    /// In the simulator, the identifier of the simulated device.
    static let identifier: String = {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty { return simulated }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }()

    /// "iPad" or "iPhone", for text such as "Files → On My iPad".
    static var kind: String { identifier.hasPrefix("iPhone") ? "iPhone" : "iPad" }

    /// "iPadOS" or "iOS".
    static var system: String { kind == "iPhone" ? "iOS" : "iPadOS" }
}
