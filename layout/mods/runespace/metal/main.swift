import Cocoa
import MetalKit
import QuartzCore
import Darwin

final class WorldView: MTKView {
    weak var controller: WorldWindow?
    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    override func keyDown(with event:NSEvent) {
        if event.modifierFlags.contains(.command) {super.keyDown(with:event); return}
        controller?.key(event,down:true)
    }
    override func keyUp(with event:NSEvent) {controller?.key(event,down:false)}
    override func mouseDown(with e:NSEvent) {controller?.click(convert(e.locationInWindow,from:nil))}
    override func mouseMoved(with e:NSEvent) {controller?.hover(convert(e.locationInWindow,from:nil))}
    private var rightDragPoint: CGPoint?
    override func rightMouseDown(with event: NSEvent) {
        rightDragPoint = convert(event.locationInWindow, from:nil)
    }
    override func rightMouseDragged(with event: NSEvent) {
        let point = convert(event.locationInWindow, from:nil)
        if let previous = rightDragPoint {
            controller?.orbit(Float(point.x-previous.x)*0.008)
            controller?.tilt(Float(previous.y-point.y)*0.008)
        }
        rightDragPoint = point
    }
    override func rightMouseUp(with event: NSEvent) { rightDragPoint = nil }
    override func scrollWheel(with e:NSEvent) {controller?.zoomBy(Float(e.scrollingDeltaY)*(e.hasPreciseScrollingDeltas ? 0.004 : 0.04))}
    override func magnify(with e:NSEvent) {controller?.zoomBy(Float(e.magnification))}
}

final class SceneLabel: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class WorldWindow:NSObject,NSApplicationDelegate,NSWindowDelegate,MTKViewDelegate {
    let assets: URL, appHome: URL, dataDir: URL, bench: Bool
    let log = PresentationLog()
    var window:NSWindow!, view:WorldView!, scene:GPUScene!, engine:WorldEngine!
    var frame:GuildFrame?, camera=GPUCamera(), keys=Set<String>()
    var start=0.0, last=0.0, lastSync=0.0
    var hoverKey:String?, hoverPoint:CGPoint?, names=false, exiting=false
    var labels=[String:NSTextField](), hud:GuildHUD!
    var commandStamp:Int64?
    var activity:NSObjectProtocol?, parentTimer:Timer?
    var signalSource: DispatchSourceSignal?
    var statusURL:URL {dataDir.appendingPathComponent(bench ? "runespace-metal-bench-status.json":"runespace-metal-status.json")}
    var expectedHerdrPID:pid_t?
    var benchDistance=0.0, benchYaw=0.0, capturing=false
    var movement=[String:Double](), rotation=[String:Double]()
    var captureSuccess=false
    var screenshotURL:URL {dataDir.appendingPathComponent("runespace-metal-frame.png")}

    init(assets:URL, home:URL, bench:Bool){
        self.assets=assets;self.appHome=home;self.dataDir=home.appendingPathComponent("data");self.bench=bench
    }
    func applicationDidFinishLaunching(_ note:Notification) {
        do {try configure()} catch {
            writeJSON(["running":false,"error":error.localizedDescription,"pid":getpid()],to:statusURL)
            fputs(error.localizedDescription+"\n",stderr);NSApp.terminate(nil)
        }
    }
    func configure() throws {
        try FileManager.default.createDirectory(at:dataDir,withIntermediateDirectories:true)
        let shared=object(at:appHome.appendingPathComponent("shared.json"))
        let saved=bench ? ["x":0.0,"z":11.0] : shared["runespace.worldPosition"] as? [String:Double] ?? [:]
        if !bench,let cam=shared["runespace.worldCamera"] as? [String:Double]{
            camera.restore(cam)
        }
        engine=try WorldEngine(bundle:assets.appendingPathComponent("engine.bundle.js"),saved:saved)
        refreshRoster(shared)
        updateCommands(shared,initial:true)
        expectedHerdrPID=NSRunningApplication.runningApplications(withBundleIdentifier:"dev.herdr.app").first?.processIdentifier
        let rect=NSScreen.main?.visibleFrame ?? CGRect(x:0,y:0,width:1280,height:800)
        let width=bench ? rect.width:min(1600.0,rect.width-24),height=bench ? rect.height-36:min(1000.0,rect.height-50)
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:width,height:height),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title=bench ? "Guild world · display benchmark" : "Guild world · RuneSpace"
        window.minSize=CGSize(width:680,height:440);window.isReleasedWhenClosed=false;window.delegate=self
        guard let device=MTLCreateSystemDefaultDevice() else{throw problem("Metal is unavailable on this Mac")}
        view=WorldView(frame:NSRect(x:0,y:0,width:width,height:height),device:device);view.controller=self
        view.framebufferOnly = !bench
        names=bench
        scene=try GPUScene(view:view,assetURL:assets.appendingPathComponent("assets.json"))
        window.contentView=view;window.center();window.acceptsMouseMovedEvents=true
        createControls()
        start=CACurrentMediaTime();last=start
        activity=ProcessInfo.processInfo.beginActivity(options:[.userInitiatedAllowingIdleSystemSleep],reason:"Presenting Guild world")
        view.delegate=self;window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true);window.makeFirstResponder(view)
        signal(SIGUSR1,SIG_IGN)
        let source=DispatchSource.makeSignalSource(signal:SIGUSR1,queue:.main)
        source.setEventHandler { [weak self] in
            self?.window.deminiaturize(nil);self?.window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        }
        source.resume();signalSource=source
        parentTimer=Timer.scheduledTimer(withTimeInterval:1,repeats:true){[weak self]_ in
            guard let self, !self.exiting else{return}
            if let pid=self.expectedHerdrPID,NSRunningApplication(processIdentifier:pid)?.isTerminated != false {self.end(kind:"back");return}
        }
        writeJSON(["running":true,"pid":getpid(),"started":Date().timeIntervalSince1970,"renderer":device.name,"benchmark":bench],to:statusURL)
    }

    func createControls() {
        hud=GuildHUD(in:view,onBack:{[weak self] in self?.goBack()},onNames:{[weak self] in self?.toggleNames()},
                     onCommons:{[weak self] in self?.goHome()},onInventory:{[weak self] in self?.end(kind:"inventory")},onWalk:{[weak self] x,z in
            guard let self else{return}
            self.engine.call("guildWalk",[x,z])
            self.window.makeFirstResponder(self.view)
        })
    }
    func label(_ title:String)->NSTextField {
        let field=SceneLabel(labelWithString:title);field.font = .systemFont(ofSize:12,weight:.medium)
        field.textColor = NSColor(calibratedRed:1,green:0.89,blue:0.58,alpha:1)
        field.drawsBackground=true;field.backgroundColor=NSColor(calibratedWhite:0.1,alpha:0.86)
        field.alignment = .center;field.isSelectable=false;field.lineBreakMode = .byTruncatingTail
        return field
    }
    @objc func goBack(){end(kind:"music")}
    @objc func toggleNames(){names.toggle();window.makeFirstResponder(view)}
    @objc func goHome(){engine.call("guildWalk",[0,10.5]);camera.restore([:]);window.makeFirstResponder(view)}
    func orbit(_ angle:Float){camera.yaw+=angle}
    func tilt(_ angle:Float){camera.setPitch(camera.pitch+angle)}
    func zoomBy(_ amount:Float){camera.zoom=max(0.55,min(2.6,camera.zoom*exp(amount)))}
    func key(_ event:NSEvent,down:Bool) {
        let physical:[UInt16:String]=[0:"a",1:"s",2:"d",13:"w",12:"q",14:"e",15:"r",3:"f",123:"left",124:"right",125:"down",126:"up"]
        if let k=physical[event.keyCode]{if down{keys.insert(k)}else{keys.remove(k)};return}
        guard down && !event.isARepeat else{return}
        switch event.keyCode {
        case 5: engine.call("guildDance",[])
        case 34: end(kind:"inventory")
        case 53: engine.call("guildStop",[])
        case 36,76: if let a=nearest(){end(kind:"chat",agent:a.key)}
        case 45: toggleNames()
        case 24: zoomBy(0.12)
        case 27: zoomBy(-0.12)
        default: break
        }
    }
    func nearest()->Actor? {
        guard let f=frame else{return nil}
        func dist(_ a:Actor)->Float {hypot(a.x-f.player.x,a.z-f.player.z)}
        return f.npcs.filter{dist($0)<2.8}.min{dist($0)<dist($1)}
    }
    func pick(_ point:CGPoint)->Actor? {
        camera.pick(point,from:frame)
    }
    func hover(_ point:CGPoint){hoverPoint=point;hoverKey=pick(point)?.key}
    func click(_ point:CGPoint) {
        guard !bench else{return};window.makeFirstResponder(view)
        if let a=pick(point){engine.call("guildTalk",[a.key])}
        else {let p=camera.ground(point);engine.call("guildWalk",[Double(p.x),Double(p.y)])}
    }
    func windowDidResignKey(_ n:Notification){keys.removeAll()}
    func windowShouldClose(_ sender:NSWindow)->Bool {end(kind:"back");return true}
    func refreshRoster(_ shared:[String:Any]){
        engine.sync(shared)
    }
    func labels(for f:GuildFrame){
        let close=nearest()?.key
        let visible=f.npcs.filter{names || $0.key==hoverKey || $0.key==close}
        let allowed=Set(visible.map(\.key))
        for key in Array(labels.keys) where !allowed.contains(key){labels.removeValue(forKey:key)?.removeFromSuperview()}
        for a in visible {
            let p=camera.screen(a.x,a.elevation+2.4,a.z)
            let field=labels[a.key] ?? label(a.name ?? "Companion")
            if labels[a.key]==nil {view.addSubview(field,positioned:.below,relativeTo:hud);labels[a.key]=field}
            if field.stringValue != a.name {field.stringValue=a.name ?? a.key}
            let w=min(230,max(75,CGFloat(field.stringValue.count)*7.3+10))
            let rect=NSRect(x:(p.x-w/2).rounded(),y:(p.y-16).rounded(),width:w,height:18)
            if field.frame != rect {field.frame=rect}
        }
        let target=f.npcs.first{$0.key==hoverKey || (hoverKey==nil && $0.key==close)}
        hud.update(frame:f,target:target,yaw:camera.yaw,names:names)
    }
    func mtkView(_ view:MTKView,drawableSizeWillChange size:CGSize){camera.size=view.bounds.size}
    func draw(in sender:MTKView) {
        guard !exiting else{return}
        let now=CACurrentMediaTime(),dt=min(0.1,max(0.001,now-last));last=now
        let elapsed=now-start
        var effectiveKeys=keys, phase:String?=nil
        if now-lastSync>=1 {
            lastSync=now
            let shared=object(at:appHome.appendingPathComponent("shared.json"))
            refreshRoster(shared)
            updateCommands(shared)
            if !bench,elapsed>3,let mode=shared["runespace.mode"] as? String,mode != "metal" {end(kind:"back");return}
        }
        let takeCapture=bench && elapsed>=24
        if bench {
            // The wide lens keeps the entire live company in the measured field.
            camera.zoom=0.63
            if capturing {return}
            if elapsed>=3 && !takeCapture {
                let part=min(2,Int((elapsed-3)/7))
                phase=["walking","orbiting","walkingAndOrbiting"][part]
                if part != 1 {effectiveKeys=Int(elapsed*0.65)%2==0 ? ["right"]:["left"]}
                if part != 0 {
                    let dy=Float(dt)*0.9;camera.yaw+=dy;benchYaw+=Double(dy)
                    rotation[phase!,default:0]+=Double(dy)
                }
            }
        } else {
            camera.applyCameraKeys(keys, dt:dt)
        }
        do{
            let f=try engine.step(dt,keys:effectiveKeys,yaw:camera.yaw)
            if let phase, let old=frame {
                let travelled=Double(hypot(f.player.x-old.player.x,f.player.z-old.player.z))
                benchDistance+=travelled;movement[phase,default:0]+=travelled
            }
            frame=f
            if !bench, let arrived=f.arrived {end(kind:"chat",agent:arrived);return}
            camera.follow(f.player)
            camera.size=view.bounds.size
            if let pt=hoverPoint {hoverKey=pick(pt)?.key}
            if takeCapture {
                capturing=scene.render(f,camera:camera,view:sender,hovered:hoverKey,benchmark:nil,log:log,screenshot:screenshotURL) { [weak self] ok in
                    DispatchQueue.main.async {self?.captureSuccess=ok;self?.finishBenchmark()}
                }
            } else {
                scene.render(f,camera:camera,view:sender,hovered:hoverKey,benchmark:phase,log:log)
            }
            labels(for:f)
        }catch{writeJSON(["running":false,"error":error.localizedDescription,"pid":getpid()],to:statusURL);end(kind:"back")}
    }
    func finishBenchmark(){
        guard !exiting else{return};exiting=true;view.isPaused=true
        DispatchQueue.main.asyncAfter(deadline:.now()+0.20){[self] in
            let result:[String:Any]=["pid":getpid(),"clock":"MTLDrawable.presentedTime","scenarios":log.results(),"phases":log.timestamps(),
                                    "roster":frame?.npcs.count ?? 0,"width":Int(view.drawableSize.width),"height":Int(view.drawableSize.height),
                                    "device":view.device?.name ?? "Metal","targetHz":60,"walkDistance":benchDistance,"orbitRadians":benchYaw,
                                    "walkDistanceByPhase":movement,"orbitRadiansByPhase":rotation,"namesOn":names,
                                    "screenshot":captureSuccess ? screenshotURL.path : ""]
            writeJSON(result,to:dataDir.appendingPathComponent("runespace-metal-benchmark.json"));closeProcess()
        }
    }
    func end(kind:String,agent:String?=nil){
        guard !exiting else{return};exiting=true;view?.isPaused=true
        if !bench {
            var evt:[String:Any]=["kind":kind,"id":Int64(Date().timeIntervalSince1970*1000),"yaw":camera.yaw,"zoom":camera.zoom,"pitch":camera.pitch]
            if let p=frame?.player {evt["x"]=p.x;evt["z"]=p.z}
            if let agent {evt["key"]=agent}
            writeJSON(evt,to:dataDir.appendingPathComponent("runespace-metal-event.json"))
            NSRunningApplication.runningApplications(withBundleIdentifier:"dev.herdr.app").first?.activate(options:[])
        }
        closeProcess()
    }
    func closeProcess(){
        parentTimer?.invalidate()
        if let activity {ProcessInfo.processInfo.endActivity(activity)}
        writeJSON(["running":false,"pid":getpid(),"ended":Date().timeIntervalSince1970],to:statusURL)
        NSApp.terminate(nil)
    }
}

if CommandLine.arguments.count==5 && CommandLine.arguments[3]=="terminal" {
    do {
        try TerminalSurface(assets:URL(fileURLWithPath:CommandLine.arguments[1]),home:URL(fileURLWithPath:CommandLine.arguments[2]),
                            directory:URL(fileURLWithPath:CommandLine.arguments[4])).serve()
    } catch {fputs(error.localizedDescription+"\n",stderr);exit(1)}
    exit(0)
}
guard CommandLine.arguments.count==4 else{fputs("Guild world: assets, app home and mode required\n",stderr);exit(2)}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate=WorldWindow(assets:URL(fileURLWithPath:CommandLine.arguments[1]),home:URL(fileURLWithPath:CommandLine.arguments[2]),bench:CommandLine.arguments[3]=="benchmark")
app.delegate=delegate
app.run()
