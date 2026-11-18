// The guild controls the album through Bandcamp's own track list and transport.
import AppKit
import WebKit
import Darwin

let widgetURL = URL(string: "https://bandcamp.com/EmbeddedPlayer/album=1389146271/size=large/bgcol=26291f/linkcol=e2c87e/artwork=small/tracklist=true/track=1667552624/transparent=true/")!

struct PlayerRequest: Decodable {
    let request: String
    let command: String
    let track: Int?
}

final class Station: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let home: URL
    let web: WKWebView
    // WebKit needs a laid-out view to render the provider's controls. This window
    // is never ordered onto the screen and the app cannot take keyboard focus.
    let host: NSWindow
    var watcher: DispatchSourceFileSystemObject?
    var ownerExit: DispatchSourceProcess?
    var lastAction = Date.distantPast
    var waitingForPlayback: Date?
    var timer: Timer?
    var received = ""
    var acknowledged = ""
    var pending: PlayerRequest?
    var phase = "loading"
    var error: String?
    var loaded = false
    var evaluating = false
    var display: [String: Any] = ["track": 1, "title": "", "elapsed": 0, "duration": 0, "playing": false, "tracks": [] as [String]]
    var lastStatus: Data?

    init(home: URL) {
        self.home = home
        let bounds = NSRect(x: 0, y: 0, width: 470, height: 640)
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = .all
        #if RUNESPACE_MUSIC_TEST
        configureProbe(config)
        #endif
        web = WKWebView(frame: bounds, configuration: config)
        host = NSWindow(contentRect: bounds, styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        host.contentView = web
        web.navigationDelegate = self
        let fd = open(home.path, O_EVTONLY)
        guard fd >= 0 else { NSApp.terminate(nil); return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
        source.setEventHandler { [weak self] in self?.receive() }
        source.setCancelHandler { Darwin.close(fd) }
        watcher = source
        source.resume()
        if let owner = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.herdr.app").first {
            let source = DispatchSource.makeProcessSource(identifier: owner.processIdentifier, eventMask: .exit, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            ownerExit = source
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.65, repeats: true) { [weak self] _ in
            guard let self else { return }
            // A paused album's selection and position cannot change by themselves.
            if self.display["playing"] as? Bool == true || self.waitingForPlayback != nil || Date().timeIntervalSince(self.lastAction) < 3 {
                self.sample()
            }
        }
        timer?.tolerance = 0.15
        loadAlbum()
        receive()
    }

    func receive() {
        let file = home.appendingPathComponent("station-request.json")
        guard let data = try? Data(contentsOf: file),
              let command = try? JSONDecoder().decode(PlayerRequest.self, from: data),
              ["open", "play", "pause", "next", "previous", "stop"].contains(command.command),
              received != command.request else { return }
        received = command.request
        lastAction = Date()
        if command.command == "stop" { NSApp.terminate(nil); return }
        if phase == "error" && (command.command == "play" || command.command == "open") { loadAlbum() }
        if command.command == "open" || phase == "error" {
            acknowledged = command.request
            writeStatus()
        } else {
            if command.command == "play" { waitingForPlayback = Date() }
            if command.command == "pause" { waitingForPlayback = nil }
            pending = command
            sample()
        }
    }

    func writeStatus() {
        var values = display
        values["version"] = 2
        values["running"] = phase != "stopped"
        values["pid"] = getpid()
        values["phase"] = phase
        values["request"] = acknowledged
        values["error"] = error
        if phase != "ready" { values["playing"] = false }
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: .sortedKeys),
              lastStatus != data else { return }
        do {
            try data.write(to: home.appendingPathComponent("station-status.json"), options: .atomic)
            lastStatus = data
        } catch { NSLog("Could not publish RuneSpace Music status: %@", error.localizedDescription) }
    }

    func loadAlbum() {
        loaded = false
        phase = "loading"
        error = nil
        writeStatus()
        web.load(URLRequest(url: widgetURL, timeoutInterval: 25))
    }

    func fail(_ message: String) {
        loaded = false
        waitingForPlayback = nil
        phase = "error"
        error = message
        if let command = pending { acknowledged = command.request; pending = nil }
        writeStatus()
    }

    func sample() {
        guard loaded && !evaluating else { return }
        evaluating = true
        let command = pending
        pending = nil
        // These are the public-facing track rows, time labels and player buttons.
        // Bandcamp retains ownership of streaming, natural advancement and gating.
        let action = command?.command ?? "status"
        let script = #"""
        (() => {
          const action = '\#(action)', number = \#(command?.track ?? 0);
          const rows = Array.from(document.querySelectorAll('#tracklist_ul > li'));
          const player = document.querySelector('#player');
          const text = (root, selector) => root?.querySelector(selector)?.textContent.trim() || '';
          const seconds = value => /^\d+:\d{2}$/.test(value) ? value.split(':').reduce((n, v) => n * 60 + Number(v), 0) : 0;
          const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
          const notice = Array.from(document.querySelectorAll('#badtralbumerror, #badbrowsererror, [role="alertdialog"], [role="dialog"]'))
            .find(e => visible(e) && e.innerText.trim());
          if (notice) return {error: notice.innerText.trim().slice(0, 180) + ' Open the official album on Bandcamp.'};
          if (!rows.length || !player) return {error: "The track list is unavailable. Check your connection or open the official album on Bandcamp."};
          const active = () => rows.findIndex(row => row.classList.contains('currenttrack')) + 1;
          const playing = () => player.classList.contains('playing');
          const transport = () => [...document.querySelectorAll('#big_play_button, #play')].find(visible);
          let control;
          if (action === 'play' && number && active() !== number) {
            control = rows[number - 1]?.querySelector('a');
          } else if ((action === 'play' && !playing()) || (action === 'pause' && playing())) {
            control = transport();
          } else if (action === 'next' || action === 'previous') {
            control = document.querySelector(action === 'next' ? '#next' : '#prev');
          }
          if (control) control.click();
          const tracks = rows.map((row, i) => ({number: i + 1, title: text(row, '.tracktitle'), duration: seconds(text(row, '.tracktime'))}));
          const current = active();
          const track = tracks[current - 1];
          if (!track || (action === 'play' && number && !rows[number - 1])) {
            return {error: "Bandcamp couldn't select that track. Open the official album on Bandcamp."};
          }
          return {tracks, track: current, title: track.title, duration: track.duration,
                  elapsed: seconds(text(rows[current - 1], '.currenttime')), playing: playing()};
        })()
        """#
        web.evaluateJavaScript(script) { [weak self] value, failure in
            guard let self else { return }
            self.evaluating = false
            if let command { self.acknowledged = command.request }
            guard self.loaded else { self.writeStatus(); return }
            if let state = value as? [String: Any], let issue = state["error"] as? String {
                self.fail(issue)
            } else if failure != nil || !(value is [String: Any]) {
                self.fail("Bandcamp couldn't report playback. Try again or open the official album.")
            } else if let state = value as? [String: Any] {
                self.phase = "ready"
                self.display = state
                if state["playing"] as? Bool == true && (state["elapsed"] as? Int ?? 0) > 0 {
                    self.waitingForPlayback = nil
                } else if let since = self.waitingForPlayback, Date().timeIntervalSince(since) > 20 {
                    self.fail("Playback hasn't started. Check your connection or visit the official album on Bandcamp.")
                }
                self.writeStatus()
            }
            if self.pending != nil { self.sample() }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard phase != "error" else { return }
        loaded = true
        sample()
        #if RUNESPACE_MUSIC_TEST
        probeStation(self)
        #endif
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        fail("Bandcamp couldn't load. " + error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail("Bandcamp playback stopped. Press Play to reconnect.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            fail("Bandcamp returned HTTP \(http.statusCode). Try again or open the official album.")
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.targetFrame?.isMainFrame == true, action.navigationType == .linkActivated,
           action.request.url?.path != widgetURL.path {
            fail("Visit the official album on Bandcamp to continue.")
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        watcher?.cancel()
        ownerExit?.cancel()
        phase = "stopped"
        error = nil
        writeStatus()
    }
}

guard CommandLine.arguments.count == 2 else { exit(2) }
let home = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let lock = open(home.appendingPathComponent("station.lock").path, O_CREAT | O_RDWR, 0o600)
guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { exit(1) }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let station = Station(home: home)
app.delegate = station
app.run()
Darwin.close(lock)
