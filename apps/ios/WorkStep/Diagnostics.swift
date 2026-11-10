import Foundation

final class Diagnostics {
    private let defaults: UserDefaults
    private var entries: [[String: String]]
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        entries = defaults.array(forKey: "diagnostics") as? [[String: String]] ?? []
    }
    // Callers supply fixed categories and numeric error codes, never raw error text or request URLs.
    func record(_ category: String, code: Int? = nil) {
        entries.append(["time": ISO8601DateFormatter().string(from: Date()),
                        "event": category, "code": code.map(String.init) ?? ""])
        entries = Array(entries.suffix(30))
        defaults.set(entries, forKey: "diagnostics")
    }
    func clear() { entries = []; defaults.removeObject(forKey: "diagnostics") }
    var report: String {
        let formatter = DateFormatter(); formatter.dateStyle = .short; formatter.timeStyle = .medium
        let iso = ISO8601DateFormatter()
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "开发版"
        return (["WorkStep iOS \(version)", "系统：\(ProcessInfo.processInfo.operatingSystemVersionString)",
                 "时区：\(TimeZone.current.identifier)", "生成：\(formatter.string(from: Date()))"] + entries.map {
            let time = iso.date(from: $0["time"] ?? "").map { formatter.string(from: $0) } ?? ""
            return "\(time) · \($0["event"] ?? "") \($0["code"] ?? "")"
        }).joined(separator: "\n")
    }
}
