import UIKit
import WebKit

final class DownloadCoordinator: NSObject, WKDownloadDelegate, UIDocumentPickerDelegate {
    weak var presenter: UIViewController?
    var server: ServerAddress?
    var onError: (() -> Void)?
    private var active: WKDownload?
    private var file: URL?
    private var directory: URL?

    func accept(_ download: WKDownload) {
        guard active == nil, file == nil else { download.cancel { _ in }; onError?(); return }
        active = download; download.delegate = self
    }
    func cancel() { active?.cancel { _ in }; clean() }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard download === active else { completionHandler(nil); return }
        guard let url = response.url, let server,
              server.contains(url) || (url.scheme == "blob" && url.absoluteString.hasPrefix("blob:" + server.origin + "/")) else {
            completionHandler(nil); clean(); onError?(); return
        }
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("workstep-download-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = (suggestedFilename as NSString).lastPathComponent
            let safeName = name.isEmpty || name == "." || name == ".." ? "download" : name
            let file = directory.appendingPathComponent(safeName)
            self.directory = directory; self.file = file; completionHandler(file)
        } catch { completionHandler(nil); clean(); onError?() }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard download === active else { decisionHandler(.cancel); return }
        decisionHandler(request.url.map { server?.contains($0) == true } == true ? .allow : .cancel)
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard download === active else { return }
        active = nil
        guard let file, let presenter, presenter.presentedViewController == nil else { clean(); onError?(); return }
        let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        picker.delegate = self; presenter.present(picker, animated: true)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { guard download === active else { return }; clean(); onError?() }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { clean() }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { clean() }
    private func clean() {
        if let directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil; file = nil; active = nil
    }
}
