import UIKit
import WebKit
import AVFoundation

final class BrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let defaults = UserDefaults.standard
    private let diagnostics = Diagnostics()
    lazy var notifications = CompletionNotifications(diagnostics: diagnostics)
    private let downloads = DownloadCoordinator()
    private var server: ServerAddress?
    private var policy: NavigationPolicy?
    private var webView: WKWebView?
    private var urlObservation: NSKeyValueObservation?
    private var navigationDeadline: DispatchWorkItem?
    private var renderCheck: DispatchWorkItem?
    private var backgroundAt: Date?
    private var openingNotification = false
    private var pendingNotification: URL?
    private var recoveredCrash = false
    private var checkingPage = false
    private let floating = UIButton(type: .system)
    private var floatX: NSLayoutConstraint!
    private var floatY: NSLayoutConstraint!
    private let statusPanel = UIStackView()
    private let statusLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let retry = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        configureStatus(); configureFloatingButton()
        downloads.presenter = self
        downloads.onError = { [weak self] in self?.showMessage("文件保存失败，请重试；同时只能保存一个文件。") }
        notifications.currentPage = { [weak self] in self?.webView?.url }
        notifications.onOpen = { [weak self] url in self?.openNotification(url) }
        if let raw = defaults.string(forKey: "server"), let server = try? ServerAddress(raw) { connect(server) }
        else { setStatus("连接你的 WorkStep 服务", loading: false) }
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if server == nil && presentedViewController == nil { showSetup() }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); clampFloatingButton() }

    private func configureStatus() {
        statusPanel.axis = .vertical; statusPanel.spacing = 16; statusPanel.alignment = .fill
        statusPanel.backgroundColor = .systemBackground; statusPanel.isLayoutMarginsRelativeArrangement = true
        statusPanel.layoutMargins = UIEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        statusPanel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.numberOfLines = 0; statusLabel.textAlignment = .center; statusLabel.font = .preferredFont(forTextStyle: .body)
        retry.setTitle("重试", for: .normal); retry.addTarget(self, action: #selector(reload), for: .touchUpInside)
        let devices = UIButton(type: .system); devices.setTitle("返回设备列表", for: .normal)
        devices.addTarget(self, action: #selector(openDevices), for: .touchUpInside)
        let logs = UIButton(type: .system); logs.setTitle("查看日志", for: .normal); logs.addTarget(self, action: #selector(showDiagnostics), for: .touchUpInside)
        for item in [spinner, statusLabel, retry, devices, logs] { statusPanel.addArrangedSubview(item) }
        for button in [retry, devices, logs] { button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true }
        view.addSubview(statusPanel)
        NSLayoutConstraint.activate([
            statusPanel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            statusPanel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            statusPanel.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor)
        ])
    }
    private func configureFloatingButton() {
        floating.setImage(UIImage(systemName: "line.3.horizontal"), for: .normal)
        floating.backgroundColor = .secondarySystemBackground; floating.tintColor = .label
        floating.layer.cornerRadius = 24; floating.layer.borderWidth = 0.5; floating.layer.borderColor = UIColor.separator.cgColor
        floating.accessibilityLabel = "导航菜单"; floating.accessibilityHint = "轻点切换导航，长按打开连接设置，可拖动位置"
        floating.accessibilityIdentifier = "navigationFloat"
        floating.addTarget(self, action: #selector(toggleNavigation), for: .touchUpInside)
        floating.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(longPress(_:))))
        floating.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(drag(_:))))
        floating.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(floating)
        floatX = floating.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 32)
        floatY = floating.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 180)
        NSLayoutConstraint.activate([floatX, floatY, floating.widthAnchor.constraint(equalToConstant: 48), floating.heightAnchor.constraint(equalToConstant: 48)])
        floating.accessibilityCustomActions = [UIAccessibilityCustomAction(name: "连接设置", target: self, selector: #selector(accessibleMenu))]
    }
    private func clampFloatingButton() {
        let size = view.safeAreaLayoutGuide.layoutFrame.size
        guard size.width > 0, size.height > 0 else { return }
        let x = defaults.object(forKey: "floatX") as? Double ?? 0.09
        let y = defaults.object(forKey: "floatY") as? Double ?? 0.35
        floatX.constant = max(32, min(size.width - 32, size.width * x))
        floatY.constant = max(32, min(size.height - 32, size.height * y))
    }
    @objc private func drag(_ gesture: UIPanGestureRecognizer) {
        let size = view.safeAreaLayoutGuide.layoutFrame.size, delta = gesture.translation(in: view)
        guard size.width > 0, size.height > 0 else { return }
        defaults.set(max(32, min(size.width - 32, floatX.constant + delta.x)) / size.width, forKey: "floatX")
        defaults.set(max(32, min(size.height - 32, floatY.constant + delta.y)) / size.height, forKey: "floatY")
        gesture.setTranslation(.zero, in: view); clampFloatingButton()
    }
    @objc private func longPress(_ gesture: UILongPressGestureRecognizer) { if gesture.state == .began { showMenu() } }
    @objc private func accessibleMenu() -> Bool { showMenu(); return true }
    @objc private func toggleNavigation() {
        guard let server, let url = webView?.url, server.contains(url), statusPanel.isHidden else { showMenu(); return }
        guard let path = Bundle.main.url(forResource: "navigation", withExtension: "js"),
              let script = try? String(contentsOf: path) else { showMenu(); return }
        webView?.evaluateJavaScript(script) { [weak self] value, _ in if value as? Bool != true { self?.showMenu() } }
    }
    private func showMenu() {
        guard presentedViewController == nil else { return }
        let menu = UIAlertController(title: "WorkStep", message: "后台即时通知尚未接入；返回前台后恢复消息。", preferredStyle: .actionSheet)
        for (name, action) in [("修改服务地址", { self.showSetup() }), ("重新加载", { self.reload() }),
                               ("清除网页缓存", { self.clearCache() }), ("返回设备列表", { self.openDevices() }),
                               ("查看日志", { self.showDiagnostics() }), ("发送测试通知", { self.notifications.sendTest() })] {
            menu.addAction(UIAlertAction(title: name, style: .default) { _ in action() })
        }
        menu.addAction(UIAlertAction(title: "取消", style: .cancel))
        menu.popoverPresentationController?.sourceView = floating; menu.popoverPresentationController?.sourceRect = floating.bounds
        present(menu, animated: true)
    }
    @objc private func showSetup() {
        guard presentedViewController == nil else { return }
        let setup = ServiceSetupViewController(initial: server?.origin ?? "")
        setup.onConnect = { [weak self] server in self?.connect(server) }
        present(UINavigationController(rootViewController: setup), animated: true)
    }
    private func connect(_ server: ServerAddress) {
        navigationDeadline?.cancel(); renderCheck?.cancel(); downloads.cancel()
        checkingPage = false
        webView?.navigationDelegate = nil; webView?.uiDelegate = nil
        webView?.stopLoading(); webView?.configuration.userContentController.removeScriptMessageHandler(forName: "workstep")
        webView?.removeFromSuperview(); urlObservation = nil
        pendingNotification = nil; openingNotification = false
        self.server = server; policy = NavigationPolicy(server: server)
        notifications.server = server; downloads.server = server
        defaults.set(server.origin, forKey: "server"); recoveredCrash = false
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default(); configuration.allowsInlineMediaPlayback = true
        configuration.applicationNameForUserAgent = "WorkStep/iOS"
        let controller = configuration.userContentController
        controller.add(WeakScriptHandler(self), name: "workstep")
        if let path = Bundle.main.url(forResource: "bridge", withExtension: "js"), let source = try? String(contentsOf: path),
           let encoded = try? JSONSerialization.data(withJSONObject: [server.origin]), let array = String(data: encoded, encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: "const __workstepOrigin = \(array)[0];\n" + source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self; web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false; view.insertSubview(web, at: 0)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        webView = web
        urlObservation = web.observe(\.url, options: [.new]) { [weak self] _, change in
            guard let self, let url = change.newValue ?? nil, server.shouldRemember(url) else { return }
            self.defaults.set(url.absoluteString, forKey: "page:" + server.origin)
        }
        let remembered = defaults.string(forKey: "page:" + server.origin).flatMap(URL.init(string:))
        web.load(URLRequest(url: remembered.flatMap { server.shouldRemember($0) ? $0 : nil } ?? server.root))
        notifications.requestPermission()
    }
    @objc private func reload() {
        guard let server else { showSetup(); return }
        recoveredCrash = false
        if webView?.url == nil { webView?.load(URLRequest(url: server.root)) } else { webView?.reload() }
    }
    @objc private func openDevices() {
        guard let server else { return }
        policy = NavigationPolicy(server: server)
        webView?.load(URLRequest(url: server.root.appendingPathComponent("devices")))
    }
    private func clearCache() {
        let types: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
        WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in self?.reload() }
    }
    @objc private func showDiagnostics() {
        let controller = DiagnosticsViewController(diagnostics: diagnostics)
        present(UINavigationController(rootViewController: controller), animated: true)
    }
    private func setStatus(_ message: String, loading: Bool) {
        statusLabel.text = message; statusPanel.isHidden = false; retry.isHidden = loading
        loading ? spinner.startAnimating() : spinner.stopAnimating()
    }
    private func showMessage(_ message: String) {
        guard presentedViewController == nil else { diagnostics.record("文件操作未完成"); return }
        let alert = UIAlertController(title: "WorkStep", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "知道了", style: .default)); present(alert, animated: true)
    }
    func enteredBackground() { backgroundAt = Date() }
    func becameActive() {
        guard let backgroundAt else { return }
        self.backgroundAt = nil
        if openingNotification { return }
        if ClientPolicy.shouldReload(backgroundSeconds: Date().timeIntervalSince(backgroundAt), openingNotification: false) { reload() }
        else { webView?.evaluateJavaScript("window.dispatchEvent(new Event('workstep:resume'))") }
    }
    private func openNotification(_ url: URL) {
        openingNotification = true
        if webView?.isLoading == true { pendingNotification = url; return }
        navigateToNotification(url)
    }
    private func navigateToNotification(_ url: URL) {
        guard let server, server.shouldRemember(url), let web = webView else { openingNotification = false; return }
        guard let data = try? JSONSerialization.data(withJSONObject: [url.absoluteString]), let json = String(data: data, encoding: .utf8) else { openingNotification = false; return }
        if let current = web.url, server.contains(current) {
            let script = "(()=>{const detail={url:\(json)[0],handled:false};window.dispatchEvent(new CustomEvent('workstep:open-notification',{detail}));return detail.handled})()"
            web.evaluateJavaScript(script) { [weak self] result, _ in
                guard let self, self.server == server else { return }
                if result as? Bool == true { self.openingNotification = false }
                else { web.load(URLRequest(url: url)) }
            }
        } else { web.load(URLRequest(url: url)) }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        checkingPage = true
        if let url = webView.url { policy?.didStart(url) }
        navigationDeadline?.cancel(); renderCheck?.cancel()
        setStatus("正在连接…", loading: true)
        let deadline = DispatchWorkItem { [weak self] in
            self?.checkingPage = false
            self?.renderCheck?.cancel(); self?.setStatus("页面加载超时，请重试或返回设备列表。", loading: false)
            self?.diagnostics.record("页面加载超时")
        }
        navigationDeadline = deadline; DispatchQueue.main.asyncAfter(deadline: .now() + 180, execute: deadline)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        diagnostics.record("页面加载完成")
        if let pendingNotification { self.pendingNotification = nil; navigateToNotification(pendingNotification); return }
        openingNotification = false
        checkRendered(webView)
    }
    private func checkRendered(_ web: WKWebView) {
        guard checkingPage, let url = web.url else { return }
        if server?.contains(url) != true { pageReady(); return }
        web.evaluateJavaScript("!!document.getElementById('root')?.childElementCount") { [weak self, weak web] result, _ in
            guard let self, self.checkingPage, let web, web === self.webView, web.url == url else { return }
            if result as? Bool == true { self.pageReady() }
            else {
                let check = DispatchWorkItem { [weak self, weak web] in if let web { self?.checkRendered(web) } }
                self.renderCheck = check; DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: check)
            }
        }
    }
    private func pageReady() { checkingPage = false; navigationDeadline?.cancel(); renderCheck?.cancel(); spinner.stopAnimating(); statusPanel.isHidden = true }
    private func failed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        checkingPage = false; navigationDeadline?.cancel(); renderCheck?.cancel(); openingNotification = false
        diagnostics.record("页面加载失败", code: (error as NSError).code)
        setStatus("页面加载失败，请检查网络、服务地址和证书后重试。", loading: false)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        diagnostics.record("网页进程退出")
        if !recoveredCrash { recoveredCrash = true; webView.reload() }
        else { setStatus("网页进程已退出，请重新加载。", loading: false) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let server else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if action.shouldPerformDownload {
            let trusted = server.contains(url) || (url.scheme == "blob" && url.absoluteString.hasPrefix("blob:" + server.origin + "/"))
            decisionHandler(trusted ? .download : .cancel); return
        }
        if let rewritten = policy?.rewrittenReturn(url) { decisionHandler(.cancel); webView.load(URLRequest(url: rewritten)); return }
        if policy?.allows(url) == true { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if ["http", "https"].contains(url.scheme ?? ""), url.user == nil, url.password == nil,
           action.navigationType == .linkActivated { UIApplication.shared.open(url) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            decisionHandler(.cancel); failed(NSError(domain: "HTTP", code: http.statusCode)); return
        }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { pageReady(); downloads.accept(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { pageReady(); downloads.accept(download) }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil, let url = action.request.url, policy?.allows(url) == true { webView.load(action.request) }
        return nil
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard type == .microphone, frame.isMainFrame, let url = frame.request.url, server?.contains(url) == true,
              let current = webView.url, server?.contains(current) == true, origin.protocol == "https",
              origin.host.lowercased() == current.host?.lowercased(), (origin.port == (current.port ?? 443) || (origin.port == 0 && current.port == nil)) else { decisionHandler(.deny); return }
        let authorizedServer = server
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self, weak webView] granted in
            DispatchQueue.main.async {
                let stillValid = self?.server == authorizedServer && webView?.url == current && UIApplication.shared.applicationState != .background
                decisionHandler(granted && stillValid ? .grant : .deny)
            }
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let source = message.frameInfo.request.url, server?.contains(source) == true,
              let current = webView?.url, server?.contains(current) == true,
              let object = message.body as? [String: Any] else { return }
        if object["type"] as? String == "notify" { notifications.receive(object) }
        else if object["type"] as? String == "diagnostic", let code = object["code"] as? String,
                ["TypeError", "SyntaxError", "ReferenceError", "RangeError", "resource-error", "unhandled-rejection", "csp"].contains(code) {
            diagnostics.record("网页诊断：" + code)
        }
    }
}

private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
