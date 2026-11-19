// One private browser hosts WebRTC while the existing Metal renderer owns the guild.
import AVFoundation
import AppKit
import Darwin
import WebKit

typealias Object = [String: Any]
#if !GUILD_CAPTURE_FIXTURE
typealias GuildDevices = AVCaptureDevice
func callConfiguration() -> WKWebViewConfiguration { WKWebViewConfiguration() }
#endif

func jsonObject(_ file: URL) -> Object? {
  guard let data = try? Data(contentsOf: file) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? Object
}
func defaultPort(_ proto: String?) -> Int { proto == "https" ? 443 : 80 }

final class GuildCall: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandler
{
  let directory: URL
  let endpoint: URL
  let settings: Object
  let roster: GuildRoster
  var shareAgents: Bool
  let parent: pid_t
  let web: WKWebView
  let window: NSPanel
  let captureLabel = NSTextField(labelWithString: "")
  var timer: Timer?
  var ownerExit: DispatchSourceProcess?
  var loaded = false, queued = false, stopping = false
  var retry = Date.distantFuture
  var lastReady = Date()
  var lastState = Data(), lastWrite = Date.distantPast
  var lastPositionStamp: Date?, latestPosition: Object?
  var pageGeneration = 0
  var enabled = Set<String>()
  var requesting = Set<String>()
  var readyToStart: [String] = []
  var starting: [String: Date] = [:]
  var presentingCapture = false
  var frames = Set<String>()
  var current: Object = [:]
  var deviceErrors: [String: String] = [:]

  init(directory: URL, endpoint: URL, settings: Object, roster: GuildRoster, parent: pid_t) {
    self.directory = directory
    self.endpoint = endpoint
    self.settings = settings
    self.roster = roster
    self.shareAgents = settings["shareAgents"] as? Bool == true
    self.parent = parent
    let config = callConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.mediaTypesRequiringUserActionForPlayback = []
    if #available(macOS 14.0, *) { config.preferences.inactiveSchedulingPolicy = .none }
    let bounds = NSRect(x: 0, y: 0, width: 400, height: 320)
    web = WKWebView(frame: bounds, configuration: config)
    window = NSPanel(contentRect: bounds, styleMask: [.borderless, .nonactivatingPanel],
                     backing: .buffered, defer: false)
    super.init()
    web.navigationDelegate = self
    web.uiDelegate = self
    web.configuration.userContentController.add(self, name: "guild")
    let content = NSView(frame: bounds)
    web.autoresizingMask = [.width, .height]
    content.addSubview(web)
    let badge = NSView()
    badge.wantsLayer = true
    badge.layer?.backgroundColor = NSColor(calibratedRed: 0.13, green: 0.12, blue: 0.09, alpha: 1).cgColor
    badge.autoresizingMask = [.width, .height]
    badge.frame = content.bounds
    content.addSubview(badge)
    captureLabel.textColor = NSColor(calibratedRed: 1, green: 0.94, blue: 0.77, alpha: 1)
    captureLabel.font = .systemFont(ofSize: 13, weight: .medium)
    captureLabel.frame = NSRect(x: 14, y: 10, width: 270, height: 18)
    badge.addSubview(captureLabel)
    window.contentView = content
    window.isReleasedWhenClosed = false
    window.isExcludedFromWindowsMenu = true
    window.ignoresMouseEvents = true
    window.hidesOnDeactivate = false
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    placeWindow()
    let owner = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
    owner.setEventHandler { [weak self] in self?.finish() }
    owner.resume()
    ownerExit = owner
    recordOffline("connecting", "Joining the guild…")
    web.load(
      URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    timer = Timer.scheduledTimer(withTimeInterval: 0.09, repeats: true) { [weak self] _ in
      self?.tick()
    }
    timer?.tolerance = 0.012
  }
  func applicationDidChangeScreenParameters(_ notification: Notification) { placeWindow() }
  func placeWindow() {
    if presentingCapture, let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main {
      // WebKit defers getUserMedia while document.hidden. Keep the call visible
      // during device acquisition, including on fullscreen Spaces, without taking focus.
      let area = screen.visibleFrame
      window.setFrame(NSRect(x: area.maxX - 292, y: area.minY + 14, width: 278, height: 38), display: true)
      window.level = .floating
      window.alphaValue = 1
      window.orderFrontRegardless()
    } else {
      let left = NSScreen.screens.map { $0.frame.minX }.min() ?? 0
      window.setFrame(NSRect(x: left - 1400, y: 0, width: 400, height: 320), display: false)
      window.alphaValue = 0.01
      window.level = .normal
      window.orderBack(nil)
    }
  }
  func updateCaptureWindow() {
    let pending = requesting.union(readyToStart).union(starting.keys)
    if !pending.isEmpty {
      let devices = pending.count > 1 ? "microphone and camera" : pending.contains("mic") ? "microphone" : "camera"
      captureLabel.stringValue = "RuneSpace · Starting " + devices + "…"
    }
    let shouldPresent = !pending.isEmpty
    if presentingCapture != shouldPresent {
      presentingCapture = shouldPresent
      placeWindow()
    }
  }
  func resetCapture() {
    enabled.removeAll()
    requesting.removeAll()
    readyToStart.removeAll()
    starting.removeAll()
    updateCaptureWindow()
  }
  func requestDevice(_ kind: String) {
    guard current["mediaConnected"] as? Bool == true, !requesting.contains(kind),
      !readyToStart.contains(kind), starting[kind] == nil else { return }
    requesting.insert(kind)
    updateCaptureWindow()
    let generation = pageGeneration
    let device: AVMediaType = kind == "mic" ? .audio : .video
    func resolved(_ granted: Bool) {
      guard !stopping, pageGeneration == generation, requesting.remove(kind) != nil else { return }
      if granted && current["mediaConnected"] as? Bool == true {
        enabled.insert(kind)
        readyToStart.append(kind)
      } else if !granted {
        denied(kind)
      }
      updateCaptureWindow()
    }
    switch GuildDevices.authorizationStatus(for: device) {
    case .authorized: resolved(true)
    case .notDetermined:
      GuildDevices.requestAccess(for: device) { granted in
        DispatchQueue.main.async { resolved(granted) }
      }
    default: resolved(false)
    }
  }
  func sameOrigin(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == endpoint.scheme && url.host == endpoint.host
      && (url.port ?? defaultPort(url.scheme)) == (endpoint.port ?? defaultPort(endpoint.scheme))
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = action.request.url
    decisionHandler(
      action.targetFrame?.isMainFrame == true && sameOrigin(url) && url?.path == endpoint.path
        ? .allow : .cancel)
  }
  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    guard frame.isMainFrame, sameOrigin(frame.request.url), origin.host == endpoint.host,
      origin.protocol == endpoint.scheme
    else {
      decisionHandler(.deny)
      return
    }
    let needed: [(String, AVMediaType)]
    switch type {
    case .camera: needed = [("camera", .video)]
    case .microphone: needed = [("mic", .audio)]
    case .cameraAndMicrophone: needed = [("camera", .video), ("mic", .audio)]
    @unknown default:
      decisionHandler(.deny)
      return
    }
    // A click in Herdr obtains system consent before the page may start its device.
    // The origin check and this allowlist also protect a newly navigated call page.
    let permitted = !stopping && needed.allSatisfy { kind, device in
      enabled.contains(kind) && GuildDevices.authorizationStatus(for: device) == .authorized
    }
    decisionHandler(permitted ? .grant : .deny)
  }
  func denied(_ kind: String) {
    deviceErrors[kind] =
      "Allow RuneSpace Calls to use the " + (kind == "mic" ? "microphone" : "camera")
      + " in macOS Privacy & Security."
  }
  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame, sameOrigin(message.frameInfo.request.url),
      message.frameInfo.request.url?.path == endpoint.path, message.body as? String == "ready"
    else { return }
    var args = settings
    args["shareAgents"] = shareAgents
    args["position"] = roster.project(position: position(), sharing: shareAgents)
    web.callAsyncJavaScript(
      "window.runespaceSocial.start(settings); return true", arguments: ["settings": args],
      in: nil, in: .page
    ) { [weak self] result in
      guard let self else { return }
      if case .success = result {
        self.loaded = true
        self.retry = .distantFuture
        self.lastReady = Date()
      } else {
        self.fail()
      }
    }
  }
  func fail() {
    pageGeneration += 1
    loaded = false
    queued = false
    resetCapture()
    retry = Date().addingTimeInterval(3)
    recordOffline("offline", "Could not load the guild call. Reconnecting…")
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    if (error as NSError).code != NSURLErrorCancelled { fail() }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { fail() }
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }
  func position() -> Object? {
    let file = directory.appendingPathComponent("position.json")
    let stamp = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?
      .contentModificationDate
    if stamp != lastPositionStamp {
      latestPosition = jsonObject(file)
      lastPositionStamp = stamp
    }
    return latestPosition
  }
  func command() -> String? {
    let folder = directory.appendingPathComponent("commands")
    if let files = try? FileManager.default.contentsOfDirectory(atPath: folder.path),
      let name = files.filter({ $0.hasSuffix(".json") }).sorted().first
    {
      let path = folder.appendingPathComponent(name)
      let cmd = jsonObject(path)?["kind"] as? String
      try? FileManager.default.removeItem(at: path)
      return cmd
    }
    return nil
  }
  func tick() {
    guard !stopping else { return }
    if kill(parent, 0) != 0 {
      finish()
      return
    }
    if queued {
      if Date().timeIntervalSince(lastReady) > 8 { fail() }
      return
    }
    let cmd = command()
    if cmd == "stop" {
      finish()
      return
    }
    if cmd == "share-on" { shareAgents = true }
    if cmd == "share-off" { shareAgents = false }
    if !loaded {
      if Date() >= retry || Date().timeIntervalSince(lastReady) > 25 {
        retry = .distantFuture
        lastReady = Date()
        web.load(
          URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        )
      }
      write(current)
      return
    }
    var pageCommand: String?
    if let cmd, ["camera", "mic"].contains(cmd) {
      if current[cmd] as? Bool == true {
        enabled.remove(cmd)
        pageCommand = cmd
      } else {
        deviceErrors.removeValue(forKey: cmd)
        requestDevice(cmd)
      }
    } else if cmd == "sound" { pageCommand = cmd }
    if pageCommand == nil, !readyToStart.isEmpty {
      let device = readyToStart.removeFirst()
      starting[device] = Date()
      pageCommand = device
    }
    queued = true
    let generation = pageGeneration
    var args: Object = [
      "position": roster.project(position: position(), sharing: shareAgents),
      "command": NSNull(), "sharing": shareAgents,
    ]
    if let pageCommand { args["command"] = pageCommand }
    web.callAsyncJavaScript(
      "return window.runespaceSocial.step(position,command,sharing)", arguments: args, in: nil, in: .page
    ) { [weak self] result in
      guard let self, !self.stopping, self.pageGeneration == generation else { return }
      self.queued = false
      guard case .success(let value) = result, var snap = value as? Object else {
        self.fail()
        return
      }
      self.lastReady = Date()
      if snap["mediaConnected"] as? Bool != true { self.resetCapture() }
      for (kind, since) in self.starting {
        let pending = snap[kind + "Pending"] as? Bool
        // Older room servers report only the final device state and error.
        if snap[kind] as? Bool == true || pending == false ||
          (pending == nil && (!(snap["error"] as? String ?? "").isEmpty || Date().timeIntervalSince(since) > 30)) {
          self.starting.removeValue(forKey: kind)
          if snap[kind] as? Bool != true { self.enabled.remove(kind) }
        }
      }
      self.updateCaptureWindow()
      for kind in self.requesting.union(self.readyToStart).union(self.starting.keys) {
        snap[kind + "Pending"] = true
      }
      let tiles = (snap["tiles"] as? [Object] ?? []).prefix(8)
      var live = Set<String>()
      snap["tiles"] = tiles.compactMap { tile -> Object? in
        guard let id = tile["id"] as? String, !id.isEmpty, id.utf8.count <= 80,
          id.utf8.allSatisfy({
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45
              || $0 == 95
          })
        else { return nil }
        var info = tile
        let pixels = info.removeValue(forKey: "pixels") as? String
        let name = "tile-" + id + ".rgba"
        let path = self.directory.appendingPathComponent(name)
        if tile["video"] as? Bool == true {
          if let pixels, pixels.utf8.count < 65000, let data = Data(base64Encoded: pixels),
            data.count == 144 * 81 * 4,
            (try? data.write(to: path, options: .atomic)) != nil
          {
            self.frames.insert(name)
          }
          if self.frames.contains(name) {
            live.insert(name)
            info["file"] = name
          }
        }
        return info
      }
      self.clearFrames(except: live)
      if !self.deviceErrors.isEmpty {
        let errors = ["mic", "camera"].compactMap { self.deviceErrors[$0] } + [snap["error"] as? String ?? ""]
        let message = errors.filter { !$0.isEmpty }.joined(separator: " ")
        snap["error"] = message
        snap["message"] = message
      }
      self.write(snap)
    }
  }
  func clearFrames(except keep: Set<String>) {
    for name in frames.subtracting(keep) {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
    frames = keep
  }
  func write(_ value: Object) {
    current = value
    guard let compared = try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
    else { return }
    if compared == lastState && Date().timeIntervalSince(lastWrite) < 1.8 { return }
    var snap = value
    snap["updatedAt"] = Date().timeIntervalSince1970
    snap["running"] = !stopping
    if let data = try? JSONSerialization.data(withJSONObject: snap),
      (try? data.write(to: directory.appendingPathComponent("state.json"), options: .atomic)) != nil
    {
      lastState = compared
      lastWrite = Date()
    }
  }
  func recordOffline(_ status: String, _ message: String) {
    clearFrames(except: [])
    write([
      "status": status, "connected": false, "mediaConnected": false, "mic": false, "camera": false,
      "audioBlocked": false, "peers": [], "tiles": [], "error": status == "offline" ? message : "",
      "message": message,
    ])
  }
  func finish() {
    guard !stopping else { return }
    stopping = true
    timer?.invalidate()
    resetCapture()
    recordOffline("stopped", "")
    web.evaluateJavaScript("window.runespaceSocial?.stop()")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { NSApp.terminate(nil) }
  }
  func applicationWillTerminate(_ notification: Notification) {
    stopping = true
    recordOffline("stopped", "")
    ownerExit?.cancel()
  }
}

guard CommandLine.arguments.count == 4, let parent = Int32(CommandLine.arguments[2]), parent > 1,
  kill(parent, 0) == 0
else { exit(2) }
let appHome = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let directory = appHome.appendingPathComponent("data/runespace-social")
let handle = open(directory.appendingPathComponent("instance.lock").path, O_CREAT | O_RDWR, 0o600)
guard handle >= 0, flock(handle, LOCK_EX | LOCK_NB) == 0 else { exit(1) }
let visit = appHome.appendingPathComponent("data/runespace-visit.json")
let visiting = FileManager.default.fileExists(atPath: visit.path)
let configFile = visiting ? visit : appHome.appendingPathComponent("data/runespace-team.json")
guard let cfg = jsonObject(configFile),
  let text = cfg["url"] as? String,
  var parsed = URLComponents(string: text), let hostname = parsed.host, parsed.user == nil,
  parsed.password == nil,
  parsed.scheme == "https"
    || (parsed.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(hostname))
else { exit(2) }
var hash = URLComponents()
hash.percentEncodedQuery = parsed.percentEncodedFragment
guard let params = hash.queryItems,
  let invite = params.first(where: { $0.name == "invite" })?.value, !invite.isEmpty
else { exit(2) }
var settings: Object = [
  "invite": invite, "name": String((cfg["name"] as? String ?? NSFullUserName()).prefix(32)),
]
if !visiting, let owner = params.first(where: { $0.name == "owner" })?.value { settings["owner"] = owner }
parsed.fragment = nil
parsed.query = nil
parsed.path = "/embedded-guild.html"
guard let endpoint = parsed.url else { exit(2) }
let snapshotKey = CommandLine.arguments[3]
guard ["guild.snapshot", "runespace.snapshot"].contains(snapshotKey),
  let roster = try? GuildRoster(directory: directory, snapshotKey: snapshotKey, endpoint: endpoint,
                                invite: invite, owner: settings["owner"] as? String)
else { exit(2) }
settings["contributorKey"] = roster.contributorKey
settings["shareAgents"] = settings["owner"] != nil || cfg["shareAgents"] as? Bool == true
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let call = GuildCall(directory: directory, endpoint: endpoint, settings: settings, roster: roster, parent: parent)
app.delegate = call
app.run()
Darwin.close(handle)
