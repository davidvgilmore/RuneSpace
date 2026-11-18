import Foundation

// The command palette and `herdr-app do` address the same session keys as mouse picks.
extension WorldWindow {
    func updateCommands(_ shared: [String: Any], initial: Bool = false) {
        guard !bench,
              let command = shared["runespace.worldCommand"] as? [String: Any],
              let stamp = (command["id"] as? NSNumber)?.int64Value,
              stamp != commandStamp else { return }
        commandStamp = stamp
        guard !initial else { return }
        switch command["kind"] as? String {
        case "walk":
            if let x = command["x"] as? Double, let z = command["z"] as? Double {
                engine.call("guildWalk", [x, z])
            }
        case "talk":
            if let key = command["key"] as? String, frame?.npcs.contains(where: { $0.key == key }) == true {
                engine.call("guildTalk", [key])
            }
        case "orbit":
            if let delta = command["delta"] as? Double { orbit(Float(delta)) }
        case "tilt":
            if let delta = command["delta"] as? Double { tilt(Float(delta)) }
        case "home":
            goHome()
        case "dance":
            engine.call("guildDance",[])
        case "inventory":
            end(kind:"inventory")
        case "report":
            guard let frame else { return }
            let report: [String: Any] = [
                "player": ["x": frame.player.x, "z": frame.player.z],
                "playerActivity": frame.player.activity ?? "idle",
                "nearest": nearest()?.key as Any? ?? NSNull(), "yaw": camera.yaw, "zoom": camera.zoom, "pitch": camera.pitch,
                "width": camera.size.width, "height": camera.size.height,
                "at": Int64(Date().timeIntervalSince1970 * 1000),
                "npcs": frame.npcs.map { a -> [String: Any] in
                    let feet = camera.screen(a.x, a.elevation, a.z)
                    return ["key": a.key, "kind": a.kind ?? "", "x": a.x, "z": a.z,
                            "screenX": feet.x, "screenY": feet.y,
                            "activity": a.activity ?? "idle", "moving": a.moving]
                }
            ]
            writeJSON(["kind": "report", "id": Int64(Date().timeIntervalSince1970 * 1000),
                       "report": report], to: dataDir.appendingPathComponent("runespace-metal-event.json"))
        default:
            break
        }
    }
}
