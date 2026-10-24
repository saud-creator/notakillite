import Foundation
import Security

/// API keys for the cloud speech services, kept in the Keychain of this device only: never synced to
/// iCloud, never in backups, never written into transcripts.
enum KeyStore {
    static let service = "com.saudcreator.mentality.cloud-keys"

    static func key(for speech: SpeechService) -> String? { read(speech.rawValue) }

    static func read(_ account: String) -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data {
            let key = String(decoding: data, as: UTF8.self)
            return key.isEmpty ? nil : key
        }
        #if targetEnvironment(simulator)
        // Unsigned simulator builds (CI) have no Keychain access.
        if status == errSecMissingEntitlement { return UserDefaults.standard.string(forKey: fallbackKey(account)) }
        #endif
        return nil
    }

    static func save(_ key: String, for account: String) throws {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { delete(account); return }
        let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8),
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(baseQuery(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery(account)
            add.merge(attributes) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            UserDefaults.standard.set(value, forKey: fallbackKey(account))
            return
        }
        #endif
        guard status == errSecSuccess else { throw KeyStoreError.failed(status) }
    }

    static func delete(_ account: String) {
        SecItemDelete(baseQuery(account) as CFDictionary)
        #if targetEnvironment(simulator)
        UserDefaults.standard.removeObject(forKey: fallbackKey(account))
        #endif
    }

    private static func baseQuery(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private static func fallbackKey(_ account: String) -> String { "simulator-key.\(account)" }
}

enum KeyStoreError: LocalizedError {
    case failed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .failed(let status):
            let detail = (SecCopyErrorMessageString(status, nil) as String?) ?? "error \(status)"
            return "The key could not be saved in the Keychain (\(detail))."
        }
    }
}
