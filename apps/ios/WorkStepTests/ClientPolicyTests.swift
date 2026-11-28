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

    func testSavedServiceAddressesMigrateAddSelectAndDelete() throws {
        var book = ServerAddressBook(stored: ["https://one.example.com/", "invalid", "https://one.example.com"],
                                     active: "http://two.example.com:8765")
        XCTAssertEqual(book.origins, ["http://two.example.com:8765", "https://one.example.com"])
        XCTAssertTrue(try book.add("https://three.example.com/"))
        XCTAssertFalse(try book.add("https://three.example.com"))
        XCTAssertThrowsError(try book.add("https://three.example.com/path"), "invalid address")
        XCTAssertEqual(book.origins, ["http://two.example.com:8765", "https://one.example.com", "https://three.example.com"])
        book.remove("http://two.example.com:8765")
        XCTAssertEqual(ServerAddressBook(stored: book.origins, active: nil).origins,
                       ["https://one.example.com", "https://three.example.com"])
    }

    func testP2pPairingLinkDoesNotExposeKeyInSavedAddress() throws {
        let key = "abcdefghijklmnopqrstuvwxyz123456"
        let item = try P2pConnection("https://Signal.Example/p2p/device-1/#pair_key=\(key)")
        XCTAssertEqual(item.entryURL.absoluteString, "https://signal.example/p2p/device-1/")
        XCTAssertEqual(item.name, "device-1")
        XCTAssertEqual(item.server.origin, "https://signal.example")
        XCTAssertEqual(item.pairingURL.absoluteString, "https://signal.example/p2p/device-1/#pair_key=\(key)")
        XCTAssertFalse(item.entryURL.absoluteString.contains(key))
        for link in ["https://host/p2p/device/", "https://host/p2p/device/#pair_key=short",
                     "https://user@host/p2p/device/#pair_key=\(key)",
                     "https://host/p2p/device/?token=one#pair_key=\(key)",
                     "https://host/other/device/#pair_key=\(key)"] {
            XCTAssertThrowsError(try P2pConnection(link), link)
        }
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

    func testMediaCaptureAndSpeechRequests() throws {
        let server = try ServerAddress("https://host")
        let page = URL(string: "https://host/chat")!
        for kind in ["camera", "microphone", "cameraAndMicrophone"] {
            XCTAssertTrue(MediaCapturePolicy.allows(server: server, page: page, frame: page, origin: server.root, mainFrame: true, kind: kind))
            XCTAssertFalse(MediaCapturePolicy.allows(server: server, page: page, frame: page, origin: URL(string: "https://other")!, mainFrame: true, kind: kind))
            XCTAssertFalse(MediaCapturePolicy.allows(server: server, page: page, frame: page, origin: URL(string: "https://host:444")!, mainFrame: true, kind: kind))
            XCTAssertFalse(MediaCapturePolicy.allows(server: server, page: page, frame: page, origin: server.root, mainFrame: false, kind: kind))
        }
        XCTAssertFalse(MediaCapturePolicy.allows(server: server, page: page, frame: page, origin: server.root, mainFrame: true, kind: "unknown"))
        let lan = try ServerAddress("http://192.168.1.2")
        XCTAssertFalse(MediaCapturePolicy.allows(server: lan, page: lan.root, frame: lan.root, origin: lan.root, mainFrame: true, kind: "camera"))
        let local = try ServerAddress("http://localhost:8765")
        XCTAssertTrue(MediaCapturePolicy.allows(server: local, page: local.root, frame: local.root, origin: local.root, mainFrame: true, kind: "microphone"))
        for kind in ["camera", "microphone", "cameraAndMicrophone"] {
            var devices: [String] = [], consent: Bool?
            MediaCaptureAuthorization.request(kind: kind, isCurrent: { true }, camera: { next in
                devices.append("camera"); next(true)
            }, microphone: { next in devices.append("microphone"); next(true) }, completion: { consent = $0 })
            XCTAssertEqual(consent, true)
            XCTAssertEqual(devices, kind == "cameraAndMicrophone" ? ["camera", "microphone"] : [kind])
        }
        for outcome in ["cameraDenied", "microphoneDenied", "navigation"] {
            var current = true, microphoneRequests = 0, consent: Bool?
            MediaCaptureAuthorization.request(kind: "cameraAndMicrophone", isCurrent: { current }, camera: { next in
                if outcome == "navigation" { current = false }
                next(outcome != "cameraDenied")
            }, microphone: { next in microphoneRequests += 1; next(false) }, completion: { consent = $0 })
            XCTAssertEqual(consent, false)
            XCTAssertEqual(microphoneRequests, outcome == "microphoneDenied" ? 1 : 0)
        }
        let request: [String: Any] = ["type": "speak", "id": "one", "text": "你好。", "rate": 1.0, "volume": 0.8]
        XCTAssertNotNil(SystemSpeechRequest(request))
        for invalid: [String: Any] in [["text": " "], ["text": String(repeating: "字", count: 1201)], ["id": ""], ["rate": Double.infinity], ["rate": 3.0], ["volume": -1.0], ["type": "unknown"]] {
            XCTAssertNil(SystemSpeechRequest(request.merging(invalid) { _, rhs in rhs }))
        }
        XCTAssertNotNil(SystemSpeechRequest(["type": "stop", "id": "one"]))
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
        try tests.testSavedServiceAddressesMigrateAddSelectAndDelete()
        try tests.testRememberOnlyUsefulDetailsAndNotificationScope()
        try tests.testLoginSessionOnlyStartsWithValidatedCallbackAndResets()
        try tests.testMediaCaptureAndSpeechRequests()
        tests.testResumeAndBoundedLedger()
        try tests.testNotificationValidationAndSanitizedDiagnostics()
        try checkHealthResponses()
        print("PASS: 7 core behavior groups")
    }
}
