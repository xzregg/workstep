import Foundation

public struct ServerAddress: Equatable {
    public let origin: String
    public var root: URL { URL(string: origin + "/")! }

    public init(_ input: String) throws {
        guard let parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.path.isEmpty || parts.path == "/", parts.query == nil, parts.fragment == nil,
              let origin = Self.origin(parts) else { throw AddressError.invalid }
        self.origin = origin
    }

    private static func origin(_ parts: URLComponents) -> String? {
        guard let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.port == nil || (1...65535).contains(parts.port!) else { return nil }
        let port = parts.port
        let defaultPort = scheme == "https" ? 443 : 80
        let authority = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return scheme + "://" + authority + (port == nil || port == defaultPort ? "" : ":\(port!)")
    }

    public func contains(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return false }
        return Self.origin(parts) == origin
    }

    public func shouldRemember(_ url: URL) -> Bool {
        guard contains(url), let parts = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return false }
        let path = parts.path
        let validRoute = path.range(of: "^(?:/workspace/[^/]+)?/(chat|tasks)$", options: .regularExpression) != nil
        let fields = parts.queryItems ?? []
        func has(_ key: String) -> Bool { fields.contains { $0.name == key && !($0.value ?? "").isEmpty } }
        return validRoute && has("project") && has(path.hasSuffix("/chat") ? "session" : "task")
    }

    public func notificationURL(_ path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"),
              let url = URL(string: path, relativeTo: root)?.absoluteURL, shouldRemember(url) else { return nil }
        return url
    }

    public enum AddressError: LocalizedError {
        case invalid
        public var errorDescription: String? { "请输入 HTTP 或 HTTPS 服务根地址，不包含账号、路径或查询参数。" }
    }
}
