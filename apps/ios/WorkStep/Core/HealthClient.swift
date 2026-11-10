import Foundation

// Do not follow health redirects to a login page or an unrelated service.
public final class HealthClient: NSObject, URLSessionTaskDelegate {
    private let configuration: URLSessionConfiguration
    public init(configuration: URLSessionConfiguration = .ephemeral) { self.configuration = configuration; super.init() }
    public func check(_ server: ServerAddress, completion: @escaping (Bool) -> Void) -> URLSessionDataTask {
        var request = URLRequest(url: server.root.appendingPathComponent("api/health")); request.timeoutInterval = 15
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            guard error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let data, data.count <= 65536, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["status"] as? String == "ok" else { completion(false); return }
            completion(true)
        }
        task.resume(); return task
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
