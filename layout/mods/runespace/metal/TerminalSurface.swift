import Foundation
import Metal
import QuartzCore
import Darwin

// A terminal client grants a slot for a single frame and controls its reuse after
// presentation. The GPU blits straight into a page-aligned file mapping.
private final class FrameSlot {
    let file: URL
    let buffer: MTLBuffer
    let capacity: Int

    init(device: MTLDevice, file: URL, bytes: Int) throws {
        self.file = file
        let page = Int(getpagesize())
        capacity = ((bytes + page - 1) / page) * page
        let fd = open(file.path, O_RDWR | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw problem("Could not create a private frame slot") }
        defer { close(fd) }
        guard ftruncate(fd, off_t(capacity)) == 0,
              let memory = mmap(nil, capacity, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0), memory != MAP_FAILED else {
            throw problem("Could not map a frame slot")
        }
        guard let mapped = device.makeBuffer(bytesNoCopy: memory, length: capacity, options: .storageModeShared,
                                              deallocator: { ptr, size in munmap(ptr, size) }) else {
            munmap(memory, capacity)
            throw problem("Metal could not import the frame slot")
        }
        buffer = mapped
    }
}

private final class Targets {
    let width, height: Int
    let color: MTLTexture
    let pass = MTLRenderPassDescriptor()

    init(device: MTLDevice, width: Int, height: Int, samples: Int) throws {
        self.width=width; self.height=height
        func texture(_ format: MTLPixelFormat, _ count: Int) throws -> MTLTexture {
            let desc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat:format,width:width,height:height,mipmapped:false)
            desc.sampleCount=count
            desc.textureType=count==1 ? .type2D : .type2DMultisample
            desc.storageMode = .private
            desc.usage = .renderTarget
            guard let tex=device.makeTexture(descriptor:desc) else {throw problem("Could not allocate the world surface")}
            return tex
        }
        color=try texture(.rgba8Unorm,1)
        let attachment=pass.colorAttachments[0]!
        if samples>1 {
            attachment.texture=try texture(.rgba8Unorm,samples)
            attachment.resolveTexture=color
            attachment.storeAction = .multisampleResolve
        } else {
            attachment.texture=color
            attachment.storeAction = .store
        }
        attachment.loadAction = .clear
        attachment.clearColor=GPUScene.sky
        pass.depthAttachment.texture=try texture(.depth32Float,samples)
        pass.depthAttachment.loadAction = .clear
        pass.depthAttachment.storeAction = .dontCare
        pass.depthAttachment.clearDepth=1
    }
}

private struct TeamPeer: Codable {
    let id, name: String
    let x, z, yaw: Double
    let moving: Bool?
    let activity: String?
    let loadout, gear: [String:String]?
}

private struct FrameRequest: Decodable {
    let type: String
    let width, height, slot: Int?
    let keys: [String]?
    let orbit, tilt, zoom, viewZoom, hudScale: Double?
    let walk, click, pointer: [Double]?
    let talk: String?
    let home, nearest, cancel, names, dance, inspect: Bool?
    let benchmark, teamSelf: String?
    let teamPeers: [TeamPeer]?
}

final class TerminalSurface {
    private let scene: GPUScene
    private let engine: WorldEngine
    private let device: MTLDevice, queue: MTLCommandQueue
    private let samples: Int
    private let shared: URL, directory: URL
    private let decoder=JSONDecoder()
    private var targets: Targets?
    private var slots=[Int:FrameSlot]()
    private var camera=GPUCamera()
    private var savedCamera: GPUCamera?
    private var previous: GuildFrame?
    private let labels = WorldLabels()
    private var pointer: CGPoint?
    private var teamSelf = ""
    private var last=0.0, lastSync=0.0

    init(assets: URL, home: URL, directory: URL) throws {
        guard let gpu=MTLCreateSystemDefaultDevice(), let queue=gpu.makeCommandQueue() else {throw problem("Metal is unavailable")}
        self.device=gpu; self.queue=queue; self.directory=directory
        self.shared=home.appendingPathComponent("shared.json")
        samples=gpu.supportsTextureSampleCount(4) ? 4 : 1
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        let saved=object(at:shared)
        let lastPose=object(at:home.appendingPathComponent("data/runespace-play-position.json")) as? [String:Double]
        let position=lastPose.flatMap { $0["x"] != nil && $0["z"] != nil ? $0 : nil }
        engine=try WorldEngine(bundle:assets.appendingPathComponent("engine.bundle.js"),
                               saved:position ?? (saved["runespace.worldPosition"] as? [String:Any] ?? [:]),
                               adventureURL:home.appendingPathComponent("data/runespace-adventure.json"))
        engine.sync(saved)
        if let cam=lastPose ?? (saved["runespace.worldCamera"] as? [String:Double]) {
            camera.restore(cam)
        }
        scene=try GPUScene(device:gpu,assetURL:assets.appendingPathComponent("assets.json"),format:.rgba8Unorm,samples:samples)
        last=CACurrentMediaTime()
    }
    private func send(_ object: [String:Any]) {
        FileHandle.standardOutput.write(Data((json(object)+"\n").utf8))
    }
    func serve() {
        defer { engine.flushAdventure() }
        send(["type":"ready","format":"rgba8","slots":4])
        while let input=readLine() {
            let done=autoreleasepool { () -> Bool in
                do {
                    let request=try decoder.decode(FrameRequest.self,from:Data(input.utf8))
                    if request.type=="quit" {return true}
                    guard request.type=="frame" else {throw problem("Unknown frame request")}
                    try draw(request)
                } catch {send(["type":"error","message":error.localizedDescription])}
                return false
            }
            if done {break}
        }
    }
    private func nearest(_ f: GuildFrame?) -> Actor? {
        guard let f else {return nil}
        func distance(_ a:Actor)->Float {hypot(a.x-f.player.x,a.z-f.player.z)}
        return f.npcs.filter{distance($0)<2.8}.min{distance($0)<distance($1)}
    }
    private func point(_ coords: [Double]?) -> CGPoint? {
        guard let coords,coords.count==2 else {return nil}
        return CGPoint(x:coords[0],y:coords[1])
    }
    private func draw(_ r: FrameRequest) throws {
        guard let requested=r.width,let h=r.height,let n=r.slot,1...4096 ~= requested,1...2304 ~= h,0...3 ~= n else {
            throw problem("Frame needs a supported size and an available slot")
        }
        let w=((requested+63)/64)*64, bytes=w*h*4
        if targets?.width != w || targets?.height != h {targets=try Targets(device:device,width:w,height:h,samples:samples)}
        if slots[n] == nil || slots[n]!.capacity < bytes {
            slots[n]=try FrameSlot(device:device,file:directory.appendingPathComponent("slot-\(n).rgba"),bytes:bytes)
        }
        let slot=slots[n]!, target=targets!
        let now=CACurrentMediaTime(), dt=min(0.1,max(0.001,now-last))
        last=now
        if now-lastSync>1 {engine.sync(object(at:shared));lastSync=now}
        if let identity = r.teamSelf { teamSelf = identity }
        if let peers = r.teamPeers {
            let snapshot = try JSONEncoder().encode(peers)
            engine.call("guildTeamSync", [String(decoding:snapshot, as:UTF8.self), teamSelf])
        }
        let keys=Set(r.keys ?? [])
        if r.benchmark == "begin" && savedCamera == nil {
            savedCamera=camera
            engine.call("guildBenchmark",["begin"])
            camera.restore([:]);camera.zoom=0.59;camera.focus=SIMD2(0,1.725)
        } else if r.benchmark == "restore", let original=savedCamera {
            camera=original;savedCamera=nil
            engine.call("guildBenchmark",["restore"])
        }
        camera.size=CGSize(width:w,height:h)
        camera.yaw+=Float(r.orbit ?? 0)
        if let tilt=r.tilt {camera.setPitch(camera.pitch+Float(tilt))}
        camera.applyCameraKeys(keys, dt:dt)
        camera.zoom=max(0.45,min(2.6,Float(r.viewZoom ?? (Double(camera.zoom)*exp(r.zoom ?? 0)))))
        if r.dance==true {engine.call("guildDance",[])}
        if r.home==true {
            engine.call("guildWalk",[0,10.5]);camera.restore([:])
        }
        if r.cancel==true {engine.call("guildStop",[])}
        if let p=point(r.walk) {engine.call("guildWalk",[p.x,p.y])}
        if let key=r.talk {engine.call("guildTalk",[key])}
        if let p=point(r.click) {
            if let pick=camera.pick(p,from:previous) {engine.interact(pick)}
            else {let world=camera.ground(p);engine.call("guildWalk",[Double(world.x),Double(world.y)])}
        }
        let frame=try engine.step(dt,keys:keys,yaw:camera.yaw)
        let close = nearest(frame)
        let arrived=(r.nearest==true ? close?.key:nil) ?? frame.arrived
        camera.follow(frame.player)
        previous=frame
        if let position=point(r.pointer) { pointer=position }
        let hover=pointer.flatMap {camera.pick($0,from:frame)}
        guard let cb=queue.makeCommandBuffer(),let encoder=cb.makeRenderCommandEncoder(descriptor:target.pass) else {
            throw problem("Metal could not start the frame")
        }
        let visible=scene.encode(frame,camera:camera,hovered:hover?.key,encoder:encoder)
        guard let blit=cb.makeBlitCommandEncoder() else {throw problem("Metal could not copy the frame")}
        blit.copy(from:target.color,sourceSlice:0,sourceLevel:0,sourceOrigin:MTLOrigin(x:0,y:0,z:0),
                  sourceSize:MTLSize(width:w,height:h,depth:1),to:slot.buffer,destinationOffset:0,
                  destinationBytesPerRow:w*4,destinationBytesPerImage:bytes)
        blit.endEncoding()
        cb.commit();cb.waitUntilCompleted()
        guard cb.status == .completed else {throw cb.error ?? problem("Metal frame did not finish")}
        if r.names == true || hover != nil || close != nil || !frame.humans.isEmpty {
            labels.draw(frame:frame,camera:camera,target:hover ?? close.map(WorldPick.agent),names:r.names == true,
                        into:slot.buffer.contents(),width:w,height:h,hudScale:CGFloat(r.hudScale ?? 1))
        }
        let actors=frame.npcs.map { a -> [String:Any] in
            let p=camera.screen(a.x,a.elevation,a.z),head=camera.screen(a.x,a.elevation+a.height,a.z)
            return ["key":a.key,"name":a.name ?? a.key,"kind":a.kind ?? "Adventurer","host":a.host ?? "",
                    "activity":a.activity ?? "idle","status":a.status ?? "unknown","x":p.x,"y":p.y,"headY":head.y,
                    "worldX":a.x,"worldZ":a.z,"yaw":a.yaw,"moving":a.moving]
        }
        let loadout = frame.player.loadout ?? [:]
        let teamPose: [String:Any] = ["x":frame.player.x, "z":frame.player.z, "yaw":frame.player.yaw,
            "activity":frame.player.activity ?? "idle", "moving":frame.player.moving, "loadout":loadout, "gear":loadout]
        let teamCharacters = frame.humans.map { actor -> [String:Any] in
            let feet = camera.screen(actor.x,actor.elevation,actor.z)
            let head = camera.screen(actor.x,actor.elevation+actor.height,actor.z)
            return ["id":String(actor.key.dropFirst("human:".count)), "name":actor.name ?? "Teammate",
                "x":actor.x, "z":actor.z, "yaw":actor.yaw, "activity":actor.activity ?? "idle", "moving":actor.moving,
                "screenX":feet.x, "screenY":feet.y, "headY":head.y]
        }
        var response: [String:Any] = ["type":"frame","slot":n,"path":slot.file.path,"width":w,"height":h,"size":bytes,
              "at":CACurrentMediaTime(),"x":frame.player.x,"z":frame.player.z,"yaw":camera.yaw,"zoom":camera.zoom,"pitch":camera.pitch,
              "playerActivity":frame.player.activity ?? "idle","equipment":frame.player.parts ?? [],"dancePhase":(frame.player.activity == "dance" ? frame.player.posePhase : nil) as Any? ?? NSNull(),
              "teamPose":teamPose,"teamCharacters":teamCharacters,"agents":actors,"arrived":arrived as Any? ?? NSNull(),"visible":visible,
              "hovered":hover?.key as Any? ?? NSNull(),"nearest":close?.key as Any? ?? NSNull()]
        if let status = frame.adventure.status(hover:hover?.entity) {
            response["adventureStatus"] = status.title + "  ·  " + status.detail
        }
        if r.inspect == true {
            response["adventure"] = frame.adventure.report(camera:camera)
        }
        send(response)
    }
}
