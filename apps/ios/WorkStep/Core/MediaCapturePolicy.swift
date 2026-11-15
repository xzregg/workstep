import Foundation

public enum MediaCapturePolicy {
    public static func allows(server: ServerAddress, page: URL, frame: URL, origin: URL, mainFrame: Bool, kind: String) -> Bool {
        guard mainFrame, ["camera", "microphone", "cameraAndMicrophone"].contains(kind),
              server.contains(page), server.contains(frame), server.contains(origin) else { return false }
        let loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(page.host?.lowercased() ?? "")
        return page.scheme?.lowercased() == "https" || loopback
    }
}

public struct SystemSpeechRequest {
    public let id: String
    public let type: String
    public let text: String
    public let rate: Double
    public let volume: Double

    public init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, !id.isEmpty, id.count <= 128,
              let type = value["type"] as? String, ["speak", "stop"].contains(type) else { return nil }
        self.id = id; self.type = type
        if type == "stop" { text = ""; rate = 1; volume = 1; return }
        guard let text = value["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf16.count <= 1200,
              let rate = value["rate"] as? Double, rate.isFinite, (0.5...2).contains(rate),
              let volume = value["volume"] as? Double, volume.isFinite, (0...1).contains(volume) else { return nil }
        self.text = text; self.rate = rate; self.volume = volume
    }
}

/// Request only the devices used by this capture, and recheck navigation between dialogs.
public enum MediaCaptureAuthorization {
    public static func request(kind: String, isCurrent: @escaping () -> Bool,
                               camera: @escaping (@escaping (Bool) -> Void) -> Void,
                               microphone: @escaping (@escaping (Bool) -> Void) -> Void,
                               completion: @escaping (Bool) -> Void) {
        guard isCurrent() else { completion(false); return }
        switch kind {
        case "camera": camera { completion($0 && isCurrent()) }
        case "microphone": microphone { completion($0 && isCurrent()) }
        case "cameraAndMicrophone":
            camera { granted in
                guard granted && isCurrent() else { completion(false); return }
                microphone { completion($0 && isCurrent()) }
            }
        default: completion(false)
        }
    }
}
