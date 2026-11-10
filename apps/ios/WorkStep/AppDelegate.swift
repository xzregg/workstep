import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "WorkStep", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var browser: BrowserViewController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let browser = BrowserViewController()
        self.browser = browser
        let window = UIWindow(windowScene: scene)
        window.rootViewController = browser
        self.window = window
        window.makeKeyAndVisible()
        UNUserNotificationCenter.current().delegate = browser.notifications
        if let response = connectionOptions.notificationResponse {
            browser.notifications.userNotificationCenter(.current(), didReceive: response, withCompletionHandler: {})
        }
    }

    func sceneDidEnterBackground(_ scene: UIScene) { browser?.enteredBackground() }
    func sceneDidBecomeActive(_ scene: UIScene) { browser?.becameActive() }
}
