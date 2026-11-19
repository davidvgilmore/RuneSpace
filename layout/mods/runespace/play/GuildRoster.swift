// Only this local bridge reads Herdr session identifiers. Its output is safe to hand to the room.
import CryptoKit
import Foundation

final class GuildRoster {
    private let directory: URL
    private let sharedFile: URL
    private let snapshotKey: String
    private let agentKey: SymmetricKey
    let contributorKey: String
    private var nextRead = Date.distantPast
    private var lastSnapshot = Date.distantPast
    private var roster = [[String:String]]()
    private var ids = [String:String]() // Raw local key to room-specific id
    private var savedBindings: [String:String]?

    private static func digest(_ value: String, with key: SymmetricKey) -> String {
        HMAC<SHA256>.authenticationCode(for: Data(value.utf8), using: key)
            .map { String(format: "%02x", $0) }.joined()
    }

    init(directory: URL, snapshotKey: String, endpoint: URL, invite: String, owner: String?) throws {
        self.directory = directory
        self.snapshotKey = snapshotKey
        sharedFile = directory.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared.json")
        let seedFile = directory.appendingPathComponent("roster-seed")
        let seed: Data
        if FileManager.default.fileExists(atPath: seedFile.path) {
            seed = try Data(contentsOf: seedFile)
            guard seed.count == 32 else { throw CocoaError(.fileReadCorruptFile) }
        } else {
            seed = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
            try seed.write(to: seedFile, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: seedFile.path)
        }
        let master = SymmetricKey(data: seed)
        let origin = (endpoint.scheme ?? "") + "://" + (endpoint.host ?? "") + ":" + String(endpoint.port ?? (endpoint.scheme == "https" ? 443 : 80))
        let room = origin + "\0" + invite
        contributorKey = Self.digest("device\0" + room, with: master)
        agentKey = SymmetricKey(data: Data((owner ?? Self.digest("roster\0" + room, with: master)).utf8))
    }

    private func clear() {
        ids.removeAll()
        roster.removeAll()
        lastSnapshot = .distantPast
    }

    private func refresh(_ now: Date) {
        guard now >= nextRead else { return }
        nextRead = now.addingTimeInterval(1)
        guard let bytes = try? Data(contentsOf: sharedFile),
              let root = (try? JSONSerialization.jsonObject(with: bytes)) as? [String:Any],
              let snapshot = root[snapshotKey] as? [String:Any],
              let at = snapshot["at"] as? Double,
              let agents = snapshot["agents"] as? [[String:Any]] else {
            if now.timeIntervalSince(lastSnapshot) >= 60 { clear() }
            return
        }
        let observed = Date(timeIntervalSince1970: at)
        guard (-10..<60).contains(now.timeIntervalSince(observed)) else { clear(); return }
        guard observed != lastSnapshot else { return }
        lastSnapshot = observed
        var nextIds = [String:String]()
        var nextRoster = [[String:String]]()
        for agent in agents {
            guard let key = agent["key"] as? String, !key.isEmpty, nextIds[key] == nil,
                  agent["mapVisible"] as? Bool != false, agent["connectionUnavailable"] as? Bool != true,
                  !["unknown","offline"].contains(agent["presence"] as? String ?? ""),
                  let status = agent["status"] as? String, ["working","idle","blocked","error"].contains(status)
            else { continue }
            let kind = agent["kind"] as? String ?? "Agent"
            let id = ids[key] ?? Self.digest(key, with: agentKey)
            nextIds[key] = id
            nextRoster.append(["id":id, "status":status,
                               "kind":["Claude","Codex","OpenCode","Pi","Hermes"].contains(kind) ? kind : "Agent"])
            if nextRoster.count == 64 { break }
        }
        ids = nextIds
        roster = nextRoster
    }

    private func saveBindings() {
        guard savedBindings != ids else { return }
        let dict = Dictionary(uniqueKeysWithValues: ids.map { ($0.value,$0.key) })
        if let bytes = try? JSONSerialization.data(withJSONObject: dict),
           (try? bytes.write(to: directory.appendingPathComponent("agent-bindings.json"), options:.atomic)) != nil {
            savedBindings = ids
        }
    }

    func project(position: [String:Any]?, sharing: Bool) -> [String:Any] {
        if sharing { refresh(Date()) }
        else if !ids.isEmpty { clear(); nextRead = .distantPast }
        saveBindings()
        var result: [String:Any] = ["roster":roster]
        guard let position else { return result }
        for field in ["x","z","yaw","sceneAt"] {
            if let value = position[field] as? Double, value.isFinite { result[field] = value }
        }
        result["moving"] = position["moving"] as? Bool ?? false
        let activity = position["activity"] as? String ?? "idle"
        result["activity"] = ["idle","wood","attack","dance"].contains(activity) ? activity : "idle"
        if let gear = position["loadout"] as? [String:String] {
            let slots = ["head","cape","torso","weapon","shield","legs","boots"]
            result["loadout"] = gear.filter { slots.contains($0.key) && $0.value.range(of:"^[a-z0-9-]{1,48}$", options:.regularExpression) != nil }
        }
        let activities = ["wood","mine","smith","farm","fish","waiting","idle","blocked","error","unknown"]
        if sharing, let scene = position["agents"] as? [[Any]] {
            result["agents"] = scene.prefix(64).compactMap { row -> [Any]? in
                guard row.count == 6, let key = row[0] as? String, let id = ids[key],
                      let x = row[1] as? Double, let z = row[2] as? Double, let yaw = row[3] as? Double,
                      x.isFinite, z.isFinite, yaw.isFinite, let action = row[4] as? String, activities.contains(action),
                      let moving = row[5] as? Bool else { return nil }
                return [id,x,z,yaw,action,moving]
            }
        }
        return result
    }
}
