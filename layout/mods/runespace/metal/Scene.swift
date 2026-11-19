import Cocoa
import ImageIO
import JavaScriptCore
import MetalKit
import QuartzCore
import simd

struct Actor: Decodable {
    let key: String
    let name, host, kind, activity, status: String?
    let x, z, yaw: Float
    let moving: Bool
    let hit: Int?
    let posePhase: Double?
    let parts: [String]?
    let loadout: [String:String]?
    var elevation: Float { x > -18.8 && x < -13.3 && z > 1.9 && z < 4.1 ? 0.43 : 0 }
    let guildClass: String
    let height: Float
}
struct AdventureEntity: Decodable {
    let key, kind, name, activity: String
    let x, z, yaw, height: Float
    let hp, maxHp, hit: Int?
    let posePhase: Double
    var tree: Bool { kind == "oak" }
    var visible: Bool { activity != "hidden" }
    var pickHeight: Float { activity == "stump" ? 0.42 : height }
    var radius: Float { tree ? (activity == "stump" ? 0.48 : 1.3) : kind == "rat" ? 0.76 : 0.48 }
    var prompt: String {
        if activity == "stump" { return "Oak stump" }
        return tree ? "Chop " + name : "Attack " + name
    }
}

enum WorldPick {
    case agent(Actor)
    case human(Actor)
    case adventure(AdventureEntity)

    var key: String {
        switch self { case .agent(let a), .human(let a): return a.key; case .adventure(let a): return a.key }
    }
    var agent: Actor? { if case .agent(let a) = self { return a }; return nil }
    var entity: AdventureEntity? { if case .adventure(let a) = self { return a }; return nil }
}

struct AdventureState: Decodable {
    let entities: [AdventureEntity]
    let targetKey, message: String?
    let hp, maxHp, logs, woodXp, combatXp, revision: Int
    var target: AdventureEntity? { entities.first { $0.key == targetKey } }
    var totals: String { "Logs \(logs)  ·  Woodcutting \(woodXp) XP  ·  Combat \(combatXp) XP" }
    func status(hover: AdventureEntity?) -> (title: String, detail: String)? {
        let message = self.message ?? ""
        if let foe = target, !foe.tree, foe.visible {
            return (message.isEmpty ? foe.name : message, "You \(hp)/\(maxHp) HP  ·  \(foe.name) \(foe.hp ?? 0)/\(foe.maxHp ?? 0) HP")
        }
        if !message.isEmpty { return (message, totals) }
        if let hover { return (hover.prompt, hover.activity == "stump" ? "The oak will grow back" : totals) }
        return nil
    }
}

struct GuildFrame: Decodable {
    let player: Actor
    let npcs, humans: [Actor]
    let adventure: AdventureState
    let arrived: String?
    let time: Double
}
struct MotionClip: Decodable {
    let seconds: Double
    let frames: Int
}
struct TriangleAssets: Decodable {
    let motion: [String:MotionClip]?
    let playerIdle: MotionClip?
    let world: String
    let actors: [String: String]
    let aliases: [String:String]?
}

func problem(_ message: String) -> NSError {
    NSError(domain: "GuildWorld", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
func json(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
}
func object(at url: URL) -> [String: Any] {
    guard let data = try? Data(contentsOf: url), let obj = try? JSONSerialization.jsonObject(with: data) else { return [:] }
    return obj as? [String: Any] ?? [:]
}
func writeJSON(_ obj: [String: Any], to url: URL) {
    do {
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        try data.write(to: url, options: .atomic)
    } catch { NSLog("Guild could not write %@: %@",url.lastPathComponent, error.localizedDescription) }
}

final class WorldEngine {
    private let context = JSContext()!
    private var functions = [String: JSValue]()
    private let decoder = JSONDecoder()
    private static let movementKeys: Set<String> = ["up", "down", "left", "right"]
    private let adventureURL: URL?
    private var savedRevision: Int?
    private var pendingRevision: Int?
    private var savedAdventure: String?
    private var saveRetry = 0.0
    init(bundle: URL, saved: [String: Any], adventureURL: URL?) throws {
        self.adventureURL = adventureURL
        savedAdventure = try adventureURL.flatMap(Self.loadAdventure)
        context.exceptionHandler = { _, error in NSLog("Guild simulation: %@", error?.toString() ?? "error") }
        context.evaluateScript(try String(contentsOf: bundle, encoding: .utf8), withSourceURL: bundle)
        for name in ["guildInit","guildSync","guildTeamSync","guildVisit","guildEquipment","guildFrame","guildWalk","guildTalk","guildInteract","guildSaveAdventure","guildMergedAdventure","guildReconcileAdventure","guildDance","guildStop","guildBenchmark"] {
            guard let fn = context.objectForKeyedSubscript(name), fn.isObject else { throw problem("Missing simulation function " + name) }
            functions[name] = fn
        }
        call("guildInit", [json(saved), savedAdventure ?? "null"])
    }
    private static func loadAdventure(_ url: URL) throws -> String? {
        do { return try String(contentsOf: url, encoding: .utf8) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }

    // Both native views and the classic Herdr view contend on this sidecar, so the
    // lock stays valid when a successful save atomically replaces the JSON inode.
    private func persistAdventure(_ url: URL, revision: Int, wait: Bool = false) throws -> Int {
        let lock = open(url.deletingPathExtension().appendingPathExtension("lock").path, O_CREAT | O_RDWR, 0o600)
        guard lock >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(lock) }
        guard flock(lock, wait ? LOCK_EX : LOCK_EX | LOCK_NB) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let current = try Self.loadAdventure(url)
        guard var value = call("guildSaveAdventure", [])?.toString() else { throw problem("No adventure save") }
        let conflict = current != savedAdventure
        if conflict {
            guard let merged = call("guildMergedAdventure", [savedAdventure ?? "null", value, current ?? "null"])?.toString()
            else { throw problem("Could not reconcile adventure progress") }
            value = merged
        }
        try Data(value.utf8).write(to: url, options: .atomic)
        savedAdventure = value
        if conflict, let restored = call("guildReconcileAdventure", [value]) { return Int(restored.toInt32()) }
        return revision
    }

    func flushAdventure() {
        guard let adventureURL, let revision = pendingRevision else { return }
        do {
            savedRevision = try persistAdventure(adventureURL, revision: revision, wait: true)
            pendingRevision = nil
        } catch { NSLog("Could not save adventure on exit: %@", error.localizedDescription) }
    }

    func sync(_ shared:[String:Any]) {
        call("guildEquipment",[json(shared["runespace.loadout"] as? [String:Any] ?? [:])])
        guard let snap=shared["runespace.snapshot"] as? [String:Any],let agents=snap["agents"] as? [[String:Any]] else{return}
        let stale=Date().timeIntervalSince1970-(snap["at"] as? Double ?? 0)>35
        call("guildSync",[json(agents),stale])
    }
    @discardableResult func call(_ name: String, _ args: [Any]) -> JSValue? {
        functions[name]?.call(withArguments: args)
    }
    func interact(_ pick: WorldPick) {
        switch pick {
        case .agent(let agent): call("guildTalk", [agent.key])
        case .human(let human): call("guildVisit", [human.x, human.z])
        case .adventure(let entity): call("guildInteract", [entity.key])
        }
    }
    func step(_ dt: Double, keys: Set<String>, yaw: Float) throws -> GuildFrame {
        let input = Dictionary(uniqueKeysWithValues: keys.intersection(Self.movementKeys).map { ($0,true) })
        guard let str = call("guildFrame",[dt,json(input),Double(yaw)])?.toString() else { throw problem("No world frame") }
        let frame = try decoder.decode(GuildFrame.self, from: Data(str.utf8))
        let revision = frame.adventure.revision
        if savedRevision != revision, CACurrentMediaTime() >= saveRetry {
            if let adventureURL, savedRevision != nil {
                pendingRevision = revision
                do {
                    savedRevision = try persistAdventure(adventureURL, revision: revision)
                    pendingRevision = nil
                }
                catch let error as POSIXError where error.code == .EAGAIN {
                    // Keep movement responsive while the classic view is finishing a save.
                    saveRetry = CACurrentMediaTime() + 0.05
                } catch {
                    NSLog("Could not save adventure: %@", error.localizedDescription)
                    saveRetry = CACurrentMediaTime() + 1
                }
            } else { savedRevision = revision }
        }
        return frame
    }
}

private struct Uniforms {
    var right: SIMD4<Float>
    var vertical: SIMD4<Float>
    var depth: SIMD4<Float>
    var origin: SIMD4<Float>
    var model: SIMD4<Float>
    var options: SIMD4<Float>
}
struct GPUCamera {
    var yaw: Float = 0.18, zoom: Float = 1.13
    var focus = SIMD2<Float>(0, 2)
    var size = CGSize(width: 1280, height: 800)
    static let defaultPitch: Float = 0.82
    private(set) var pitch = defaultPitch
    mutating func setPitch(_ angle: Float) {
        guard angle.isFinite else { return }
        pitch = min(1.35, max(0.35, angle))
    }
    mutating func applyCameraKeys(_ keys: Set<String>, dt: Double) {
        let turnLeft = keys.contains("a") || keys.contains("q")
        let turnRight = keys.contains("d") || keys.contains("e")
        let raise = keys.contains("w") || keys.contains("r")
        let lower = keys.contains("s") || keys.contains("f")
        yaw += Float((turnRight ? 1 : 0) - (turnLeft ? 1 : 0)) * Float(dt)
        setPitch(pitch + Float((raise ? 1 : 0) - (lower ? 1 : 0)) * Float(dt) * 0.8)
    }
    mutating func restore(_ saved: [String: Double]) {
        yaw = Float(saved["yaw"] ?? 0.18)
        zoom = Float(saved["zoom"] ?? 1.13)
        setPitch(saved["pitch"].map(Float.init) ?? Self.defaultPitch)
    }
    mutating func follow(_ player: Actor) {
        focus = SIMD2(player.x * 0.60, player.z * 0.45 - 3)
    }
    var scale: Float { min(Float(size.width)/37,Float(size.height)/28)*zoom }
    var right: SIMD3<Float> { SIMD3(cos(yaw),0,-sin(yaw)) }
    var down: SIMD3<Float> { SIMD3(sin(yaw)*sin(pitch),-cos(pitch),cos(yaw)*sin(pitch)) }
    var direction: SIMD3<Float> { SIMD3(-sin(yaw)*cos(pitch),-sin(pitch),-cos(yaw)*cos(pitch)) }
    func screen(_ x: Float, _ y: Float, _ z: Float) -> CGPoint {
        let v = SIMD3(x-focus.x,y,z-focus.y)
        return CGPoint(x:size.width/2+CGFloat(simd_dot(v,right)*scale),y:size.height*0.52+CGFloat(simd_dot(v,down)*scale))
    }
    func pick(_ point: CGPoint, from frame: GuildFrame?) -> WorldPick? {
        guard let frame else { return nil }
        func hits(_ x: Float, _ z: Float, _ elevation: Float, _ height: Float, _ width: Float) -> Bool {
            let feet = screen(x,elevation,z), head = screen(x,elevation+height,z)
            let radius = max(5,CGFloat(scale * width)), depth = radius*CGFloat(sin(pitch))
            return abs(point.x-feet.x) < radius && point.y >= head.y-max(2,depth) && point.y <= feet.y+max(3,depth)
        }
        // Agents remain reachable when someone is working behind a tree or creature.
        if let actor = frame.npcs.filter({ hits($0.x,$0.z,$0.elevation,$0.height,0.47) })
            .max(by: { screen($0.x,0,$0.z).y < screen($1.x,0,$1.z).y }) { return .agent(actor) }
        if let entity = frame.adventure.entities.filter({ $0.visible && hits($0.x,$0.z,0,$0.pickHeight,$0.radius) })
            .max(by: { screen($0.x,0,$0.z).y < screen($1.x,0,$1.z).y }) { return .adventure(entity) }
        if let human = frame.humans.filter({ hits($0.x,$0.z,$0.elevation,$0.height,0.47) })
            .max(by: { screen($0.x,0,$0.z).y < screen($1.x,0,$1.z).y }) { return .human(human) }
        return nil
    }
    func ground(_ point: CGPoint) -> SIMD2<Float> {
        let x = Float(point.x-size.width/2)/scale, s = Float(point.y-size.height*0.52)/scale/sin(pitch)
        return focus + SIMD2(cos(yaw)*x+sin(yaw)*s,-sin(yaw)*x+cos(yaw)*s)
    }
}

final class PresentationLog {
    private struct Sample {
        let label: String, time: Double, visible: Int, total: Int
    }
    private var records: [Sample] = []
    private let lock = NSLock()
    func add(_ label: String, time: Double, visible: Int, total: Int) {
        guard time > 0 else { return }
        lock.lock(); defer { lock.unlock() }
        records.append(Sample(label: label,time:time,visible:visible,total:total))
    }
    func timestamps() -> [String:[Double]] {
        lock.lock(); defer { lock.unlock() }
        let names = ["walking":"walk","orbiting":"orbit","walkingAndOrbiting":"walk_orbit"]
        return Dictionary(uniqueKeysWithValues:names.map { label, key in
            (key,records.filter{$0.label==label}.map(\.time).sorted())
        })
    }
    func results() -> [String:Any] {
        lock.lock(); let all = records; lock.unlock()
        var output = [String:Any]()
        for label in ["walking","orbiting","walkingAndOrbiting"] {
            let samples = all.filter { $0.label == label }.sorted { $0.time < $1.time }
            let ms = zip(samples.dropFirst(),samples).map { ($0.time-$1.time)*1000 }.sorted()
            guard let start = samples.first, let end = samples.last, end.time>start.time, !ms.isEmpty else { continue }
            func percentile(_ p: Double) -> Double { ms[min(ms.count-1,Int(ceil(Double(ms.count)*p))-1)] }
            output[label] = ["frames":samples.count,"seconds":end.time-start.time,"fps":Double(ms.count)/(end.time-start.time),
                             "p50Ms":percentile(0.5),"p95Ms":percentile(0.95),"p99Ms":percentile(0.99),
                             "worstMs":ms.last!,"over25Ms":ms.filter{$0>25}.count,"minimumVisibleAgents":samples.map(\.visible).min()!,
                             "maximumRoster":samples.map(\.total).max()!,"allAgentsInViewport":samples.allSatisfy{$0.visible==$0.total}]
        }
        return output
    }
}

private let shaders = """
#include <metal_stdlib>
using namespace metal;
struct Vertex {packed_float3 xyz;packed_float4 color;};
struct Params {float4 right,vertical,depth,origin,model,options;};
struct Out {float4 pos [[position]];float4 color;};
vertex Out guildVertex(device const Vertex* vertices [[buffer(0)]],constant Params& p [[buffer(1)]],
                       device const Vertex* next [[buffer(2)]],uint i [[vertex_id]]) {
    float3 v=mix(float3(vertices[i].xyz),float3(next[i].xyz),p.options.x);
    float3 w=float3(p.model.x+v.x*p.model.z+v.z*p.model.w, v.y+p.origin.w,p.model.y-v.x*p.model.w+v.z*p.model.z);
    float3 r=w-p.origin.xyz; Out o; o.pos=float4(dot(r,p.right.xyz),dot(r,p.vertical.xyz)-0.04,dot(r,p.depth.xyz)*0.008+0.5,1);
    if (p.options.y > 0.5) {
        float3 center = float3(p.model.x, p.origin.w, p.model.y) - p.origin.xyz;
        float2 projected = float2(dot(center,p.right.xyz),dot(center,p.vertical.xyz)-0.04);
        o.pos = float4(projected + v.xy * float2(length(p.right.xyz),length(p.vertical.xyz)), v.z, 1);
    }
    o.color=mix(float4(vertices[i].color),float4(next[i].color),p.options.x); return o;
}
fragment float4 guildFragment(Out p [[stage_in]]) {
    return p.color;
}
"""

private struct MeshBuffer {
    let buffer: MTLBuffer
    let count: Int
}

final class GPUScene {
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let depth: MTLDepthStencilState
    private let ground: MeshBuffer
    private let clips: [String:MotionClip]
    private let playerIdle: MotionClip
    private let meshes: [String:MeshBuffer]
    private let decals: [String:MeshBuffer]
    private var offsets = [String:Double]()
    private func phaseOffset(for key: String) -> Double {
        if let offset=offsets[key] {return offset}
        let hash=key.utf16.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
        let offset=Double(hash % 4096) / 4096
        offsets[key]=offset
        return offset
    }
    private let sem = DispatchSemaphore(value: 3)
    private func mesh(_ key: String) -> MeshBuffer? { meshes[key] }

    convenience init(view: MTKView, assetURL: URL) throws {
        guard let gpu=view.device else { throw problem("Metal device unavailable") }
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .depth32Float
        view.sampleCount=gpu.supportsTextureSampleCount(4) ? 4 : 1
        view.clearColor=Self.sky;view.clearDepth=1
        view.preferredFramesPerSecond=60;view.enableSetNeedsDisplay=false
        try self.init(device:gpu,assetURL:assetURL,format:view.colorPixelFormat,samples:view.sampleCount)
    }
    static let sky=MTLClearColorMake(0.50,0.60,0.39,1)
    init(device gpu: MTLDevice, assetURL: URL, format: MTLPixelFormat, samples: Int) throws {
        guard let queue=gpu.makeCommandQueue() else {throw problem("Metal command queue unavailable")}
        self.device=gpu; self.queue=queue
        let assets = try JSONDecoder().decode(TriangleAssets.self, from: Data(contentsOf: assetURL))
        func buffer(_ data: Data) throws -> MeshBuffer {
            guard data.count>=84, data.count % 84 == 0, let b = data.withUnsafeBytes({ bytes in
                gpu.makeBuffer(bytes: bytes.baseAddress!, length:bytes.count,options:.storageModeShared)
            }) else {throw problem("Invalid triangle buffer")}
            return MeshBuffer(buffer:b,count:data.count/28)
        }
        func unpack(_ encoded:String) throws -> MeshBuffer {
            guard let d = Data(base64Encoded:encoded) else {throw problem("Invalid mesh base64")}
            return try buffer(d)
        }
        ground = try unpack(assets.world)
        var buffers=try assets.actors.mapValues(unpack)
        for (alias,key) in assets.aliases ?? [:] {
            guard let body=buffers[key] else {throw problem("Missing Guild pose "+key)}
            buffers[alias]=body
        }
        meshes=buffers
        playerIdle=assets.playerIdle ?? MotionClip(seconds:1,frames:1)
        guard playerIdle.seconds>0 && playerIdle.frames>0 else {throw problem("Invalid player idle animation timing")}
        if let motion=assets.motion {
            guard motion["idle"] != nil, motion.values.allSatisfy({ $0.seconds>0 && $0.frames>0 }) else {
                throw problem("Invalid Guild animation timings")
            }
            clips=motion
        } else {
            // Support the previous installed asset pack during an upgrade.
            clips=["idle":MotionClip(seconds:1,frames:1),"fish":MotionClip(seconds:1,frames:1),
                   "walk":MotionClip(seconds:2*Double.pi/10,frames:8)].merging(
                Dictionary(uniqueKeysWithValues:["wood","mine","smith"].map{($0,MotionClip(seconds:2*Double.pi/4.8,frames:8))})
            ){original,_ in original}
        }
        var decals = [String: MeshBuffer]()
        for (key, color) in [("shadow",[Float](arrayLiteral:0.12,0.14,0.085,0.42)),("ring",[Float](arrayLiteral:1,0.82,0.34,1)),
                             ("flame",[Float](arrayLiteral:1,0.61,0.13,1)),("ember",[Float](arrayLiteral:0.96,0.26,0.045,1))] {
            var verts=[Float]()
            let ring = key == "ring", flame = key == "flame" || key == "ember"
            let r: Float = ring ? 0.56 : flame ? 0.23 : 0.42
            for i in 0..<16 {
                let a=Float(i) * .pi/8, b=Float(i+1) * .pi/8
                let u=SIMD3(cos(a)*r,0,sin(a)*r), v=SIMD3(cos(b)*r,0,sin(b)*r)
                let points:[SIMD3<Float>] = ring ? [u,v,u*0.87,v,v*0.87,u*0.87] : [u,v,flame ? SIMD3(0.07,0.72,0):.zero]
                for p in points { verts += [p.x,p.y,p.z] + color }
            }
            decals[key]=try buffer(verts.withUnsafeBufferPointer {Data(buffer:$0)})
        }
        // Camera-facing life bars and damage splashes share the actor vertex format.
        func quad(_ vertices: inout [Float], _ x:Float, _ y:Float, _ w:Float, _ h:Float, _ z:Float, _ color:[Float]) {
            for (dx,dy) in [(Float(0),Float(0)),(w,0),(w,h),(0,0),(w,h),(0,h)] {
                vertices += [x+dx,y+dy,z]+color
            }
        }
        for fraction in 0...20 {
            var vertices=[Float]()
            quad(&vertices,-0.61,0,1.22,0.105,0.004,[0.16,0.10,0.08,1])
            quad(&vertices,-0.57,0.02,1.14,0.065,0.003,[0.60,0.13,0.11,1])
            quad(&vertices,-0.57,0.02,1.14*Float(fraction)/20,0.065,0.002,[0.37,0.81,0.23,1])
            decals["life-\(fraction)"]=try buffer(vertices.withUnsafeBufferPointer{Data(buffer:$0)})
        }
        let digits=["010110010010111","111001111100111","111001111001111","101101111001001",
                    "111100111001111","111100111101111","111001001001001","111101111101111","111101111001111"]
        for (index, glyph) in digits.enumerated() {
            var vertices=[Float]()
            for (radius,z,color) in [(Float(0.43),Float(0.003),[Float](arrayLiteral:0.25,0.05,0.035,1)),
                                     (0.37,0.002,[Float](arrayLiteral:0.75,0.12,0.09,1))] {
                for i in 0..<16 {
                    var points:[SIMD2<Float>]=[.zero]
                    for j in i...i+1 {
                        let angle=Float(j)*Float.pi/8, r=radius*(j%2==0 ? 1:0.73)
                        points.append(SIMD2(cos(angle),sin(angle))*r)
                    }
                    for point in points {vertices += [point.x,point.y,z]+color}
                }
            }
            for (i,bit) in glyph.enumerated() where bit == "1" {
                quad(&vertices,Float(i%3)*0.072-0.108,0.108-Float(i/3)*0.072,0.074,0.074,0.001,[1,0.96,0.82,1])
            }
            decals["hit-\(index+1)"]=try buffer(vertices.withUnsafeBufferPointer{Data(buffer:$0)})
        }
        self.decals=decals
        let lib=try gpu.makeLibrary(source:shaders,options:nil)
        let pipe=MTLRenderPipelineDescriptor()
        pipe.vertexFunction=lib.makeFunction(name:"guildVertex");pipe.fragmentFunction=lib.makeFunction(name:"guildFragment")
        pipe.rasterSampleCount=samples;pipe.colorAttachments[0].pixelFormat=format
        pipe.depthAttachmentPixelFormat = .depth32Float
        let blend=pipe.colorAttachments[0]!
        blend.isBlendingEnabled=true;blend.sourceRGBBlendFactor = .sourceAlpha;blend.destinationRGBBlendFactor = .oneMinusSourceAlpha
        blend.sourceAlphaBlendFactor = .one;blend.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        pipeline=try gpu.makeRenderPipelineState(descriptor:pipe)
        let d=MTLDepthStencilDescriptor();d.depthCompareFunction = .lessEqual;d.isDepthWriteEnabled=true
        guard let depth=gpu.makeDepthStencilState(descriptor:d) else {throw problem("Missing depth state")};self.depth=depth
    }

    // Capture the resolved Metal surface after the measured interval. AppKit overlays
    // stay out of this image, and the normal game keeps framebuffer-only drawables.
    private func capture(_ tex: MTLTexture, into url: URL, on cb: MTLCommandBuffer,
                         completion: @escaping (Bool) -> Void) {
        let width=tex.width, height=tex.height, stride=((width*4+255)/256)*256
        guard let dest=device.makeBuffer(length:stride*height,options:.storageModeShared),
              let blit=cb.makeBlitCommandEncoder() else { completion(false); return }
        blit.copy(from:tex,sourceSlice:0,sourceLevel:0,sourceOrigin:MTLOrigin(x:0,y:0,z:0),
                  sourceSize:MTLSize(width:width,height:height,depth:1),to:dest,
                  destinationOffset:0,destinationBytesPerRow:stride,destinationBytesPerImage:stride*height)
        blit.endEncoding()
        cb.addCompletedHandler { result in
            guard result.status == .completed else { completion(false); return }
            DispatchQueue.global(qos:.userInitiated).async {
                let bytes=Data(bytes:dest.contents(),count:stride*height) as CFData
                let flags=CGBitmapInfo(rawValue:CGImageAlphaInfo.premultipliedFirst.rawValue).union(.byteOrder32Little)
                guard let provider=CGDataProvider(data:bytes),
                      let image=CGImage(width:width,height:height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:stride,
                                        space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:flags,provider:provider,decode:nil,
                                        shouldInterpolate:false,intent:.defaultIntent),
                      let output=CGImageDestinationCreateWithURL(url as CFURL,"public.png" as CFString,1,nil) else {
                    completion(false);return
                }
                CGImageDestinationAddImage(output,image,nil)
                completion(CGImageDestinationFinalize(output))
            }
        }
    }

    func encode(_ frame:GuildFrame,camera:GPUCamera,hovered:String?,encoder:MTLRenderCommandEncoder)->Int {
        encoder.setRenderPipelineState(pipeline);encoder.setDepthStencilState(depth)
        let r=camera.right*camera.scale*2/Float(camera.size.width), v=camera.down*(-2)*camera.scale/Float(camera.size.height)
        var params=Uniforms(right:SIMD4(r,0),vertical:SIMD4(v,0),depth:SIMD4(camera.direction,0),origin:SIMD4(camera.focus.x,0,camera.focus.y,0),
                           model:SIMD4(0,0,1,0),options:.zero)
        func draw(_ mesh: MeshBuffer?, at x:Float=0, _ z:Float=0, _ yaw:Float=0, _ elevation:Float=0, next:MeshBuffer?=nil, fraction:Float=0) {
            guard let m=mesh else{return}
            params.model=SIMD4(x,z,cos(yaw),sin(yaw));params.origin.w=elevation
            let blend=next?.count==m.count ? next : nil;params.options.x=blend == nil ? 0:fraction
            encoder.setVertexBuffer(m.buffer,offset:0,index:0)
            encoder.setVertexBytes(&params,length:MemoryLayout<Uniforms>.stride,index:1)
            encoder.setVertexBuffer(blend?.buffer ?? m.buffer,offset:0,index:2)
            encoder.drawPrimitives(type:.triangle,vertexStart:0,vertexCount:m.count)
        }
        draw(ground)
        for entity in frame.adventure.entities where entity.visible {
            let count = entity.tree ? 1 : 8
            let phase = min(Double(1).nextDown,max(0,entity.posePhase)) * Double(count)
            let index = Int(phase), prefix = "Adventure:\(entity.kind):\(entity.activity):"
            if !entity.tree { draw(decals["shadow"],at:entity.x,entity.z,0,0.066) }
            if entity.key == hovered || entity.key == frame.adventure.targetKey {
                draw(decals["ring"],at:entity.x,entity.z,0,0.071)
            }
            draw(mesh(prefix+String(index)),at:entity.x,entity.z,entity.yaw,
                 next:count > 1 ? mesh(prefix+String((index+1)%count)) : nil,fraction:Float(phase-Double(index)))
        }
        var inView=0
        for a in frame.npcs + frame.humans + [frame.player] {
            let local = a.key == frame.player.key
            let player = a.parts != nil
            let bridge=a.elevation
            if !player {
                let head=camera.screen(a.x,a.height+bridge,a.z),feet=camera.screen(a.x,bridge,a.z)
                let bounds=CGRect(origin:.zero,size:camera.size)
                if bounds.contains(head) && bounds.contains(feet) {inView+=1}
            }
            draw(decals["shadow"],at:a.x,a.z,0,bridge+0.066)
            if local || a.key==hovered {draw(decals["ring"],at:a.x,a.z,0,bridge+0.071)}
            let kind=player ? "Player":a.kind ?? "Adventurer", host=player ? "local":a.host ?? "local"
            let job=a.activity ?? "idle"
            let activity=a.moving ? "walk" : clips[job] != nil ? job : "idle"
            let clip=player && activity=="idle" ? playerIdle : (clips[activity] ?? clips["idle"]!)
            let normalized: Double
            if player, let posePhase=a.posePhase {
                normalized=max(0,min(Double(1).nextDown,posePhase))
            } else {
                normalized=(frame.time/clip.seconds+phaseOffset(for:a.key)).truncatingRemainder(dividingBy:1)
            }
            let phase=normalized*Double(clip.frames), index=Int(phase)
            if player,let parts=a.parts,mesh("Gear:head:none:idle:0") != nil {
                for part in parts {
                    let prefix="Gear:\(part):\(activity):"
                    let current=mesh(prefix+String(index))
                    let next=clip.frames>1 ? mesh(prefix+String((index+1)%clip.frames)) : nil
                    draw(current,at:a.x,a.z,a.yaw,bridge,next:next,fraction:Float(phase-Double(index)))
                }
                continue
            }
            func npcPose(_ frameIndex: Int) -> MeshBuffer? {
                let pose = ":\(activity):\(frameIndex)"
                return mesh("\(kind):\(host)" + pose) ?? mesh("\(kind):local" + pose)
                    ?? mesh("Adventurer:\(host)" + pose) ?? mesh("Adventurer:local" + pose)
            }
            let body=npcPose(index)
            let next=clip.frames>1 ? npcPose((index+1)%clip.frames) : nil
            draw(body,at:a.x,a.z,a.yaw,bridge,next:next,fraction:Float(phase-Double(index)))
        }
        let t=Float(frame.time)
        for i in 0..<4 {let phase=t*1.5+Float(i)*1.7;draw(decals[i%2==0 ? "flame":"ember"],at:cos(phase)*0.18,3+sin(phase)*0.18,phase,0.24+sin(phase*3)*0.12)}
        if let target=frame.adventure.target, !target.tree, target.visible {
            params.options.y=1
            func mark(_ x:Float,_ z:Float,_ height:Float,_ hp:Int,_ maximum:Int,_ hit:Int?) {
                let life = max(0,min(20,Int(round(20*Float(hp)/Float(max(1,maximum))))))
                draw(decals["life-\(life)"],at:x,z,0,height+0.21)
                if let hit, hit > 0 {draw(decals["hit-\(min(hit,9))"],at:x,z,0,height*0.60)}
            }
            mark(target.x,target.z,target.height,target.hp ?? 0,target.maxHp ?? 1,target.hit)
            mark(frame.player.x,frame.player.z,frame.player.height+frame.player.elevation,
                 frame.adventure.hp,frame.adventure.maxHp,frame.player.hit)
        }
        encoder.endEncoding()
        return inView
    }

    @discardableResult func render(_ frame:GuildFrame, camera:GPUCamera, view:MTKView, hovered:String?,
                                   benchmark:String?, log:PresentationLog, screenshot:URL?=nil,
                                   captured:((Bool)->Void)?=nil) -> Bool {
        guard sem.wait(timeout:.now()) == .success else {return false}
        guard let drawable=view.currentDrawable,let pass=view.currentRenderPassDescriptor,let cb=queue.makeCommandBuffer(),let encoder=cb.makeRenderCommandEncoder(descriptor:pass) else {sem.signal();return false}
        let inView=encode(frame,camera:camera,hovered:hovered,encoder:encoder)
        if let screenshot, let captured {capture(drawable.texture,into:screenshot,on:cb,completion:captured)}
        if let label=benchmark {
            let count=frame.npcs.count, visible=inView
            drawable.addPresentedHandler { d in log.add(label,time:d.presentedTime,visible:visible,total:count) }
        }
        let sem=self.sem;cb.addCompletedHandler {_ in sem.signal()}
        cb.present(drawable);cb.commit();return true
    }
}
