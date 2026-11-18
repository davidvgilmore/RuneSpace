import Cocoa

// A north-up chart of the guild green. The same projection drives its markers and click targets.
private enum Atlas {
    static let center = CGPoint(x: 68, y: 68)
    static let radius: CGFloat = 58
    static let scale = radius / 23.5
    static func point(_ x: Double, _ z: Double) -> CGPoint {
        CGPoint(x: center.x + CGFloat(x) * scale, y: center.y + CGFloat(z) * scale)
    }
    static func world(_ p: CGPoint) -> (Double, Double) {
        (Double((p.x - center.x) / scale), Double((p.y - center.y) / scale))
    }
}

private enum Ink {
    static func rgb(_ value: Int) -> NSColor {
        NSColor(srgbRed: CGFloat(value >> 16 & 255)/255, green: CGFloat(value >> 8 & 255)/255,
                blue: CGFloat(value & 255)/255, alpha: 1)
    }
    static let edge = rgb(0x211e19), stone = rgb(0x38362d), bevel = rgb(0x645b45)
    static let brass = rgb(0xaf9357), gilt = rgb(0xe7c779), ivory = rgb(0xf4e8c6)
    static let muted = rgb(0xccbea0), moss = rgb(0x43513a)
}

private func fill(_ r: CGRect, _ color: NSColor) { color.setFill(); r.fill() }
private func oval(_ r: CGRect, _ color: NSColor) {
    color.setFill(); NSBezierPath(ovalIn: r).fill()
}
private func polygon(_ points: [CGPoint], _ color: NSColor) {
    guard let start = points.first else { return }
    let path = NSBezierPath()
    path.move(to: start)
    for point in points.dropFirst() { path.line(to: point) }
    path.close(); color.setFill(); path.fill()
}
private func lettering(_ title: String, _ size: CGFloat, _ color: NSColor, serif: Bool = false) -> NSAttributedString {
    let font = serif ? NSFont(name: "Georgia-Bold", size: size) : NSFont.systemFont(ofSize: size, weight: .semibold)
    return NSAttributedString(string: title, attributes: [.font: font ?? NSFont.boldSystemFont(ofSize: size), .foregroundColor: color])
}

private final class CrestPlate: NSView {
    override var isFlipped: Bool { true }
    let title = NSTextField(labelWithString: "The Guild Green")
    let detail = NSTextField(labelWithString: "")
    let guildFont = NSFont(name: "Georgia-Bold", size: 20) ?? .boldSystemFont(ofSize: 20)
    let agentFont = NSFont(name: "Georgia-Bold", size: 16) ?? .boldSystemFont(ofSize: 16)
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        title.font = guildFont
        title.textColor = Ink.gilt
        detail.font = .systemFont(ofSize: 12, weight: .medium)
        detail.textColor = Ink.ivory
        for field in [title, detail] {
            field.lineBreakMode = .byTruncatingTail
            field.isSelectable = false
            addSubview(field)
        }
    }
    required init?(coder: NSCoder) { nil }
    override func layout() {
        super.layout()
        title.frame = CGRect(x: 51, y: 7, width: bounds.width - 59, height: 24)
        detail.frame = CGRect(x: 51, y: 34, width: bounds.width - 59, height: 17)
    }
    override func draw(_ dirty: NSRect) {
        let b = bounds
        fill(b, Ink.edge); fill(b.insetBy(dx: 1, dy: 1), Ink.bevel)
        fill(b.insetBy(dx: 2, dy: 2), Ink.stone)
        fill(CGRect(x: 3, y: 3, width: b.width - 6, height: 1), Ink.brass)
        fill(CGRect(x: 43, y: 8, width: 1, height: b.height - 16), Ink.bevel)
        let shield = [CGPoint(x: 9, y: 12), CGPoint(x: 36, y: 12), CGPoint(x: 34, y: 35),
                      CGPoint(x: 29, y: 41), CGPoint(x: 22, y: 46), CGPoint(x: 13, y: 39)]
        polygon(shield, Ink.brass)
        polygon(shield.map { CGPoint(x: 22 + ($0.x - 22) * 0.86, y: 27 + ($0.y - 27) * 0.87) }, Ink.moss)
        // A battlement and arched gate, in gold on the guild's green field.
        fill(CGRect(x: 16, y: 23, width: 13, height: 11), Ink.gilt)
        for x in [16, 21, 26] { fill(CGRect(x: x, y: 20, width: 3, height: 4), Ink.gilt) }
        oval(CGRect(x: 20, y: 27, width: 5, height: 7), Ink.moss)
        fill(CGRect(x: 20, y: 30, width: 5, height: 5), Ink.moss)
    }
}

private final class StoneButton: NSButton {
    let perform: () -> Void
    private let caption: NSAttributedString
    private var outline = false
    var marked = false { didSet { if marked != oldValue { needsDisplay = true } } }
    init(_ text: String, tip: String, action: @escaping () -> Void) {
        perform = action
        caption = lettering(text, 12, Ink.ivory)
        super.init(frame: .zero)
        title = text; toolTip = tip; setAccessibilityLabel(text == "?" ? "Movement controls" : text)
        isBordered = false; wantsLayer = true; focusRingType = .exterior
        target = self; self.action = #selector(invoke)
    }
    required init?(coder: NSCoder) { nil }
    @objc private func invoke() { perform() }
    override func mouseEntered(with event: NSEvent) { outline = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { outline = false; needsDisplay = true }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas where area.owner as? StoneButton === self { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.activeInKeyWindow, .mouseEnteredAndExited, .inVisibleRect], owner: self))
    }
    override func draw(_ dirty: NSRect) {
        let b = bounds, active = marked || isHighlighted
        fill(b, Ink.edge); fill(b.insetBy(dx: 1, dy: 1), outline ? Ink.gilt : Ink.bevel)
        fill(b.insetBy(dx: 2, dy: 2), active ? Ink.moss : Ink.stone)
        fill(CGRect(x: 3, y: 2, width: b.width-6, height: 1), active ? Ink.brass : Ink.bevel)
        let s = caption.size()
        caption.draw(at: CGPoint(x: ((b.width-s.width)/2).rounded(), y: ((b.height-s.height)/2).rounded()))
    }
}

private final class GuildMap: NSView {
    override var isFlipped: Bool { true }
    let onWalk: (Double, Double) -> Void
    var snapshot: GuildFrame?
    var heading = Float.zero
    private var lastTime = -100.0
    private lazy var parchment = NSImage(size: CGSize(width: 136, height: 136), flipped: true) { [weak self] _ in
        self?.drawParchment()
        return true
    }
    init(onWalk: @escaping (Double, Double) -> Void) {
        self.onWalk = onWalk
        super.init(frame: CGRect(x: 0, y: 0, width: 136, height: 136))
        wantsLayer = true
        toolTip = "North-up map · Click a location to walk there"
        setAccessibilityElement(true)
        setAccessibilityLabel("Guild minimap, north up")
        setAccessibilityHelp("Click a location to walk there.")
    }
    required init?(coder: NSCoder) { nil }
    func update(_ f: GuildFrame, _ yaw: Float) {
        guard f.time - lastTime >= 0.10 || f.time < lastTime else { return }
        lastTime = f.time; snapshot = f; heading = yaw; needsDisplay = true
    }
    func containsGround(_ p: CGPoint) -> Bool { hypot(p.x-Atlas.center.x, p.y-Atlas.center.y) <= Atlas.radius }
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if containsGround(p) { let (x, z) = Atlas.world(p); onWalk(x,z) }
    }
    private func drawParchment() {
        let rim = CGRect(x: 2, y: 2, width: 132, height: 132)
        oval(rim, Ink.edge)
        oval(rim.insetBy(dx: 2, dy: 2), Ink.brass)
        oval(rim.insetBy(dx: 3, dy: 3), Ink.stone)
        oval(rim.insetBy(dx: 6, dy: 6), Ink.bevel)
        let terrain = CGRect(x: 10, y: 10, width: 116, height: 116)
        oval(terrain.insetBy(dx: -1, dy: -1), Ink.edge)
        NSGraphicsContext.saveGraphicsState(); NSBezierPath(ovalIn: terrain).addClip()
        fill(terrain, Ink.rgb(0x7a8256))
        func tile(_ x: Double, _ z: Double, _ w: Double, _ d: Double, _ ink: Int) {
            let p = Atlas.point(x,z)
            fill(CGRect(x: p.x, y: p.y, width: w*Atlas.scale, height: d*Atlas.scale), Ink.rgb(ink))
        }
        func grove(_ x: Double, _ z: Double) {
            let point = Atlas.point(x,z)
            polygon([CGPoint(x: point.x-3, y: point.y+2), CGPoint(x: point.x, y: point.y-4),
                     CGPoint(x: point.x+3, y: point.y+2)], Ink.rgb(0x455c3f))
        }
        let trail = 0xb9ab77
        tile(-18, -26, 4, 52, 0x518087); tile(-1.8, -8.4, 3.6, 29, trail); tile(-18.7, 1.7, 32.8, 2.6, trail)
        let green = Atlas.point(0,3), r = 7.1*Atlas.scale
        oval(CGRect(x: green.x-r,y: green.y-r,width: r*2,height: r*2), Ink.rgb(trail))
        for (x,z) in [(-10,-6),(-13,-8),(-8,-10),(-12,-3),(-8,-3),(-14,-12),(-10,-14),(-5,-16),(3,-17),(9,-16),(15,-13),(17,0),(17,12),(-11,13),(-7,16),(6,17)] { grove(Double(x),Double(z)) }
        for (x,z) in [(9,-6),(12,-8),(14,-4),(8,-10),(14,-11),(11,-3)] {
            tile(Double(x)-0.75,Double(z)-0.7,1.5,1.4,0x858572)
        }
        tile(-6.5,-13.6,13,5.2,0x565747); tile(-4.5,-13.3,9,4.7,0x92674e)
        for x in [8.2,10.7,13.2] {
            tile(x-0.95,14.6,1.9,1.9,0x795a39)
            tile(x-0.15,14.85,0.4,1.4,0x536f45)
        }
        tile(-9.4,6.4,3.6,2.8,0x925e50); tile(8,7.2,5.5,2.4,0x685e4e)
        NSGraphicsContext.restoreGraphicsState()
        for i in 0..<32 {
            let a = Double(i)*Double.pi/16, c = cos(a), s = sin(a)
            let from = i%4 == 0 ? 60.8 : 62.6
            let tick = NSBezierPath()
            tick.move(to: CGPoint(x: 68 + from*c, y: 68 + from*s))
            tick.line(to: CGPoint(x: 68 + 64*c, y: 68 + 64*s)); tick.lineWidth = i%4 == 0 ? 1.25 : 0.7
            (i%4 == 0 ? Ink.brass : Ink.bevel).setStroke(); tick.stroke()
        }
        let north = lettering("N", 10, Ink.ivory, serif: true)
        oval(CGRect(x: 60, y: 1, width: 16, height: 14), Ink.stone)
        north.draw(at: CGPoint(x: 68-north.size().width/2,y: 1))
    }
    override func draw(_ dirty: NSRect) {
        parchment.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        guard let f = snapshot else { return }
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(ovalIn: CGRect(x: 10, y: 10, width: 116, height: 116)).addClip()
        let agentInk = Ink.rgb(0xf7d572), alertInk = Ink.rgb(0xf69769)
        for actor in f.npcs {
            let p = Atlas.point(Double(actor.x),Double(actor.z))
            let x = p.x.rounded(), y = p.y.rounded()
            fill(CGRect(x: x-2, y: y-2, width: 4, height: 4), Ink.edge)
            fill(CGRect(x: x-1, y: y-1, width: 2, height: 2), actor.status == "blocked" || actor.status == "error" ? alertInk : agentInk)
        }
        let p = Atlas.point(Double(f.player.x),Double(f.player.z)), a = Double(heading)
        func vertex(_ side: Double, _ forward: Double) -> CGPoint {
            CGPoint(x: p.x + cos(a)*side - sin(a)*forward, y: p.y - sin(a)*side - cos(a)*forward)
        }
        polygon([vertex(0,6),vertex(4,-4),vertex(0,-2.5),vertex(-4,-4)], Ink.edge)
        polygon([vertex(0,4),vertex(2.4,-2.6),vertex(0,-1.4),vertex(-2.4,-2.6)], .white)
        NSGraphicsContext.restoreGraphicsState()
    }
}

final class GuildHUD: NSView {
    override var isFlipped: Bool { true }
    private let plaque = CrestPlate(frame: .zero)
    private let chart: GuildMap
    private let back: StoneButton, names: StoneButton, commons: StoneButton, inventory: StoneButton
    private var helpButton: StoneButton!
    private let hints = NSTextField(labelWithString: "Click or arrows to walk   ·   Click agent to talk   ·   W/S tilt   ·   A/D rotate   ·   Scroll zoom   ·   G dance")
    private var serviceKey: String?, statusCode: String?, activityCode: String?, lastTitle: String?
    private var lastCount = -1, lastWorking = -1
    init(in parent: NSView, onBack: @escaping () -> Void, onNames: @escaping () -> Void,
         onCommons: @escaping () -> Void, onInventory: @escaping () -> Void, onWalk: @escaping (Double, Double) -> Void) {
        chart = GuildMap(onWalk: onWalk)
        back = StoneButton("‹  Guild", tip: "Return to the guild and its music", action: onBack)
        names = StoneButton("Names", tip: "Show or hide companion names (N)", action: onNames)
        commons = StoneButton("Commons", tip: "Walk to the commons and reset the camera", action: onCommons)
        inventory = StoneButton("Inventory", tip: "Open equipment inventory (I)", action: onInventory)
        super.init(frame: parent.bounds)
        autoresizingMask = [.width, .height]
        helpButton = StoneButton("?", tip: "Movement controls") { [weak self] in
            guard let self else { return }
            self.hints.isHidden.toggle(); self.helpButton.marked = !self.hints.isHidden
            if let parent = self.superview { self.window?.makeFirstResponder(parent) }
        }
        hints.isHidden = true; hints.drawsBackground = true; hints.backgroundColor = Ink.stone
        hints.textColor = Ink.ivory; hints.font = .systemFont(ofSize: 12, weight: .medium); hints.alignment = .center
        [plaque, chart, back, names, commons, inventory, helpButton!, hints].forEach { addSubview($0) }
        parent.addSubview(self)
    }
    required init?(coder: NSCoder) { nil }
    override func layout() {
        super.layout()
        let width = min(325, max(210,bounds.width-170))
        plaque.frame = CGRect(x: 12, y: 12, width: width, height: 57)
        var x: CGFloat = 12
        for (button,w) in [(back,68.0),(names,62.0),(commons,80.0),(inventory,74.0),(helpButton!,27.0)] {
            button.frame = CGRect(x: x, y: 72, width: w, height: 27)
            x += w + 3
        }
        hints.frame = CGRect(x: 12, y: 103, width: min(hints.intrinsicContentSize.width+12,bounds.width-24), height: 20)
        chart.frame = CGRect(x: bounds.width-146, y: 8, width: 136, height: 136)
    }
    override func hitTest(_ p: NSPoint) -> NSView? {
        guard let parent = superview else { return nil }
        let local = convert(p, from: parent)
        for button in [back, names, commons, inventory, helpButton!] where button.frame.contains(local) { return button }
        return chart.containsGround(chart.convert(local,from:self)) ? chart : nil
    }
    func update(frame: GuildFrame, target: Actor?, yaw: Float, names shown: Bool) {
        names.marked = shown
        chart.update(frame,yaw)
        if let actor = target {
            let title = actor.name ?? actor.key
            guard actor.key != serviceKey || lastTitle != title || statusCode != actor.status || activityCode != actor.activity else { return }
            serviceKey = actor.key; lastTitle = title; statusCode = actor.status; activityCode = actor.activity
            let occupation: String
            switch actor.activity {
            case "wood": occupation = "Chopping wood"
            case "mine": occupation = "Mining ore"
            case "smith": occupation = "Smithing"
            case "fish": occupation = "Fishing"
            case "farm": occupation = "Tending crops"
            case "waiting": occupation = "Waiting for a work station"
            case "blocked", "error": occupation = "Needs your attention"
            case "unknown": occupation = "Status unknown"
            default: occupation = "At the commons"
            }
            plaque.title.font = plaque.agentFont
            plaque.title.stringValue = title
            plaque.detail.stringValue = "\(actor.kind ?? "Agent") \(actor.guildClass)  ·  \(occupation)"
            plaque.toolTip = "\(title) · \(plaque.detail.stringValue)"
        } else {
            let count = frame.npcs.count, working = frame.npcs.reduce(0) { $0 + ($1.status == "working" ? 1 : 0) }
            guard serviceKey != nil || count != lastCount || working != lastWorking else { return }
            serviceKey = nil; lastTitle = nil; lastCount = count; lastWorking = working
            plaque.title.font = plaque.guildFont
            plaque.title.stringValue = "The Guild Green"
            plaque.detail.stringValue = "\(count) companions  ·  \(working) working"
            plaque.toolTip = nil
        }
    }
}
