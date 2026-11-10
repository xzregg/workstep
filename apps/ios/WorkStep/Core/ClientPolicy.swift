import Foundation

public enum ClientPolicy {
    public static func shouldReload(backgroundSeconds: TimeInterval, openingNotification: Bool) -> Bool {
        backgroundSeconds >= 300 && !openingNotification
    }

    public static func isViewing(_ current: URL, target: URL) -> Bool {
        guard current.scheme == target.scheme, current.host == target.host, current.port == target.port,
              current.path == target.path else { return false }
        func value(_ url: URL, _ name: String) -> String? {
            URLComponents(url: url, resolvingAgainstBaseURL: true)?.queryItems?.first { $0.name == name }?.value
        }
        return ["project", "task", "session"].allSatisfy { value(current, $0) == value(target, $0) }
    }

    public static func diagnosticLocation(_ url: URL) -> String {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return "未知页面" }
        parts.user = nil; parts.password = nil; parts.query = nil; parts.fragment = nil
        return parts.string ?? "未知页面"
    }

    public static func shortName(_ raw: String) -> String {
        let name = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let scalars = name.unicodeScalars
        return scalars.count > 20 ? String(String.UnicodeScalarView(scalars.prefix(19))) + "…" : name
    }
}

public struct NotificationLedger {
    public private(set) var keys: [String]
    private let limit: Int
    public init(keys: [String], limit: Int = 1000) { self.limit = max(1, limit); self.keys = Array(keys.suffix(max(1, limit))) }
    public mutating func take(_ key: String) -> Bool {
        guard !keys.contains(key) else { return false }
        keys.append(key)
        if keys.count > limit { keys.removeFirst(keys.count - limit) }
        return true
    }
}

public struct CompletionNotice {
    public let id: String
    public let title: String
    public let body: String
    public let url: URL

    public init?(message: [String: Any], server: ServerAddress) {
        guard message["type"] as? String == "notify", let id = message["id"] as? String, !id.isEmpty, id.count <= 2048,
              let path = (message["workspaceUrl"] ?? message["url"]) as? String,
              let url = server.notificationURL(path),
              let outcome = message["outcome"] as? String, ["succeeded", "failed"].contains(outcome) else { return nil }
        self.id = id; self.url = url
        let task = message["taskId"] as? String
        let supplied = message["scopeName"] as? String ?? ""
        let name = ClientPolicy.shortName(supplied.isEmpty ? (task.map { "任务 " + $0 } ?? "会话 " + (message["sessionId"] as? String ?? "")) : supplied)
        let rawStep = message["stepKey"] as? String ?? ""
        let step = rawStep == "null" ? "" : rawStep
        let success = outcome == "succeeded"
        title = name + " · " + (step.isEmpty ? "回复" : "步骤") + (success ? "完成" : "失败")
        body = step.isEmpty ? (task == nil ? "会话" : "任务") + "「\(name)」的回复" + (success ? "已完成" : "失败")
            : "任务「\(name)」：步骤 \(step)" + (success ? " 已通过" : " 执行失败")
    }
}
