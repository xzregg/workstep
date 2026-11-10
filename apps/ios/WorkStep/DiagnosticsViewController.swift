import UIKit

final class DiagnosticsViewController: UIViewController {
    private let diagnostics: Diagnostics
    private let text = UITextView()
    init(diagnostics: Diagnostics) { self.diagnostics = diagnostics; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = "查看日志"; view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "完成", style: .done, target: self, action: #selector(close))
        navigationItem.rightBarButtonItems = [UIBarButtonItem(title: "复制", style: .plain, target: self, action: #selector(copyReport)),
                                              UIBarButtonItem(title: "清除", style: .plain, target: self, action: #selector(clear))]
        text.isEditable = false; text.font = .preferredFont(forTextStyle: .footnote); text.text = diagnostics.report
        text.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(text)
        NSLayoutConstraint.activate([text.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            text.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            text.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            text.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16)])
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated); text.scrollRangeToVisible(NSRange(location: max(0, (text.text as NSString).length - 1), length: 0))
    }
    @objc private func close() { dismiss(animated: true) }
    @objc private func copyReport() { UIPasteboard.general.string = diagnostics.report }
    @objc private func clear() { diagnostics.clear(); text.text = diagnostics.report }
}
