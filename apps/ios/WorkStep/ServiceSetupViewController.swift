import UIKit

final class ServiceSetupViewController: UIViewController, UITextFieldDelegate {
    var onConnect: ((ServerAddress) -> Void)?
    var onDeleteActive: (() -> Void)?
    private var draftBaseline: String
    private var activeOrigin: String?
    private var book: ServerAddressBook
    private var selectedOrigin: String?
    private let defaults = UserDefaults.standard
    private let address = UITextField()
    private let errorLabel = UILabel()
    private let connect = UIButton(type: .system)
    private let addAddress = UIButton(type: .system)
    private let switchAddress = UIButton(type: .system)
    private let deleteAddress = UIButton(type: .system)
    private let savedTitle = UILabel()
    private let savedStack = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var request: URLSessionDataTask?
    private var cancelled = false
    private let client = HealthClient()

    init(initial: String) {
        draftBaseline = initial
        activeOrigin = initial.isEmpty ? nil : initial
        book = ServerAddressBook(stored: UserDefaults.standard.stringArray(forKey: "servers") ?? [], active: activeOrigin)
        selectedOrigin = book.origins.contains(initial) ? initial : nil
        super.init(nibName: nil, bundle: nil)
        address.text = initial
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { request?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "连接 WorkStep"; view.backgroundColor = .systemBackground
        isModalInPresentation = true
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "取消", style: .plain, target: self, action: #selector(cancel))
        let title = UILabel(); title.text = "WorkStep"; title.font = .preferredFont(forTextStyle: .largeTitle)
        let hint = UILabel(); hint.numberOfLines = 0
        hint.text = "输入电脑或服务器的服务根地址。手机需能访问该地址。HTTP 连接不加密，录音请使用 HTTPS。"
        hint.font = .preferredFont(forTextStyle: .body)
        address.placeholder = "https://workstep.example.com"
        address.borderStyle = .roundedRect; address.keyboardType = .URL; address.textContentType = .URL
        address.autocapitalizationType = .none; address.autocorrectionType = .no; address.clearButtonMode = .whileEditing
        address.returnKeyType = .go; address.delegate = self; address.accessibilityIdentifier = "serverAddress"
        address.addTarget(self, action: #selector(changed), for: .editingChanged)
        errorLabel.numberOfLines = 0; errorLabel.textColor = .systemRed; errorLabel.font = .preferredFont(forTextStyle: .footnote)
        connect.setTitle("连接", for: .normal); connect.configuration = .filled(); connect.accessibilityIdentifier = "connectServer"
        connect.addTarget(self, action: #selector(submit), for: .touchUpInside)
        addAddress.setTitle("新增地址", for: .normal); addAddress.configuration = .bordered()
        addAddress.accessibilityIdentifier = "addServer"; addAddress.addTarget(self, action: #selector(addSavedAddress), for: .touchUpInside)
        savedTitle.text = "已保存的地址"; savedTitle.font = .preferredFont(forTextStyle: .headline)
        savedStack.axis = .vertical; savedStack.spacing = 8
        switchAddress.setTitle("切换到所选地址", for: .normal); switchAddress.configuration = .filled()
        switchAddress.accessibilityIdentifier = "switchServer"; switchAddress.addTarget(self, action: #selector(switchSavedAddress), for: .touchUpInside)
        deleteAddress.setTitle("删除所选地址", for: .normal); deleteAddress.configuration = .bordered()
        deleteAddress.accessibilityIdentifier = "deleteServer"; deleteAddress.addTarget(self, action: #selector(deleteSavedAddress), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, hint, address, connect, addAddress, errorLabel,
                                                    savedTitle, savedStack, switchAddress, deleteAddress, spinner])
        stack.axis = .vertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll); scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 32),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
            address.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            errorLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        for button in [connect, addAddress, switchAddress, deleteAddress] {
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        }
        renderSavedAddresses()
    }

    @objc private func changed() { updateButtons() }
    private func updateButtons() {
        let ready = request == nil
        let hasInput = !(address.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        connect.isEnabled = ready && hasInput
        addAddress.isEnabled = ready && hasInput
        switchAddress.isEnabled = ready && selectedOrigin != nil
        deleteAddress.isEnabled = ready && selectedOrigin != nil
    }
    private func renderSavedAddresses() {
        for row in savedStack.arrangedSubviews { savedStack.removeArrangedSubview(row); row.removeFromSuperview() }
        for (index, origin) in book.origins.enumerated() {
            let row = UIButton(type: .system)
            var config = UIButton.Configuration.plain()
            config.title = origin
            config.image = UIImage(systemName: selectedOrigin == origin ? "largecircle.fill.circle" : "circle")
            config.imagePadding = 12
            row.configuration = config
            row.contentHorizontalAlignment = .leading
            row.titleLabel?.lineBreakMode = .byTruncatingMiddle
            row.accessibilityLabel = origin
            row.accessibilityValue = selectedOrigin == origin ? "已选择" : "未选择"
            row.accessibilityIdentifier = "savedServer-\(index)"
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
            row.addAction(UIAction { [weak self] _ in
                self?.selectedOrigin = origin
                self?.renderSavedAddresses()
            }, for: .touchUpInside)
            savedStack.addArrangedSubview(row)
        }
        let hasSaved = !book.origins.isEmpty
        savedTitle.isHidden = !hasSaved
        savedStack.isHidden = !hasSaved
        switchAddress.isHidden = !hasSaved
        deleteAddress.isHidden = !hasSaved
        updateButtons()
    }
    @objc private func addSavedAddress() {
        guard request == nil else { return }
        do {
            let candidate = try ServerAddress(address.text ?? "")
            guard try book.add(candidate.origin) else { errorLabel.text = "这个地址已保存"; return }
            defaults.set(book.origins, forKey: "servers")
            selectedOrigin = candidate.origin
            address.text = candidate.origin
            draftBaseline = candidate.origin
            errorLabel.text = nil
            renderSavedAddresses()
        } catch { errorLabel.text = error.localizedDescription; address.becomeFirstResponder() }
    }
    @objc private func switchSavedAddress() {
        guard let selectedOrigin, let server = try? ServerAddress(selectedOrigin) else { return }
        checkAndConnect(server)
    }
    @objc private func deleteSavedAddress() {
        guard request == nil, let selectedOrigin else { return }
        book.remove(selectedOrigin)
        defaults.set(book.origins, forKey: "servers")
        if selectedOrigin == activeOrigin {
            activeOrigin = nil
            defaults.removeObject(forKey: "server")
            onDeleteActive?()
        }
        if address.text == selectedOrigin { address.text = ""; draftBaseline = "" }
        self.selectedOrigin = book.origins.first
        errorLabel.text = nil
        renderSavedAddresses()
    }
    @objc private func cancel() {
        if (address.text ?? "") != draftBaseline {
            let alert = UIAlertController(title: "放弃地址修改？", message: nil, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "继续编辑", style: .cancel))
            alert.addAction(UIAlertAction(title: "放弃", style: .destructive) { [weak self] _ in self?.cancelled = true; self?.request?.cancel(); self?.dismiss(animated: true) })
            present(alert, animated: true)
        } else { cancelled = true; request?.cancel(); dismiss(animated: true) }
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { if connect.isEnabled { submit() }; return true }
    @objc private func submit() {
        guard request == nil else { return }
        do { checkAndConnect(try ServerAddress(address.text ?? "")) }
        catch { errorLabel.text = error.localizedDescription; address.becomeFirstResponder() }
    }
    private func checkAndConnect(_ server: ServerAddress) {
        guard request == nil else { return }
        errorLabel.text = nil; spinner.startAnimating(); address.isEnabled = false
        request = client.check(server) { [weak self] valid in
            DispatchQueue.main.async {
                guard let self, !self.cancelled else { return }
                self.request = nil; self.spinner.stopAnimating(); self.address.isEnabled = true; self.updateButtons()
                if valid { self.onConnect?(server); self.dismiss(animated: true) }
                else { self.errorLabel.text = "连接失败：请检查服务地址、网络、局域网权限和证书，再重试。" }
            }
        }
        updateButtons()
    }
}
