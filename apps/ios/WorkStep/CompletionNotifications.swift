import UIKit
import UserNotifications
import CryptoKit

final class CompletionNotifications: NSObject, UNUserNotificationCenterDelegate {
    var onOpen: ((URL) -> Void)?
    var currentPage: (() -> URL?)?
    var server: ServerAddress?
    private let diagnostics: Diagnostics
    private var ledger = NotificationLedger(keys: UserDefaults.standard.stringArray(forKey: "notificationLedger") ?? [])
    private var pending = Set<String>()
    init(diagnostics: Diagnostics) { self.diagnostics = diagnostics }

    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            DispatchQueue.main.async { self?.diagnostics.record(granted ? "通知权限已允许" : "通知权限未允许") }
        }
    }
    func receive(_ message: [String: Any]) {
        guard let server, let notice = CompletionNotice(message: message, server: server) else { return }
        if UIApplication.shared.applicationState == .active, let page = currentPage?(), ClientPolicy.isViewing(page, target: notice.url) { return }
        let key = server.origin + ":" + notice.id
        guard !ledger.keys.contains(key), !pending.contains(key) else { return }
        pending.insert(key)
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                guard let self else { return }
                guard self.server == server, [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else {
                    self.pending.remove(key); self.diagnostics.record("通知未发送：权限或服务已变化"); return
                }
                let content = UNMutableNotificationContent()
                content.title = notice.title; content.body = notice.body; content.sound = .default
                content.userInfo = ["url": notice.url.absoluteString, "origin": server.origin]
                let identifier = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) { error in
                    DispatchQueue.main.async {
                        self.pending.remove(key)
                        if let error { self.diagnostics.record("通知发送失败", code: (error as NSError).code) }
                        else { _ = self.ledger.take(key); UserDefaults.standard.set(self.ledger.keys, forKey: "notificationLedger") }
                    }
                }
            }
        }
    }
    func sendTest() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] allowed, _ in
            guard allowed else { DispatchQueue.main.async { self?.diagnostics.record("测试通知未发送：缺少权限") }; return }
            let content = UNMutableNotificationContent(); content.title = "WorkStep 测试通知"; content.body = "系统通知已开启。后台任务推送尚未接入。"; content.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        DispatchQueue.main.async { [weak self] in
            defer { completionHandler() }
            guard let self, let server = self.server, info["origin"] as? String == server.origin,
                  let raw = info["url"] as? String, let url = URL(string: raw), server.shouldRemember(url) else { return }
            self.onOpen?(url)
        }
    }
}
