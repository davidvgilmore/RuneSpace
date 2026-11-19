// One private browser hosts WebRTC while the existing Metal renderer owns the guild.
import AVFoundation
import AppKit
import Darwin
import WebKit

typealias Object = [String: Any]

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
  let parent: pid_t
  let web: WKWebView
  let window: NSWindow
  var timer: Timer?
  var ownerExit: DispatchSourceProcess?
  var loaded = false, queued = false, stopping = false
  var retry = Date.distantFuture
  var lastReady = Date()
  var lastState = Data(), lastWrite = Date.distantPast
  var lastPositionStamp: Date?, latestPosition: Object?
  var pageGeneration = 0
  var enabled = Set<String>()
  var frames = Set<String>()
  var current: Object = [:]
  var lastDeviceError = ""

  init(directory: URL, endpoint: URL, settings: Object, parent: pid_t) {
    self.directory = directory
    self.endpoint = endpoint
    self.settings = settings
    self.parent = parent
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.mediaTypesRequiringUserActionForPlayback = []
    if #available(macOS 14.0, *) { config.preferences.inactiveSchedulingPolicy = .none }
    let bounds = NSRect(x: 0, y: 0, width: 400, height: 320)
    web = WKWebView(frame: bounds, configuration: config)
    window = NSWindow(contentRect: bounds, styleMask: .borderless, backing: .buffered, defer: false)
    super.init()
    web.navigationDelegate = self
    web.uiDelegate = self
    web.configuration.userContentController.add(self, name: "guild")
    window.contentView = web
    window.isReleasedWhenClosed = false
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    // WebKit defers getUserMedia indefinitely in an unordered macOS window.
    // Attach the call to WindowServer outside all displays without activating it.
    let left = NSScreen.screens.map { $0.frame.minX }.min() ?? 0
    window.setFrameOrigin(NSPoint(x: left - window.frame.width - 1000, y: 0))
    window.isExcludedFromWindowsMenu = true
    window.ignoresMouseEvents = true
    window.alphaValue = 0.01
    window.orderBack(nil)
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
    guard needed.allSatisfy({ enabled.contains($0.0) }) else {
      decisionHandler(.deny)
      return
    }
    func request(_ i: Int) {
      guard i < needed.count else {
        decisionHandler(.grant)
        return
      }
      let (kind, device) = needed[i]
      guard enabled.contains(kind), !stopping else {
        decisionHandler(.deny)
        return
      }
      switch AVCaptureDevice.authorizationStatus(for: device) {
      case .authorized: request(i + 1)
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: device) { ok in
          DispatchQueue.main.async {
            if ok && self.enabled.contains(kind) && !self.stopping {
              request(i + 1)
            } else {
              self.denied(kind)
              decisionHandler(.deny)
            }
          }
        }
      default:
        denied(kind)
        decisionHandler(.deny)
      }
    }
    request(0)
  }
  func denied(_ kind: String) {
    lastDeviceError =
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
    args["position"] = position()
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
    enabled.removeAll()
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
    if let cmd, ["camera", "mic"].contains(cmd) {
      lastDeviceError = ""
      if current[cmd] as? Bool == true { enabled.remove(cmd) } else { enabled.insert(cmd) }
    }
    queued = true
    let generation = pageGeneration
    var args: Object = ["position": NSNull(), "command": NSNull()]
    if let p = position() { args["position"] = p }
    if let cmd { args["command"] = cmd }
    web.callAsyncJavaScript(
      "return window.runespaceSocial.step(position,command)", arguments: args, in: nil, in: .page
    ) { [weak self] result in
      guard let self, !self.stopping, self.pageGeneration == generation else { return }
      self.queued = false
      guard case .success(let value) = result, var snap = value as? Object else {
        self.fail()
        return
      }
      self.lastReady = Date()
      if snap["mediaConnected"] as? Bool != true { self.enabled.removeAll() }
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
      if !self.lastDeviceError.isEmpty {
        snap["error"] = self.lastDeviceError
        snap["message"] = self.lastDeviceError
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
    enabled.removeAll()
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

guard CommandLine.arguments.count == 3, let parent = Int32(CommandLine.arguments[2]), parent > 1,
  kill(parent, 0) == 0
else { exit(2) }
let appHome = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let directory = appHome.appendingPathComponent("data/runespace-social")
let handle = open(directory.appendingPathComponent("instance.lock").path, O_CREAT | O_RDWR, 0o600)
guard handle >= 0, flock(handle, LOCK_EX | LOCK_NB) == 0 else { exit(1) }
guard let cfg = jsonObject(appHome.appendingPathComponent("data/runespace-team.json")),
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
if let owner = params.first(where: { $0.name == "owner" })?.value { settings["owner"] = owner }
parsed.fragment = nil
parsed.query = nil
parsed.path = "/embedded-guild.html"
guard let endpoint = parsed.url else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let call = GuildCall(directory: directory, endpoint: endpoint, settings: settings, parent: parent)
app.delegate = call
app.run()
Darwin.close(handle)
