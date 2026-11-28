import UIKit

final class ServiceSetupViewController: UIViewController, UITextFieldDelegate {
    var onConnect: ((ServerAddress) -> Void)?
    var onP2pConnect: ((P2pConnection) -> Void)?
    var onDeleteActive: (() -> Void)?
    private var draftBaseline: String
    private var activeOrigin: String?
    private var book: ServerAddressBook
    private var selectedOrigin: String?
    private let defaults = UserDefaults.standard
    private let p2pStore = P2pStore()
    private var activeP2p: P2pConnection?
    private var selectedP2p: String?
    private let p2pSavedStack = UIStackView()
    private let p2pSavedCard = UIStackView()
    private let p2pSwitch = UIButton(type: .system)
    private let p2pLink = UITextField()
    private let p2pSave = UIButton(type: .system)
    private let p2pErrorLabel = UILabel()
    private let p2pPanel = UIStackView()
    private let gatewayPanel = UIStackView()
    private let activeTypeLabel = UILabel()
    private let activeNameLabel = UILabel()
    private let activeURLLabel = UILabel()
    private let address = UITextField()
    private let errorLabel = UILabel()
    private let connect = UIButton(type: .system)
    private let addAddress = UIButton(type: .system)
    private let switchAddress = UIButton(type: .system)
    private let savedTitle = UILabel()
    private let savedStack = UIStackView()
    private let savedCard = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var request: URLSessionDataTask?
    private var cancelled = false
    private let client = HealthClient()

    init(initial: String, activeP2p: P2pConnection? = nil) {
        draftBaseline = initial
        self.activeP2p = activeP2p
        selectedP2p = activeP2p?.entryURL.absoluteString
        activeOrigin = initial.isEmpty ? nil : initial
        book = ServerAddressBook(stored: UserDefaults.standard.stringArray(forKey: "servers") ?? [],
                                 active: activeP2p == nil ? activeOrigin : nil)
        selectedOrigin = book.origins.contains(initial) ? initial : nil
        super.init(nibName: nil, bundle: nil)
        address.text = initial
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { request?.cancel() }

    private func text(_ value: String, size: CGFloat, weight: UIFont.Weight = .regular,
                      color: UIColor = .label) -> UILabel {
        let label = UILabel()
        label.text = value
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.lineBreakMode = .byTruncatingMiddle
        return label
    }

    private func column(_ views: [UIView] = [], spacing: CGFloat = 0) -> UIStackView {
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .vertical
        stack.spacing = spacing
        return stack
    }

    private func card(_ views: [UIView], padding: CGFloat = 13, spacing: CGFloat = 10) -> UIStackView {
        let stack = column(views, spacing: spacing)
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: padding, left: padding, bottom: padding, right: padding)
        stack.backgroundColor = .white
        stack.layer.cornerRadius = 14
        stack.layer.borderWidth = 1 / UIScreen.main.scale
        stack.layer.borderColor = UIColor(red: 0.88, green: 0.91, blue: 0.94, alpha: 1).cgColor
        return stack
    }

    private func button(_ title: String, primary: Bool = false) -> UIButton {
        let result = UIButton(type: .system)
        result.setTitle(title, for: .normal)
        result.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
        result.setTitleColor(primary ? .white : UIColor(red: 0.07, green: 0.39, blue: 0.77, alpha: 1), for: .normal)
        result.backgroundColor = primary ? UIColor(red: 0.04, green: 0.41, blue: 0.82, alpha: 1) : .white
        result.layer.cornerRadius = 10
        result.layer.borderWidth = primary ? 0 : 1 / UIScreen.main.scale
        result.layer.borderColor = UIColor(red: 0.79, green: 0.84, blue: 0.89, alpha: 1).cgColor
        result.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        return result
    }

    private func field(_ input: UITextField, hint: String, id: String) {
        input.placeholder = hint
        input.font = .systemFont(ofSize: 12)
        input.backgroundColor = .white
        input.layer.cornerRadius = 10
        input.layer.borderWidth = 1 / UIScreen.main.scale
        input.layer.borderColor = UIColor(red: 0.83, green: 0.86, blue: 0.90, alpha: 1).cgColor
        input.setLeftPaddingPoints(11)
        input.keyboardType = .URL
        input.textContentType = .URL
        input.autocapitalizationType = .none
        input.autocorrectionType = .no
        input.clearButtonMode = .whileEditing
        input.accessibilityIdentifier = id
        input.heightAnchor.constraint(equalToConstant: 44).isActive = true
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "连接 WorkStep"
        view.backgroundColor = UIColor(red: 0.96, green: 0.97, blue: 0.98, alpha: 1)
        isModalInPresentation = true
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "返回", style: .plain,
                                                            target: self, action: #selector(cancel))
        for (label, size, weight, color) in [
            (activeTypeLabel, CGFloat(11), UIFont.Weight.regular, UIColor.white.withAlphaComponent(0.82)),
            (activeNameLabel, CGFloat(16), UIFont.Weight.bold, UIColor.white),
            (activeURLLabel, CGFloat(11), UIFont.Weight.regular, UIColor.white.withAlphaComponent(0.84))
        ] {
            label.font = .systemFont(ofSize: size, weight: weight)
            label.textColor = color
            label.lineBreakMode = .byTruncatingMiddle
        }
        refreshActiveCard()
        let activeCard = card([
            activeTypeLabel, activeNameLabel, activeURLLabel
        ], padding: 16, spacing: 5)
        activeCard.backgroundColor = UIColor(red: 0.05, green: 0.39, blue: 0.76, alpha: 1)
        activeCard.layer.borderWidth = 0

        let tabs = UISegmentedControl(items: ["网关地址", "P2P 设备"])
        tabs.selectedSegmentIndex = 1
        tabs.accessibilityIdentifier = "connectionType"
        tabs.addTarget(self, action: #selector(changeTab(_:)), for: .valueChanged)
        tabs.heightAnchor.constraint(equalToConstant: 44).isActive = true

        buildP2pPanel()
        buildGatewayPanel()
        let stack = column([activeCard, tabs, gatewayPanel, p2pPanel], spacing: 18)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -18),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -36)
        ])
        changeTab(tabs)
        renderP2pAddresses()
        renderSavedAddresses()
    }

    private func buildP2pPanel() {
        p2pPanel.axis = .vertical
        p2pPanel.spacing = 9
        p2pPanel.addArrangedSubview(text("添加 P2P 设备", size: 14, weight: .bold))
        let scan = UIButton(type: .system)
        var config = UIButton.Configuration.plain()
        config.title = "扫码添加设备"
        config.subtitle = "扫描电脑上的 WorkStep 配对码"
        config.image = UIImage(systemName: "qrcode.viewfinder")
        config.imagePadding = 10
        config.baseForegroundColor = UIColor(red: 0.03, green: 0.35, blue: 0.68, alpha: 1)
        scan.configuration = config
        scan.accessibilityIdentifier = "scanP2p"
        scan.contentHorizontalAlignment = .leading
        scan.backgroundColor = UIColor(red: 0.93, green: 0.97, blue: 1, alpha: 1)
        scan.layer.cornerRadius = 12
        scan.layer.borderWidth = 1 / UIScreen.main.scale
        scan.layer.borderColor = UIColor(red: 0.79, green: 0.87, blue: 0.97, alpha: 1).cgColor
        scan.heightAnchor.constraint(equalToConstant: 56).isActive = true
        scan.addTarget(self, action: #selector(scanP2p), for: .touchUpInside)
        field(p2pLink, hint: "或粘贴 P2P 配对链接", id: "p2pLink")
        p2pLink.returnKeyType = .done
        p2pLink.delegate = self
        p2pLink.addTarget(self, action: #selector(changed), for: .editingChanged)
        p2pSave.setTitle("保存", for: .normal)
        p2pSave.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
        p2pSave.widthAnchor.constraint(equalToConstant: 64).isActive = true
        p2pSave.addTarget(self, action: #selector(saveP2pLink), for: .touchUpInside)
        let fieldRow = UIStackView(arrangedSubviews: [p2pLink, p2pSave])
        fieldRow.axis = .horizontal
        fieldRow.spacing = 8
        let inputCard = card([scan, fieldRow])
        p2pPanel.addArrangedSubview(inputCard)
        let heading = UIStackView(arrangedSubviews: [text("已保存的设备", size: 14, weight: .bold),
                                                       text("", size: 11, color: .secondaryLabel)])
        heading.axis = .horizontal
        heading.distribution = .equalSpacing
        heading.accessibilityIdentifier = "p2pSavedHeading"
        p2pPanel.addArrangedSubview(heading)
        p2pSavedStack.axis = .vertical
        p2pSavedCard.axis = .vertical
        p2pSavedCard.spacing = 8
        p2pSavedCard.backgroundColor = .white
        p2pSavedCard.layer.cornerRadius = 14
        p2pSavedCard.layer.borderWidth = 1 / UIScreen.main.scale
        p2pSavedCard.layer.borderColor = UIColor(red: 0.88, green: 0.91, blue: 0.94, alpha: 1).cgColor
        p2pSavedCard.addArrangedSubview(p2pSavedStack)
        p2pSwitch.setTitle("切换到所选连接", for: .normal)
        p2pSwitch.configuration = .filled()
        p2pSwitch.addTarget(self, action: #selector(switchP2p), for: .touchUpInside)
        p2pSwitch.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        let action = card([p2pSwitch], padding: 12)
        action.layer.borderWidth = 0
        p2pSavedCard.addArrangedSubview(action)
        p2pPanel.addArrangedSubview(p2pSavedCard)
        p2pErrorLabel.numberOfLines = 0
        p2pErrorLabel.textColor = .systemRed
        p2pErrorLabel.font = .systemFont(ofSize: 12)
        p2pPanel.addArrangedSubview(p2pErrorLabel)
    }

    private func refreshActiveCard() {
        activeTypeLabel.text = "当前连接 · \(activeP2p != nil ? "P2P 设备" : "网关地址")"
        activeNameLabel.text = activeP2p?.name ?? activeOrigin ?? "尚未连接"
        activeURLLabel.text = activeP2p?.entryURL.absoluteString ?? activeOrigin ?? "请选择一个连接"
    }

    private func buildGatewayPanel() {
        gatewayPanel.axis = .vertical
        gatewayPanel.spacing = 9
        gatewayPanel.addArrangedSubview(text("添加网关地址", size: 14, weight: .bold))
        field(address, hint: "https://gateway.example.com", id: "serverAddress")
        address.text = activeP2p == nil ? draftBaseline : ""
        address.returnKeyType = .go
        address.delegate = self
        address.addTarget(self, action: #selector(changed), for: .editingChanged)
        addAddress.setTitle("新增", for: .normal)
        addAddress.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
        addAddress.widthAnchor.constraint(equalToConstant: 64).isActive = true
        addAddress.accessibilityIdentifier = "addServer"
        addAddress.addTarget(self, action: #selector(addSavedAddress), for: .touchUpInside)
        let inputRow = UIStackView(arrangedSubviews: [address, addAddress])
        inputRow.axis = .horizontal
        inputRow.spacing = 8
        connect.setTitle("连接", for: .normal)
        connect.configuration = .filled()
        connect.accessibilityIdentifier = "connectServer"
        connect.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        connect.addTarget(self, action: #selector(submit), for: .touchUpInside)
        gatewayPanel.addArrangedSubview(card([inputRow, connect]))
        savedTitle.text = "已保存的地址"
        savedTitle.font = .systemFont(ofSize: 14, weight: .bold)
        gatewayPanel.addArrangedSubview(savedTitle)
        savedStack.axis = .vertical
        savedCard.axis = .vertical
        savedCard.spacing = 8
        savedCard.backgroundColor = .white
        savedCard.layer.cornerRadius = 14
        savedCard.layer.borderWidth = 1 / UIScreen.main.scale
        savedCard.layer.borderColor = UIColor(red: 0.88, green: 0.91, blue: 0.94, alpha: 1).cgColor
        savedCard.addArrangedSubview(savedStack)
        switchAddress.setTitle("切换到所选连接", for: .normal)
        switchAddress.configuration = .filled()
        switchAddress.accessibilityIdentifier = "switchServer"
        switchAddress.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        switchAddress.addTarget(self, action: #selector(switchSavedAddress), for: .touchUpInside)
        let action = card([switchAddress], padding: 12)
        action.layer.borderWidth = 0
        savedCard.addArrangedSubview(action)
        gatewayPanel.addArrangedSubview(savedCard)
        gatewayPanel.addArrangedSubview(spinner)
        errorLabel.numberOfLines = 0
        errorLabel.textColor = .systemRed
        errorLabel.font = .systemFont(ofSize: 12)
        gatewayPanel.addArrangedSubview(errorLabel)
    }

    @objc private func changeTab(_ sender: UISegmentedControl) {
        gatewayPanel.isHidden = sender.selectedSegmentIndex != 0
        p2pPanel.isHidden = sender.selectedSegmentIndex != 1
    }
    @objc private func changed() { updateButtons() }
    private func updateButtons() {
        let ready = request == nil
        let hasInput = !(address.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        connect.isEnabled = ready && hasInput
        connect.isHidden = !hasInput
        addAddress.isEnabled = ready && hasInput
        switchAddress.isEnabled = ready && selectedOrigin != nil
        p2pSwitch.isEnabled = ready && selectedP2p != nil
        p2pSave.isEnabled = !(p2pLink.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func row(title: String, subtitle: String, selected: Bool, active: Bool,
                     id: String, onSelect: @escaping () -> Void, onDelete: @escaping () -> Void) -> UIView {
        let select = UIButton(type: .system)
        let bullet = UIImageView(image: UIImage(systemName: selected ? "largecircle.fill.circle" : "circle"))
        bullet.tintColor = selected ? .systemBlue : .secondaryLabel
        bullet.setContentHuggingPriority(.required, for: .horizontal)
        let name = text(title, size: 13, weight: .semibold)
        let detail = text(subtitle, size: 10, color: .secondaryLabel)
        name.lineBreakMode = .byTruncatingTail
        detail.lineBreakMode = .byTruncatingMiddle
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let labels = column([name, detail], spacing: 3)
        let content = UIStackView(arrangedSubviews: [bullet, labels])
        content.axis = .horizontal
        content.alignment = .center
        content.spacing = 9
        content.isUserInteractionEnabled = false
        content.translatesAutoresizingMaskIntoConstraints = false
        select.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: select.leadingAnchor, constant: 8),
            content.trailingAnchor.constraint(equalTo: select.trailingAnchor),
            content.topAnchor.constraint(equalTo: select.topAnchor, constant: 4),
            content.bottomAnchor.constraint(equalTo: select.bottomAnchor, constant: -4)
        ])
        select.accessibilityIdentifier = id
        select.accessibilityLabel = title + ", " + subtitle
        select.accessibilityValue = selected ? "已选择" : "未选择"
        select.addAction(UIAction { _ in onSelect() }, for: .touchUpInside)
        let remove = UIButton(type: .system)
        remove.setImage(UIImage(systemName: "xmark"), for: .normal)
        remove.tintColor = .secondaryLabel
        remove.accessibilityIdentifier = "delete-\(id)"
        remove.accessibilityLabel = "删除 " + title
        remove.widthAnchor.constraint(equalToConstant: 44).isActive = true
        remove.addAction(UIAction { _ in onDelete() }, for: .touchUpInside)
        var items: [UIView] = [select]
        if active { items.append(text("使用中", size: 10, weight: .semibold, color: .systemBlue)) }
        items.append(remove)
        let line = UIStackView(arrangedSubviews: items)
        line.axis = .horizontal
        line.alignment = .center
        line.spacing = 2
        line.layoutMargins = UIEdgeInsets(top: 4, left: 8, bottom: 4, right: 4)
        line.isLayoutMarginsRelativeArrangement = true
        line.backgroundColor = selected ? UIColor(red: 0.96, green: 0.98, blue: 1, alpha: 1) : .white
        line.heightAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true
        return line
    }

    private func renderP2pAddresses() {
        for view in p2pSavedStack.arrangedSubviews { p2pSavedStack.removeArrangedSubview(view); view.removeFromSuperview() }
        let items = p2pStore.load()
        if !items.contains(where: { $0.entryURL.absoluteString == selectedP2p }) {
            selectedP2p = activeP2p?.entryURL.absoluteString ?? items.first?.entryURL.absoluteString
        }
        for (index, item) in items.enumerated() {
            p2pSavedStack.addArrangedSubview(row(title: item.name, subtitle: item.entryURL.absoluteString,
                selected: selectedP2p == item.entryURL.absoluteString, active: activeP2p?.entryURL == item.entryURL,
                id: "savedP2p-\(index)", onSelect: { [weak self] in
                    self?.selectedP2p = item.entryURL.absoluteString
                    self?.renderP2pAddresses()
                }, onDelete: { [weak self] in self?.deleteP2p(item) }))
        }
        if items.isEmpty {
            let empty = text("还没有保存的设备", size: 12, color: .secondaryLabel)
            empty.textAlignment = .center
            empty.heightAnchor.constraint(equalToConstant: 58).isActive = true
            p2pSavedStack.addArrangedSubview(empty)
        }
        (p2pPanel.arrangedSubviews.first { $0.accessibilityIdentifier == "p2pSavedHeading" } as? UIStackView)?
            .arrangedSubviews.last.map { ($0 as? UILabel)?.text = "\(items.count) 条" }
        updateButtons()
    }

    @objc private func scanP2p() {
        let scanner = P2pScannerViewController()
        scanner.onScan = { [weak self] link in self?.addP2p(link, connect: true) }
        let navigation = P2pScannerNavigationController(rootViewController: scanner)
        navigation.modalPresentationStyle = .pageSheet
        navigation.sheetPresentationController?.detents = [.medium()]
        navigation.sheetPresentationController?.prefersGrabberVisible = true
        present(navigation, animated: true)
    }
    @objc private func saveP2pLink() { addP2p(p2pLink.text ?? "", connect: false) }
    private func addP2p(_ link: String, connect: Bool) {
        do {
            let item = try P2pConnection(link)
            try p2pStore.save(item)
            selectedP2p = item.entryURL.absoluteString
            p2pLink.text = ""
            p2pErrorLabel.text = nil
            if connect { onP2pConnect?(item); dismiss(animated: true) }
            else { renderP2pAddresses() }
        } catch { p2pErrorLabel.text = error.localizedDescription }
    }
    private func deleteP2p(_ item: P2pConnection) {
        p2pStore.remove(item)
        if activeP2p?.entryURL == item.entryURL {
            activeP2p = nil
            defaults.removeObject(forKey: "p2p_active_url")
            onDeleteActive?()
            refreshActiveCard()
        }
        selectedP2p = nil
        renderP2pAddresses()
    }
    @objc private func switchP2p() {
        guard let item = p2pStore.load().first(where: { $0.entryURL.absoluteString == selectedP2p }) else { return }
        onP2pConnect?(item)
        dismiss(animated: true)
    }

    private func renderSavedAddresses() {
        for view in savedStack.arrangedSubviews { savedStack.removeArrangedSubview(view); view.removeFromSuperview() }
        if !book.origins.contains(where: { $0 == selectedOrigin }) { selectedOrigin = book.origins.first }
        for (index, origin) in book.origins.enumerated() {
            savedStack.addArrangedSubview(row(title: URL(string: origin)?.host ?? origin, subtitle: origin,
                selected: selectedOrigin == origin, active: activeOrigin == origin && activeP2p == nil,
                id: "savedServer-\(index)", onSelect: { [weak self] in
                    self?.selectedOrigin = origin
                    self?.renderSavedAddresses()
                }, onDelete: { [weak self] in self?.deleteSavedAddress(origin) }))
        }
        if book.origins.isEmpty {
            let empty = text("还没有保存的地址", size: 12, color: .secondaryLabel)
            empty.textAlignment = .center
            empty.heightAnchor.constraint(equalToConstant: 58).isActive = true
            savedStack.addArrangedSubview(empty)
        }
        updateButtons()
    }
    @objc private func addSavedAddress() {
        guard request == nil else { return }
        do {
            let candidate = try ServerAddress(address.text ?? "")
            guard try book.add(candidate.origin) else { errorLabel.text = "地址已保存"; return }
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
    private func deleteSavedAddress(_ origin: String) {
        guard request == nil else { return }
        book.remove(origin)
        defaults.set(book.origins, forKey: "servers")
        if origin == activeOrigin {
            activeOrigin = nil
            defaults.removeObject(forKey: "server")
            onDeleteActive?()
            refreshActiveCard()
        }
        if address.text == origin { address.text = ""; draftBaseline = "" }
        selectedOrigin = book.origins.first
        errorLabel.text = nil
        renderSavedAddresses()
    }
    @objc private func cancel() {
        if (address.text ?? "") != draftBaseline || !(p2pLink.text ?? "").isEmpty {
            let alert = UIAlertController(title: "放弃地址修改？", message: nil, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "继续编辑", style: .cancel))
            alert.addAction(UIAlertAction(title: "放弃", style: .destructive) { [weak self] _ in
                self?.cancelled = true; self?.request?.cancel(); self?.dismiss(animated: true)
            })
            present(alert, animated: true)
        } else { cancelled = true; request?.cancel(); dismiss(animated: true) }
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField == p2pLink { saveP2pLink() }
        else if connect.isEnabled { submit() }
        return true
    }
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
                else { self.errorLabel.text = "无法连接，请检查地址和网络后重试" }
            }
        }
        updateButtons()
    }
}

private final class P2pScannerNavigationController: UINavigationController {
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
}

private extension UITextField {
    func setLeftPaddingPoints(_ amount: CGFloat) {
        let padding = UIView(frame: CGRect(x: 0, y: 0, width: amount, height: 1))
        leftView = padding
        leftViewMode = .always
    }
}
