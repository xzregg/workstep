import XCTest
import Network

final class WorkStepUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testEmptyAddressCannotSubmitAndInvalidAddressStaysEditable() {
        let app = XCUIApplication()
        app.launchArguments = ["-server", ""]
        app.launch()
        let address = app.textFields["serverAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        let connect = app.buttons["connectServer"]
        XCTAssertFalse(connect.isEnabled)
        address.tap(); address.typeText("not-a-url")
        XCTAssertTrue(connect.isEnabled)
        connect.tap()
        XCTAssertTrue(app.staticTexts["请输入 HTTP 或 HTTPS 服务根地址，不包含账号、路径或查询参数。"].waitForExistence(timeout: 3))
        XCTAssertTrue(address.isEnabled)
    }

    func testConnectWebViewAndToggleNativeNavigation() throws {
        let fixture = try WebFixture()
        defer { fixture.stop() }
        let ready = expectation(description: "fixture listening")
        fixture.start { ready.fulfill() }
        wait(for: [ready], timeout: 5)

        let app = XCUIApplication()
        app.launchArguments = ["-server", ""]
        addUIInterruptionMonitor(withDescription: "notification permission") { alert in
            for title in ["Don’t Allow", "Don't Allow", "不允许"] where alert.buttons[title].exists {
                alert.buttons[title].tap(); return true
            }
            return false
        }
        app.launch()
        let address = app.textFields["serverAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap(); address.typeText("http://127.0.0.1:\(fixture.port)")
        app.buttons["connectServer"].tap()
        let home = app.webViews.staticTexts["WorkStep 测试工作台"]
        XCTAssertTrue(home.waitForExistence(timeout: 15))
        let floating = app.buttons["navigationFloat"]
        floating.tap()
        // The first tap can be consumed by the notification permission interruption.
        let menu = app.webViews.staticTexts["测试项目导航"]
        if !menu.waitForExistence(timeout: 2) { floating.tap() }
        XCTAssertTrue(menu.waitForExistence(timeout: 3))
        floating.tap()
        XCTAssertTrue(menu.waitForNonExistence(timeout: 3))
        floating.press(forDuration: 1)
        XCTAssertTrue(app.buttons["查看日志"].waitForExistence(timeout: 3))
        app.buttons["查看日志"].tap()
        XCTAssertTrue(app.buttons["完成"].waitForExistence(timeout: 3))
        app.buttons["完成"].tap()
        XCTAssertTrue(home.exists)
    }

    func testAddSwitchAndDeleteServiceAddress() throws {
        let fixture = try WebFixture()
        defer { fixture.stop() }
        let ready = expectation(description: "fixture listening")
        fixture.start { ready.fulfill() }
        wait(for: [ready], timeout: 5)

        let app = XCUIApplication()
        app.launchArguments = ["-server", "", "-servers", ""]
        addUIInterruptionMonitor(withDescription: "notification permission") { alert in
            for title in ["Don’t Allow", "Don't Allow", "不允许"] where alert.buttons[title].exists {
                alert.buttons[title].tap(); return true
            }
            return false
        }
        app.launch()
        let address = app.textFields["serverAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap(); address.typeText("http://127.0.0.1:\(fixture.port)")
        app.buttons["addServer"].tap()
        XCTAssertTrue(app.buttons["savedServer-0"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.webViews.staticTexts["WorkStep 测试工作台"].exists)
        app.buttons["switchServer"].tap()
        XCTAssertTrue(app.webViews.staticTexts["WorkStep 测试工作台"].waitForExistence(timeout: 15))

        app.buttons["navigationFloat"].press(forDuration: 1)
        XCTAssertTrue(app.buttons["修改服务地址"].waitForExistence(timeout: 3))
        app.buttons["修改服务地址"].tap()
        XCTAssertTrue(app.buttons["savedServer-0"].waitForExistence(timeout: 3))
        app.buttons["deleteServer"].tap()
        XCTAssertFalse(app.buttons["savedServer-0"].exists)
    }
}

/// A loopback-only fixture in the test runner; no real projects, credentials or daemon.
private final class WebFixture {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "workstep.ios.ui-fixture")
    private var connections: [NWConnection] = []
    var port: UInt16 { listener.port!.rawValue }
    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }
    func start(ready: @escaping () -> Void) {
        listener.stateUpdateHandler = { state in if case .ready = state { ready() } }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.connections.append(connection)
            connection.start(queue: self.queue)
            self.receive(connection, accumulated: Data())
        }
        listener.start(queue: queue)
    }
    private func receive(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            guard let self else { return }
            let request = accumulated + (data ?? Data())
            if request.count > 16384 || error != nil { connection.cancel(); return }
            guard let text = String(data: request, encoding: .utf8), text.contains("\r\n\r\n") else {
                if complete { connection.cancel() } else { self.receive(connection, accumulated: request) }
                return
            }
            let health = text.hasPrefix("GET /api/health ")
            let body = health ? "{\"status\":\"ok\"}" : Self.page
            let bytes = Data(body.utf8)
            let headers = "HTTP/1.1 200 OK\r\nContent-Type: \(health ? "application/json" : "text/html; charset=utf-8")\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(headers.utf8) + bytes, completion: .contentProcessed { _ in connection.cancel() })
        }
    }
    func stop() { queue.sync { listener.cancel(); connections.forEach { $0.cancel() } } }
    private static let page = """
    <!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1">
    <body><main id="root"><h1>WorkStep 测试工作台</h1>
    <button aria-controls="workstep-navigation" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('workstep-navigation').hidden=false">打开导航</button>
    <aside id="workstep-navigation" hidden><p>测试项目导航</p>
    <button class="navigation-close" onclick="this.parentElement.hidden=true;document.querySelector('[aria-controls]').setAttribute('aria-expanded','false')">关闭导航</button></aside>
    </main></body></html>
    """
}
