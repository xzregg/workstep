import Foundation
import WorkStepCore

private final class HealthProtocol: URLProtocol {
    static var status = 200
    static var payload = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        precondition(request.url?.path == "/api/health")
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.payload)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

func checkHealthResponses() throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [HealthProtocol.self]
    let health = HealthClient(configuration: configuration)
    for (status, body, expected) in [(200, "{\"status\":\"ok\"}", true), (401, "{\"status\":\"ok\"}", false),
                                    (200, "<html>login</html>", false), (200, "{\"status\":\"error\"}", false),
                                    (302, "{\"status\":\"ok\"}", false), (200, String(repeating: " ", count: 70000), false)] {
        HealthProtocol.status = status; HealthProtocol.payload = Data(body.utf8)
        let done = DispatchSemaphore(value: 0)
        _ = health.check(try ServerAddress("https://host")) { accepted in
            precondition(accepted == expected); done.signal()
        }
        precondition(done.wait(timeout: .now() + 5) == .success)
    }
    let session = URLSession(configuration: .ephemeral)
    let task = session.dataTask(with: URL(string: "https://host")!)
    let redirect = HTTPURLResponse(url: URL(string: "https://host/api/health")!, statusCode: 302, httpVersion: nil, headerFields: nil)!
    health.urlSession(session, task: task, willPerformHTTPRedirection: redirect,
                      newRequest: URLRequest(url: URL(string: "https://other")!)) { precondition($0 == nil) }
    session.invalidateAndCancel()
    print("PASS: health validation, malformed responses, limits and redirects")
}
