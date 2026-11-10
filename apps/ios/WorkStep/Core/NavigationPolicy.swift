import Foundation

public struct NavigationPolicy {
    public let server: ServerAddress
    private var authenticating = false
    public init(server: ServerAddress) { self.server = server }

    public mutating func allows(_ url: URL) -> Bool {
        if server.contains(url) { return true }
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
              parts.user == nil, parts.password == nil, parts.host != nil, parts.scheme == "https" else { return false }
        if authenticating { return true }
        let callbacks = (parts.queryItems ?? []).filter { $0.name == "redirect_uri" }
        if callbacks.count == 1, let raw = callbacks.first?.value, let callback = URL(string: raw),
           callback.query == nil, callback.fragment == nil {
            if url.path == "/desktop/login", parts.fragment == nil,
               callback.path == "/api/gateway-platform/callback", server.contains(callback) || isTLSReturn(callback) {
                authenticating = true; return true
            }
            let isIdentity = (url.host == "login.dingtalk.com" && url.path == "/oauth2/auth") ||
                (url.host == "open.work.weixin.qq.com" && url.path == "/wwopen/sso/qrConnect")
            if isIdentity, (parts.port == nil || parts.port == 443), server.contains(callback),
               callback.path.range(of: "^/api/auth/external/[^/]+/callback$", options: .regularExpression) != nil {
                authenticating = true; return true
            }
        }
        return (parts.port == nil || parts.port == 443) && ["login.dingtalk.com", "account.dingtalk.com", "open.work.weixin.qq.com"].contains(parts.host!)
    }

    public mutating func didStart(_ url: URL) { if server.contains(url) { authenticating = false } }

    private func isTLSReturn(_ url: URL) -> Bool {
        server.root.scheme == "https" && url.scheme == "http" && url.host == server.root.host &&
            url.user == nil && url.password == nil &&
            (server.root.port == nil ? url.port == nil || url.port == 80 : url.port == server.root.port)
    }

    public func rewrittenReturn(_ url: URL) -> URL? {
        guard authenticating, isTLSReturn(url), url.fragment == nil,
              url.path == "/api/gateway-platform/callback" || (url.path == "/" && url.query == "gateway_auth=cancelled") else { return nil }
        return URL(string: server.origin + url.path + (url.query.map { "?" + $0 } ?? ""))
    }
}
