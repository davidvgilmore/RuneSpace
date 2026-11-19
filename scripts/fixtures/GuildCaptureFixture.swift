// Compiled only by the native capture regression test.
import AVFoundation
import WebKit

func callConfiguration() -> WKWebViewConfiguration {
  let config = WKWebViewConfiguration()
  let prefs = config.preferences
  let setter = NSSelectorFromString("_setMockCaptureDevicesEnabled:")
  let getter = NSSelectorFromString("_mockCaptureDevicesEnabled")
  precondition(prefs.responds(to: setter) && prefs.responds(to: getter))
  typealias SetFlag = @convention(c) (AnyObject, Selector, Bool) -> Void
  typealias GetFlag = @convention(c) (AnyObject, Selector) -> Bool
  unsafeBitCast(prefs.method(for: setter), to: SetFlag.self)(prefs, setter, true)
  precondition(unsafeBitCast(prefs.method(for: getter), to: GetFlag.self)(prefs, getter))
  return config
}

enum GuildDevices {
  static func authorizationStatus(for device: AVMediaType) -> AVAuthorizationStatus {
    let file = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("approved")
    return FileManager.default.fileExists(atPath: file.path) ? .authorized : .notDetermined
  }
  static func requestAccess(for device: AVMediaType, completionHandler: @escaping (Bool) -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { completionHandler(false) }
  }
}
