import AppKit
import Sparkle
import UserNotifications
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, WKDownloadDelegate, SPUUpdaterDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    // Sparkle checks on its own schedule and shows its own windows; the page only gets a dot when one is found.
    private var updater: SPUStandardUpdaterController!
    private var updateFound = false
    // A check the page asked for is under way; the page shows a spinner until it ends.
    private var updateChecking = false
    private var webView: WKWebView!
    private var backend: Process?
    private let input = Pipe()
    private let output = Pipe()
    private var ready = false
    private var bootDone = false
    // The startup screen, the same as #boot in frontend/index.html.
    private let bootPage = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web/boot")
    private var stopping = false
    // A restart the page asked for is under way: a new instance opens once this one has quit.
    private var restarting = false
    private var startupTimer: Timer?
    private let origin = URL(string: "http://127.0.0.1:18787")!
    private let smoke = CommandLine.arguments.contains("--smoke-test")
    // The task or chat of a clicked notification, kept until the app's page can open it.
    private var asked: [String: String]?
    // The page reports the app's language; it is remembered for what shows before the page loads.
    private var language: String { UserDefaults.standard.string(forKey: "language") ?? "zh" }
    /// A text in the app's language, given in Traditional Chinese, English, Simplified Chinese, Japanese and Korean.
    private func say(_ zh: String, _ en: String, _ zhHans: String, _ ja: String, _ ko: String) -> String {
        switch language {
        case "en": return en
        case "zh-Hans": return zhHans
        case "ja": return ja
        case "ko": return ko
        default: return zh
        }
    }

    // Set before launch ends, so a click that launched the app still arrives.
    func applicationWillFinishLaunching(_ notification: Notification) {
        if !smoke { UNUserNotificationCenter.current().delegate = self }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        updater = SPUStandardUpdaterController(startingUpdater: !smoke, updaterDelegate: self, userDriverDelegate: nil)
        // A quiet check on every launch, so the red dot is right from the start; it shows no window.
        if !smoke { updater.updater.checkForUpdateInformation() }
        buildMenu()

        let configuration = WKWebViewConfiguration()
        allowFullFrameRate(configuration.preferences)
        if smoke { configuration.websiteDataStore = .nonPersistent() }
        configuration.userContentController.add(self, name: "quit")
        configuration.userContentController.add(self, name: "language")
        configuration.userContentController.add(self, name: "update")
        configuration.userContentController.add(self, name: "checkUpdate")
        configuration.userContentController.add(self, name: "notify")
        configuration.userContentController.add(self, name: "badge")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "pickFolder")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "restart")
        webView = WKWebView(frame: .zero, configuration: configuration)
        // Lets Safari's Web Inspector attach to a signed release, where WebKit problems are otherwise invisible.
        webView.isInspectable = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Team Work"
        // Closing only hides the window: the app, its backend and its notifications go on until Quit.
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 800, height: 600)
        window.contentView = webView
        window.backgroundColor = NSColor(srgbRed: 0x3b / 255, green: 0x86 / 255, blue: 0xc6 / 255, alpha: 1)
        webView.underPageBackgroundColor = window.backgroundColor
        window.center()
        // The window opens once this page has painted (see didFinish), so it never flashes white.
        if let boot = bootPage { webView.loadFileURL(boot, allowingReadAccessTo: boot.deletingLastPathComponent()) } else { bootFinished() }
        do { try startBackend() } catch { fail(say("無法啟動後端：\(error.localizedDescription)", "Could not start the backend: \(error.localizedDescription)", "无法启动后端：\(error.localizedDescription)", "バックエンドを起動できません：\(error.localizedDescription)", "백엔드를 시작할 수 없습니다: \(error.localizedDescription)")) }
    }

    /// WebKit holds the page to about 60 frames a second, half the rate of a 120Hz ProMotion screen, through a feature
    /// with no public switch. Turning it off lets the town follow the screen. It goes through WebKit's private feature
    /// list, the one Safari's Feature Flags menu uses, and does nothing if a later WebKit no longer has it.
    private func allowFullFrameRate(_ preferences: WKPreferences) {
        let list = NSSelectorFromString("_features")
        let set = NSSelectorFromString("_setEnabled:forFeature:")
        guard WKPreferences.responds(to: list), preferences.responds(to: set),
              let features = WKPreferences.perform(list)?.takeUnretainedValue() as? [NSObject],
              let feature = features.first(where: { ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" })
        else { return }
        typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        unsafeBitCast(preferences.method(for: set), to: SetEnabled.self)(preferences, set, false, feature)
    }

    private func bootFinished() {
        guard !bootDone else { return }
        bootDone = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        openApp()
    }

    // Waits for the startup screen too: a file load still under way would replace the app's page.
    private func openApp() {
        guard ready, bootDone else { return }
        webView.load(URLRequest(url: origin))
    }

    private func buildMenu() {
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: say("關於 Team Work", "About Team Work", "关于 Team Work", "Team Work について", "Team Work 정보"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: say("檢查更新…", "Check for Updates…", "检查更新…", "アップデートを確認…", "업데이트 확인…"), action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "").target = updater
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: say("結束 Team Work", "Quit Team Work", "退出 Team Work", "Team Work を終了", "Team Work 종료"), action: #selector(confirmQuit(_:)), keyEquivalent: "q").target = self
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let edit = NSMenu(title: say("編輯", "Edit", "编辑", "編集", "편집"))
        for (title, action, key) in [(say("復原", "Undo", "撤销", "取り消す", "실행 취소"), "undo:", "z"), (say("剪下", "Cut", "剪切", "カット", "잘라내기"), "cut:", "x"), (say("拷貝", "Copy", "复制", "コピー", "복사"), "copy:", "c"), (say("貼上", "Paste", "粘贴", "ペースト", "붙여넣기"), "paste:", "v"), (say("全選", "Select All", "全选", "すべてを選択", "전체 선택"), "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: say("編輯", "Edit", "编辑", "編集", "편집"), action: nil, keyEquivalent: "")
        editItem.submenu = edit
        menu.addItem(editItem)
        let windows = NSMenu(title: say("視窗", "Window", "窗口", "ウインドウ", "윈도우"))
        windows.addItem(withTitle: say("最小化", "Minimize", "最小化", "しまう", "최소화"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: say("關閉視窗", "Close Window", "关闭窗口", "ウインドウを閉じる", "윈도우 닫기"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let windowsItem = NSMenuItem(title: windows.title, action: nil, keyEquivalent: "")
        windowsItem.submenu = windows
        menu.addItem(windowsItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windows
    }

    // ⌘Q asks first; the airport's power button asks on the page instead.
    @objc private func confirmQuit(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = say("要結束 Team Work 嗎？", "Quit Team Work?", "要退出 Team Work 吗？", "Team Work を終了しますか？", "Team Work를 종료할까요?")
        alert.informativeText = say("進行中的工作會中斷，開著的終端機也會一起結束。", "Running work will be interrupted, and open terminals will end too.", "进行中的工作会中断，打开的终端也会一起结束。", "進行中の作業は中断され、開いているターミナルも終了します。", "진행 중인 작업이 중단되고, 열린 터미널도 함께 종료됩니다.")
        alert.addButton(withTitle: say("結束", "Quit", "退出", "終了", "종료"))
        alert.addButton(withTitle: say("取消", "Cancel", "取消", "キャンセル", "취소"))
        if alert.runModal() == .alertFirstButtonReturn { NSApp.terminate(nil) }
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
                else { self.fail(self.say("後端已停止。請查看 \(logURL.path)。若連接埠 18787 已被使用，請先關閉另一個 Team Work。", "The backend stopped. See \(logURL.path). If port 18787 is in use, quit the other Team Work first.", "后端已停止。请查看 \(logURL.path)。若端口 18787 已被占用，请先关闭另一个 Team Work。", "バックエンドが停止しました。\(logURL.path) を確認してください。ポート 18787 が使用中なら、先にもう一つの Team Work を終了してください。", "백엔드가 멈췄습니다. \(logURL.path)을(를) 확인하세요. 포트 18787이 사용 중이면 다른 Team Work를 먼저 종료하세요.")) }
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
                self.openApp()
            }
        }
        startupTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.fail(self.say("後端啟動逾時，請重新開啟 App。", "The backend took too long to start. Reopen the app.", "后端启动超时，请重新打开 App。", "バックエンドの起動がタイムアウトしました。アプリを開き直してください。", "백엔드 시작 시간이 초과되었습니다. 앱을 다시 여세요."))
        }
    }

    private func fail(_ message: String) {
        guard !stopping else { return }
        startupTimer?.invalidate()
        if smoke {
            fputs("SMOKE FAILED: \(message)\n", stderr)
        } else {
            let alert = NSAlert()
            alert.messageText = say("Team Work 無法執行", "Team Work cannot run", "Team Work 无法运行", "Team Work を実行できません", "Team Work를 실행할 수 없습니다")
            alert.informativeText = message
            alert.runModal()
        }
        NSApp.terminate(nil)
    }

    // The airport's power button and the update button by the clock. Navigation stays on our own origin, so only our page can send these.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "language":
            if let language = message.body as? String, language != UserDefaults.standard.string(forKey: "language") {
                UserDefaults.standard.set(language, forKey: "language")
                buildMenu()
            }
        case "update":
            updater.checkForUpdates(nil)
        case "checkUpdate":
            // A quiet check, like the one at launch: the red ! shows if it finds one. One already under way is waited for.
            if smoke {
                updateChecking = false
            } else {
                updateChecking = true
                if !updater.updater.sessionInProgress { updater.updater.checkForUpdateInformation() }
            }
            showUpdateFound()
        case "notify":
            guard message.frameInfo.securityOrigin.host == origin.host, let body = message.body as? [String: Any] else { return }
            notify(body)
        case "badge":
            guard message.frameInfo.securityOrigin.host == origin.host else { return }
            let count = (message.body as? Int) ?? 0
            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        default:
            NSApp.terminate(nil)
        }
    }

    // A task or chat waiting on the user, sent by the page while the app is in the background. macOS asks for
    // permission the first time; once refused, only System Settings can turn it back on.
    private func notify(_ body: [String: Any]) {
        guard !smoke, let kind = body["kind"] as? String, ["task", "chat"].contains(kind), let id = body["id"] as? String, let title = body["title"] as? String else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = body["subtitle"] as? String ?? ""
        content.body = body["body"] as? String ?? ""
        // The page asks for a sound only when its own chime is muted in the background.
        if body["sound"] as? Bool == true { content.sound = .default }
        content.userInfo = ["kind": kind, "id": id]
        // One per task or chat: a newer one replaces the last.
        let request = UNNotificationRequest(identifier: "\(kind):\(id)", content: content, trigger: nil)
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            if granted { center.add(request) }
        }
    }

    // In front, the app's own badges and chime are enough.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let kind = info["kind"] as? String, let id = info["id"] as? String {
            DispatchQueue.main.async {
                self.asked = ["kind": kind, "id": id]
                self.showAsked()
            }
        }
        completionHandler()
    }

    // Brings the window forward and has the page open the clicked task or chat; before the page is up, it waits for didFinish.
    private func showAsked() {
        guard asked != nil, bootDone else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        guard ready, webView.url?.host == origin.host, !webView.isLoading,
              let data = try? JSONSerialization.data(withJSONObject: asked as Any), let detail = String(data: data, encoding: .utf8) else { return }
        asked = nil
        // The page reads window.twOpen when it starts and on each tw-open after that, as with twUpdate.
        webView.evaluateJavaScript("window.twOpen = \(detail); window.dispatchEvent(new Event('tw-open'))")
    }

    // What was waiting can be seen in the app now; the ones in Notification Center would only be stale.
    func applicationDidBecomeActive(_ notification: Notification) {
        if !smoke { UNUserNotificationCenter.current().removeAllDeliveredNotifications() }
    }

    // A new company's folder. The app is already in front, so its own sheet shows at once, where the backend's
    // osascript dialog first has to be let into the foreground, which macOS can hold off for seconds.
    // Replies with the full path, or "" when cancelled.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        if message.name == "restart" {
            restart(message, replyHandler)
            return
        }
        guard message.frameInfo.securityOrigin.host == origin.host, window.attachedSheet == nil else {
            replyHandler("", nil)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = say("選擇專案資料夾", "Choose the project folder", "选择项目文件夹", "プロジェクトフォルダを選択", "프로젝트 폴더 선택")
        panel.beginSheetModal(for: window) { result in
            replyHandler(result == .OK ? panel.url?.path ?? "" : "", nil)
        }
    }

    // Settings that take effect only on a new start, such as semantic search. Only our own page's main frame may ask,
    // and it names nothing: the same app bundle opens again, with the same data folder, once this instance and its
    // backend have stopped, so the new backend finds port 18787 free. Replies {accepted: true}, or an error.
    private func restart(_ message: WKScriptMessage, _ replyHandler: @escaping (Any?, String?) -> Void) {
        let from = message.frameInfo.securityOrigin
        guard !smoke, ready, message.frameInfo.isMainFrame, from.protocol == origin.scheme, from.host == origin.host, from.port == (origin.port ?? 0) else {
            replyHandler(nil, "restart is not allowed from this page")
            return
        }
        guard !restarting, !stopping else {
            replyHandler(nil, "Team Work is already quitting")
            return
        }
        // Waits for this process to end, then opens the bundle again. Paths and the pid are arguments, never code.
        var arguments = ["-c", "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.2; done; shift; exec /usr/bin/open -n \"$@\"", "sh", String(getpid())]
        if let home = ProcessInfo.processInfo.environment["TEAM_WORK_HOME"], home.hasPrefix("/") {
            arguments += ["--env", "TEAM_WORK_HOME=\(home)"]
        }
        arguments.append(Bundle.main.bundleURL.path)
        let waiter = Process()
        waiter.executableURL = URL(fileURLWithPath: "/bin/sh")
        waiter.arguments = arguments
        do {
            try waiter.run()
        } catch {
            replyHandler(nil, "could not schedule the restart")
            return
        }
        restarting = true
        replyHandler(["accepted": true], nil)
        // Quit the usual way: the backend saves and stops its processes first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        updateFound = true
        showUpdateFound()
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        updateFound = false
        showUpdateFound()
    }

    // Every check ends here, found or not, failed or cancelled, so the spinner always goes away.
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        guard updateChecking else { return }
        updateChecking = false
        showUpdateFound()
    }

    // The page reads window.twUpdate and window.twChecking when the clock first shows and listens for tw-update after that.
    private func showUpdateFound() {
        guard ready, webView.url?.host == origin.host else { return }
        webView.evaluateJavaScript("window.twUpdate = \(updateFound); window.twChecking = \(updateChecking); window.dispatchEvent(new Event('tw-update'))")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // A click on the Dock icon brings back the closed window; before startup has painted, it opens on its own.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if bootDone && !flag {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
        return true
    }

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
        if action.shouldPerformDownload, url.scheme == "data" || (url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port) {
            decisionHandler(.download)
            return
        }
        // The startup screen only before the app opens: Backspace outside a text box is Back in WebKit, and going back
        // to it would leave the window stuck there, as nothing loads the app again.
        if (url == bootPage && !bootDone) || url.absoluteString == "about:blank" || (url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port) {
            decisionHandler(.allow)
        } else {
            if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        NSAlert(error: error).beginSheetModal(for: window)
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
        if !bootDone {
            bootFinished()
            return
        }
        if ready { fail(error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !bootDone {
            bootFinished()
            return
        }
        if updateFound || updateChecking { showUpdateFound() }
        if asked != nil { showAsked() }
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
