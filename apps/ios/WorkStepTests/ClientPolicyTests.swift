import Foundation
import WorkStepCore

final class ClientPolicyTests {
    func testServiceAddressAndExactOrigin() throws {
        let server = try ServerAddress(" HTTPS://Example.com:443/ ")
        XCTAssertEqual(server.origin, "https://example.com")
        XCTAssertTrue(server.contains(URL(string: "https://example.com/tasks?task=1")!))
        for value in ["https://example.com.evil/", "http://example.com/", "https://user@example.com/", "https://example.com:444/"] {
            XCTAssertFalse(server.contains(URL(string: value)!))
        }
        for value in ["", "file:///tmp", "https://a/path", "https://a?token=x", "https://a#x", "https://u:p@a", "http://a:0", "http://a:65536"] {
            XCTAssertThrowsError(try ServerAddress(value), value)
        }
        XCTAssertEqual(try ServerAddress("http://[::1]:8765").origin, "http://[::1]:8765")
    }

    func testRememberOnlyUsefulDetailsAndNotificationScope() throws {
        let server = try ServerAddress("https://host")
        let page = URL(string: "https://host/workspace/device/chat?project=p&session=s")!
        XCTAssertTrue(server.shouldRemember(page))
        for path in ["/devices", "/chat?project=p", "/api/auth/callback?code=secret", "/tasks?task=t"] {
            XCTAssertFalse(server.shouldRemember(URL(string: "https://host" + path)!))
        }
        XCTAssertNil(server.notificationURL("//evil/tasks?project=p&task=t"))
        XCTAssertNil(server.notificationURL("/api/delete"))
        XCTAssertNotNil(server.notificationURL("/tasks?project=p&task=t"))
        XCTAssertTrue(ClientPolicy.isViewing(page, target: URL(string: "https://host/workspace/device/chat?session=s&project=p")!))
        XCTAssertFalse(ClientPolicy.isViewing(page, target: URL(string: "https://host/workspace/other/chat?project=p&session=s")!))
    }

    func testLoginSessionOnlyStartsWithValidatedCallbackAndResets() throws {
        let server = try ServerAddress("https://local")
        var policy = NavigationPolicy(server: server)
        XCTAssertFalse(policy.allows(URL(string: "https://unknown/")!))
        XCTAssertFalse(policy.allows(URL(string: "https://gateway/desktop/login?redirect_uri=https%3A%2F%2Fevil%2Fapi%2Fgateway-platform%2Fcallback")!))
        XCTAssertTrue(policy.allows(URL(string: "https://gateway/desktop/login?redirect_uri=https%3A%2F%2Flocal%2Fapi%2Fgateway-platform%2Fcallback")!))
        XCTAssertTrue(policy.allows(URL(string: "https://identity/login")!))
        XCTAssertFalse(policy.allows(URL(string: "http://identity/login")!))
        XCTAssertEqual(policy.rewrittenReturn(URL(string: "http://local/api/gateway-platform/callback?code=x")!)?.absoluteString,
                       "https://local/api/gateway-platform/callback?code=x")
        policy.didStart(URL(string: "https://local/")!)
        XCTAssertFalse(policy.allows(URL(string: "https://identity/login")!))
    }

    func testResumeAndBoundedLedger() {
        XCTAssertFalse(ClientPolicy.shouldReload(backgroundSeconds: 299, openingNotification: false))
        XCTAssertTrue(ClientPolicy.shouldReload(backgroundSeconds: 300, openingNotification: false))
        XCTAssertFalse(ClientPolicy.shouldReload(backgroundSeconds: 600, openingNotification: true))
        var ledger = NotificationLedger(keys: [], limit: 2)
        XCTAssertTrue(ledger.take("a")); XCTAssertFalse(ledger.take("a"))
        XCTAssertTrue(ledger.take("b")); XCTAssertTrue(ledger.take("c"))
        XCTAssertEqual(ledger.keys, ["b", "c"])
    }

    func testNotificationValidationAndSanitizedDiagnostics() throws {
        let server = try ServerAddress("https://host")
        let message: [String: Any] = ["type": "notify", "id": "p:s:m", "scopeName": String(repeating: "名", count: 25),
                                     "sessionId": "s", "outcome": "succeeded", "url": "/chat?project=p&session=s"]
        let notice = try XCTUnwrap(CompletionNotice(message: message, server: server))
        XCTAssertEqual(notice.title, String(repeating: "名", count: 19) + "… · 回复完成")
        XCTAssertNil(CompletionNotice(message: message.merging(["url": "https://evil"]) { _, rhs in rhs }, server: server))
        XCTAssertEqual(ClientPolicy.diagnosticLocation(URL(string: "https://user:secret@host/chat?token=secret#secret")!), "https://host/chat")
    }
}

// Standalone runner also works with Command Line Tools, which omit XCTest.
func XCTAssertTrue(_ value: Bool) { precondition(value) }
func XCTAssertFalse(_ value: Bool) { precondition(!value) }
func XCTAssertEqual<T: Equatable>(_ lhs: T, _ rhs: T) { precondition(lhs == rhs, "\(lhs) != \(rhs)") }
func XCTAssertNil<T>(_ value: T?) { precondition(value == nil) }
func XCTAssertNotNil<T>(_ value: T?) { precondition(value != nil) }
func XCTUnwrap<T>(_ value: T?) throws -> T { guard let value else { throw CheckFailure.missing }; return value }
func XCTAssertThrowsError<T>(_ expression: @autoclosure () throws -> T, _ message: String) {
    do { _ = try expression(); preconditionFailure(message) } catch { }
}
enum CheckFailure: Error { case missing }
@main struct CoreChecks {
    static func main() throws {
        let tests = ClientPolicyTests()
        try tests.testServiceAddressAndExactOrigin()
        try tests.testRememberOnlyUsefulDetailsAndNotificationScope()
        try tests.testLoginSessionOnlyStartsWithValidatedCallbackAndResets()
        tests.testResumeAndBoundedLedger()
        try tests.testNotificationValidationAndSanitizedDiagnostics()
        try checkHealthResponses()
        print("PASS: 5 core behavior groups")
    }
}
