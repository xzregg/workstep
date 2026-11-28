import UIKit
import AVFoundation

final class P2pScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    var onScan: ((String) -> Void)?
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "workstep.p2p-scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private let cameraView = UIView()
    private let message = UILabel()
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "扫码添加 P2P 设备"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "取消", style: .plain,
                                                            target: self, action: #selector(cancel))
        message.text = "将 WorkStep 配对码放入取景框"
        message.textColor = .secondaryLabel
        message.textAlignment = .center
        message.numberOfLines = 0
        cameraView.backgroundColor = UIColor(red: 0.06, green: 0.18, blue: 0.31, alpha: 1)
        cameraView.layer.cornerRadius = 12
        cameraView.clipsToBounds = true
        cameraView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cameraView)
        message.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(message)
        NSLayoutConstraint.activate([
            cameraView.widthAnchor.constraint(equalToConstant: 210),
            cameraView.heightAnchor.constraint(equalToConstant: 210),
            cameraView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cameraView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            message.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            message.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            message.topAnchor.constraint(equalTo: cameraView.bottomAnchor, constant: 14)
        ])
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: startScanner()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
                DispatchQueue.main.async { allowed ? self?.startScanner() : self?.showDenied() }
            }
        default: showDenied()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = cameraView.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    private func startScanner() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
            message.text = "无法打开相机，请粘贴配对链接"
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            message.text = "无法扫描二维码，请粘贴配对链接"
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        cameraView.layer.insertSublayer(layer, at: 0)
        preview = layer
        layer.frame = cameraView.bounds
        sessionQueue.async { [session] in session.startRunning() }
    }

    private func showDenied() { message.text = "请在系统设置中允许相机，或粘贴配对链接" }
    @objc private func cancel() { dismiss(animated: true) }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !finished, let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        finished = true
        dismiss(animated: true) { [weak self] in self?.onScan?(value) }
    }
}
