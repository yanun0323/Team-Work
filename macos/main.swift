import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var backend: Process?
    private let input = Pipe()
    private let output = Pipe()
    private var ready = false
    private var stopping = false
    private var startupTimer: Timer?
    private let origin = URL(string: "http://127.0.0.1:18787")!
    private let smoke = CommandLine.arguments.contains("--smoke-test")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "關於 Team Work", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "結束 Team Work", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let edit = NSMenu(title: "編輯")
        for (title, action, key) in [("復原", "undo:", "z"), ("剪下", "cut:", "x"), ("拷貝", "copy:", "c"), ("貼上", "paste:", "v"), ("全選", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: "編輯", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu

        let configuration = WKWebViewConfiguration()
        if smoke { configuration.websiteDataStore = .nonPersistent() }
        configuration.userContentController.add(self, name: "quit")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Team Work"
        window.minSize = NSSize(width: 800, height: 600)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("<html lang='zh-Hant'><body style='font:18px system-ui;padding:40px'>正在啟動 Team Work…</body></html>", baseURL: nil)
        do { try startBackend() } catch { fail("無法啟動後端：\(error.localizedDescription)") }
    }

    private func startBackend() throws {
        let resources = Bundle.main.resourceURL!
        let data: URL
        if smoke {
            guard let path = ProcessInfo.processInfo.environment["MHO_DESKTOP_TEST_DIR"], path.hasPrefix("/") else {
                fail("Smoke test requires MHO_DESKTOP_TEST_DIR")
                return
            }
            data = URL(fileURLWithPath: path, isDirectory: true)
        } else {
            if let path = ProcessInfo.processInfo.environment["TEAM_WORK_HOME"], path.hasPrefix("/") {
                data = URL(fileURLWithPath: path, isDirectory: true)
            } else {
                data = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".team-work", isDirectory: true)
            }
        }
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let logURL = data.appendingPathComponent("backend.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let log = try FileHandle(forWritingTo: logURL)
        try log.truncate(atOffset: 0)
        let process = Process()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/company-server")
        process.arguments = ["--desktop", "--web-dir", resources.appendingPathComponent("web").path]
        process.currentDirectoryURL = data
        var env = ProcessInfo.processInfo.environment
        // Finder does not load shell profiles. Include common Git and Claude CLI locations.
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        env["TEAM_WORK_HOST"] = "127.0.0.1"
        env["TEAM_WORK_PORT"] = "18787"
        env["TEAM_WORK_HOME"] = data.path
        env["TEAM_WORK_ALLOWED_ORIGINS"] = origin.absoluteString
        env["TEAM_WORK_DEBUG"] = "false"
        process.environment = env
        process.standardInput = input
        process.standardOutput = output
        process.standardError = log
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if self.stopping { NSApp.reply(toApplicationShouldTerminate: true) }
                else { self.fail("後端已停止。請查看 \(logURL.path)。若連接埠 18787 已被使用，請先關閉另一個 Team Work。") }
            }
        }
        backend = process
        try process.run()
        try log.close()
        // Close the parent's copy so backend exit produces EOF on the reader.
        try output.fileHandleForWriting.close()
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let data = self.output.fileHandleForReading.availableData
            DispatchQueue.main.async {
                guard !self.stopping, String(data: data, encoding: .utf8) == "READY\n" else { return }
                self.ready = true
                self.startupTimer?.invalidate()
                self.webView.load(URLRequest(url: self.origin))
            }
        }
        startupTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            self?.fail("後端啟動逾時，請重新開啟 App。")
        }
    }

    private func fail(_ message: String) {
        guard !stopping else { return }
        startupTimer?.invalidate()
        if smoke {
            fputs("SMOKE FAILED: \(message)\n", stderr)
        } else {
            let alert = NSAlert()
            alert.messageText = "Team Work 無法執行"
            alert.informativeText = message
            alert.runModal()
        }
        NSApp.terminate(nil)
    }

    // The airport's power button. Navigation stays on our own origin, so only our page can send this.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        stopping = true
        startupTimer?.invalidate()
        try? input.fileHandleForWriting.close()
        guard let backend, backend.isRunning else { return .terminateNow }
        // Keep the app alive until the engine has saved and its owned processes have stopped.
        return .terminateLater
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString == "about:blank" || (url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port) {
            decisionHandler(.allow)
        } else {
            if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if ready { fail(error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard smoke, ready, webView.url?.host == origin.host else { return }
        let js = """
        const world = await (await fetch('/api/v1/world')).json();
        if (!world.workflows) throw new Error('No world');
        await new Promise((resolve, reject) => {
          const s = new WebSocket('ws://' + location.host + '/api/v1/events');
          const timer = setTimeout(() => { s.close(); reject(new Error('WebSocket timeout')); }, 5000);
          s.onmessage = e => { clearTimeout(timer); s.close(); JSON.parse(e.data).type === 'snapshot' ? resolve() : reject(new Error('No snapshot')); };
          s.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
        });
        await new Promise(r => setTimeout(r, 3000));
        if (!document.querySelector('canvas')) throw new Error('No scene canvas');
        const c = document.createElement('canvas');
        if (!c.getContext('webgl2')) throw new Error('No WebGL2');
        return 'SMOKE OK: frontend, API, WebSocket, WebGL2';
        """
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            switch result {
            case .success(let value): print(value); NSApp.terminate(nil)
            case .failure(let error): self?.fail(error.localizedDescription)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
