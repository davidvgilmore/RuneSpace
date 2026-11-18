// RuneSpace's macOS host for the official Bandcamp album player.
import AppKit
import WebKit
import Darwin

let albumURL = URL(string: "https://runescape-ost.bandcamp.com/album/runescape-original-soundtrack-classics")!
let widgetURL = URL(string: "https://bandcamp.com/EmbeddedPlayer/album=1389146271/size=large/bgcol=26291f/linkcol=e2c87e/artwork=small/tracklist=true/track=1667552624/transparent=true/")!
let moss = NSColor(srgbRed: 0.149, green: 0.161, blue: 0.122, alpha: 1)

final class Station: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let home: URL
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 470, height: 640),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
    let web: WKWebView
    let message = NSTextField(wrappingLabelWithString: "")
    let retry = NSButton(title: "Retry", target: nil, action: nil)
    var watcher: DispatchSourceFileSystemObject?
    var request = ""
    var phase = "loading"

    init(home: URL) {
        self.home = home
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = .all
        #if RUNESPACE_MUSIC_TEST
        configureProbe(config)
        #endif
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let application = NSMenu()
        application.addItem(withTitle: "Quit RuneSpace Music", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = application
        NSApp.mainMenu = menu

        window.title = "RuneSpace Music"
        window.minSize = NSSize(width: 320, height: 270)
        window.backgroundColor = moss
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        web.underPageBackgroundColor = moss
        web.navigationDelegate = self
        web.uiDelegate = self

        let album = NSButton(title: "Album on Bandcamp ↗", target: self, action: #selector(openAlbum))
        album.toolTip = "Open the official album in your browser"
        album.setContentCompressionResistancePriority(.required, for: .horizontal)
        retry.target = self
        retry.action = #selector(loadAlbum)
        message.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        message.textColor = .secondaryLabelColor
        let bar = NSStackView(views: [message, retry, album])
        bar.spacing = 8
        bar.edgeInsets = NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 8)
        message.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let view = NSView()
        window.contentView = view
        for child in [web, bar] {
            child.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(child)
        }
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.topAnchor), web.bottomAnchor.constraint(equalTo: bar.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor), bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        let fd = open(home.path, O_EVTONLY)
        guard fd >= 0 else { NSApp.terminate(nil); return }
        let watcher = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
        watcher.setEventHandler { [weak self] in self?.handleRequest() }
        watcher.setCancelHandler { Darwin.close(fd) }
        self.watcher = watcher
        watcher.resume()
        loadAlbum()
        handleRequest()
    }

    func handleRequest() {
        let path = home.appendingPathComponent("station-request.json")
        guard let data = try? Data(contentsOf: path),
              let payload = try? JSONDecoder().decode([String: String].self, from: data),
              let token = payload["request"], token != request else { return }
        request = token
        if payload["command"] == "stop" { NSApp.terminate(nil); return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        writeStatus()
    }

    func writeStatus() {
        let status: [String: Any] = ["pid": getpid(), "request": request, "phase": phase, "minimized": window.isMiniaturized]
        if let data = try? JSONSerialization.data(withJSONObject: status) {
            try? data.write(to: home.appendingPathComponent("station-status.json"), options: .atomic)
        }
    }

    @objc func loadAlbum() {
        phase = "loading"
        message.stringValue = "Loading the official soundtrack…"
        retry.isHidden = true
        writeStatus()
        web.load(URLRequest(url: widgetURL, timeoutInterval: 25))
    }

    @objc func openAlbum() { NSWorkspace.shared.open(albumURL) }

    func showError(_ reason: String) {
        phase = "error"
        message.stringValue = reason
        retry.isHidden = false
        writeStatus()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard phase != "error" else { return }
        phase = "ready"
        message.stringValue = "RuneScape · Original Soundtrack Classics"
        writeStatus()
        #if RUNESPACE_MUSIC_TEST
        probeStation(self)
        #endif
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard phase != "error", (error as NSError).code != NSURLErrorCancelled else { return }
        showError("Bandcamp couldn’t load. " + error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("The Bandcamp player closed. Retry to reload the album.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            showError("Bandcamp returned HTTP \(http.statusCode).")
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated,
           let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
           url.host != widgetURL.host || url.path != widgetURL.path {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.navigationType == .linkActivated, let url = action.request.url,
           ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func windowDidMiniaturize(_ notification: Notification) { writeStatus() }
    func windowDidDeminiaturize(_ notification: Notification) { writeStatus() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { watcher?.cancel() }
}

guard CommandLine.arguments.count == 2 else { exit(2) }
let home = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let lock = open(home.appendingPathComponent("station.lock").path, O_CREAT | O_RDWR, 0o600)
guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { exit(1) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let station = Station(home: home)
app.delegate = station
app.run()
Darwin.close(lock)
