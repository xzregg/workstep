import AVFoundation

private final class SystemUtterance: AVSpeechUtterance {
    let completionToken = UUID()
}

/** Per-utterance native acknowledgements shared with the Android web protocol. */
@MainActor final class SystemSpeech: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var current: (id: String, utterance: SystemUtterance, reply: ([String: String]) -> Void)?

    override init() {
        super.init()
        // Let WebKit own recording; speech manages a separate system audio session.
        synthesizer.usesApplicationAudioSession = false
        synthesizer.delegate = self
    }

    deinit { synthesizer.stopSpeaking(at: .immediate) }

    func handle(_ value: [String: Any], reply: @escaping ([String: String]) -> Void) {
        guard let request = SystemSpeechRequest(value) else {
            if let id = value["id"] as? String, !id.isEmpty, id.count <= 128 {
                reply(["id": id, "status": "error", "error": "Invalid speech parameters"])
            }
            return
        }
        if request.type == "stop" {
            if current?.id == request.id { stop() }
            return
        }
        guard current == nil else {
            reply(["id": request.id, "status": "error", "error": "Stop the current system speech playback first"]); return
        }
        guard let voice = AVSpeechSynthesisVoice(language: "zh-CN") else {
            reply(["id": request.id, "status": "error", "error": "Install a Chinese voice in System Settings"]); return
        }
        let utterance = SystemUtterance(string: request.text)
        utterance.voice = voice
        utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(request.rate)))
        utterance.volume = Float(request.volume)
        current = (request.id, utterance, reply)
        synthesizer.speak(utterance)
    }

    func stop() {
        let pending = current
        current = nil
        synthesizer.stopSpeaking(at: .immediate)
        if let pending { pending.reply(["id": pending.id, "status": "done"]) }
    }

    private func finish(_ token: UUID) {
        guard let pending = current, pending.utterance.completionToken == token else { return }
        current = nil
        pending.reply(["id": pending.id, "status": "done"])
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard let token = (utterance as? SystemUtterance)?.completionToken else { return }
        DispatchQueue.main.async { [weak self] in self?.finish(token) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard let token = (utterance as? SystemUtterance)?.completionToken else { return }
        DispatchQueue.main.async { [weak self] in self?.finish(token) }
    }
}
