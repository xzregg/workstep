import Foundation
import Security

public struct P2pConnection: Equatable {
    public let entryURL: URL
    public let name: String
    public let key: String
    public let server: ServerAddress
    public var pairingURL: URL { URL(string: entryURL.absoluteString + "#pair_key=" + key)! }

    public init(_ input: String) throws {
        guard let parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil,
              parts.percentEncodedPath.range(of: "^/p2p/[A-Za-z0-9._~-]+/?$", options: .regularExpression) != nil,
              let fragment = parts.percentEncodedFragment,
              fragment.range(of: "^pair_key=[A-Za-z0-9_-]{24,128}$", options: .regularExpression) != nil else {
            throw P2pError.invalid
        }
        let authority = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let origin = scheme + "://" + authority + (parts.port.map { ":\($0)" } ?? "")
        server = try ServerAddress(origin)
        name = String(parts.percentEncodedPath.split(separator: "/")[1])
        entryURL = URL(string: server.origin + "/p2p/" + name + "/")!
        key = String(fragment.dropFirst("pair_key=".count))
    }

    public enum P2pError: LocalizedError {
        case invalid
        public var errorDescription: String? { "请输入有效的 P2P 配对链接" }
    }
}

public final class P2pStore {
    private let defaults: UserDefaults
    private let service = "com.workstep.ios.p2p-pair-key"
    private let entriesKey = "p2p_entries"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func load() -> [P2pConnection] {
        (defaults.stringArray(forKey: entriesKey) ?? []).compactMap { entry in
            guard let key = readKey(entry), let item = try? P2pConnection(entry + "#pair_key=" + key) else { return nil }
            return item
        }
    }

    public func save(_ item: P2pConnection) throws {
        let account = item.entryURL.absoluteString
        let data = Data(item.key.utf8)
        let query = keyQuery(account)
        SecItemDelete(query as CFDictionary)
        var insertion = query
        insertion[kSecValueData as String] = data
        insertion[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(insertion as CFDictionary, nil)
        guard status == errSecSuccess else {
            NSLog("P2P Keychain save failed: %d", status)
            throw StoreError.unavailable
        }
        var entries = defaults.stringArray(forKey: entriesKey) ?? []
        if !entries.contains(account) { entries.append(account) }
        defaults.set(entries, forKey: entriesKey)
    }

    public func remove(_ item: P2pConnection) {
        let account = item.entryURL.absoluteString
        SecItemDelete(keyQuery(account) as CFDictionary)
        defaults.set((defaults.stringArray(forKey: entriesKey) ?? []).filter { $0 != account }, forKey: entriesKey)
    }

    private func keyQuery(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private func readKey(_ account: String) -> String? {
        var query = keyQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public enum StoreError: LocalizedError {
        case unavailable
        public var errorDescription: String? { "无法安全保存 P2P 设备" }
    }
}
