import Foundation
import CoreGraphics
import CoreText

// Rasterize each title only when first seen or renamed. The terminal frame slots
// are RGBA already, so painting a cached, opaque nameplate is one copy per row.
final class WorldLabels {
    private final class Bitmap {
        let width, height: Int
        let pixels: [UInt8]
        init(_ w: Int, _ h: Int, _ bytes: [UInt8]) { width=w; height=h; pixels=bytes }
    }
    private let cache = NSCache<NSString, Bitmap>()
    private let font = CTFontCreateWithName("HelveticaNeue-Bold" as CFString, 11, nil)
    private let space = CGColorSpaceCreateDeviceRGB()
    private var rasterScale: CGFloat = 1
    private var placed = [CGRect]()
    init() { cache.countLimit = 256 }

    private func bitmap(_ actor: Actor, highlighted: Bool) -> Bitmap? {
        let name = (highlighted ? actor.guildClass + " · " : "") + (actor.name ?? actor.key)
        let key = ((highlighted ? "1" : "0") + name) as NSString
        if let entry = cache.object(forKey:key) { return entry }
        let limit: CGFloat = highlighted ? 177 : 118
        let foreground = highlighted ? CGColor(red:1,green:0.88,blue:0.54,alpha:1) : CGColor(red:0.97,green:0.92,blue:0.80,alpha:1)
        let attrs = [kCTFontAttributeName as NSAttributedString.Key:font,
                     kCTForegroundColorAttributeName as NSAttributedString.Key:foreground] as [NSAttributedString.Key:Any]
        let title = name.replacingOccurrences(of: "\n",with: " ")
        let line = CTLineCreateWithAttributedString(NSAttributedString(string:title,attributes:attrs))
        let ellipsis = CTLineCreateWithAttributedString(NSAttributedString(string:"…",attributes:attrs))
        let short = CTLineCreateTruncatedLine(line,Double(limit),.end,ellipsis) ?? ellipsis
        let labelWidth = min(limit,CGFloat(CTLineGetTypographicBounds(short,nil,nil,nil))) + 10
        let w = Int(ceil(labelWidth*rasterScale)), h = Int(ceil(17*rasterScale))
        var bytes = [UInt8](repeating:0,count:w*h*4)
        let rendered = bytes.withUnsafeMutableBytes { storage -> Bool in
            guard let ctx = CGContext(data:storage.baseAddress,width:w,height:h,bitsPerComponent:8,bytesPerRow:w*4,
                                      space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            ctx.setFillColor(red:0.11,green:0.11,blue:0.085,alpha:1)
            ctx.fill(CGRect(x:0,y:0,width:w,height:h))
            // Draw in HUD coordinates and let Core Text rasterize glyph edges at
            // the actual texture resolution, including when the quality changes.
            ctx.scaleBy(x:rasterScale,y:rasterScale)
            ctx.setFillColor(red:highlighted ? 0.74:0.36,green:highlighted ? 0.60:0.33,blue:highlighted ? 0.34:0.24,alpha:1)
            ctx.fill(CGRect(x:1,y:16,width:labelWidth-2,height:1))
            ctx.textPosition=CGPoint(x:5,y:4); CTLineDraw(short,ctx)
            return true
        }
        guard rendered else { return nil }
        let result=Bitmap(w,h,bytes)
        cache.setObject(result,forKey:key)
        return result
    }

    func draw(frame: GuildFrame, camera: GPUCamera, target: Actor?, names: Bool, into pixels: UnsafeMutableRawPointer, width: Int, height: Int, hudScale: CGFloat = 1) {
        guard names || target != nil else { return }
        let scale = max(0.25,min(8,hudScale))
        if scale != rasterScale {
            rasterScale = scale
            cache.removeAllObjects()
        }
        let gap = max(1,Int(rasterScale.rounded()))
        placed.removeAll(keepingCapacity:true)
        func paint(_ actor: Actor, highlighted: Bool) {
            let anchor = camera.screen(actor.x,actor.elevation+2.5,actor.z)
            guard anchor.x >= 0, anchor.x <= CGFloat(width), anchor.y >= 0, anchor.y <= CGFloat(height),
                  let text = bitmap(actor,highlighted:highlighted), text.width <= width, text.height <= height else { return }
            let x = max(0,min(width-text.width,Int(anchor.x.rounded())-text.width/2))
            let natural = min(height-text.height,max(0,Int(anchor.y.rounded())-text.height-gap))
            // Pack crowded labels into nearby columns. A short leader ties moved
            // labels back to their character, with the selected title placed first.
            let stepX = text.width/2 + 3*gap, stepY = text.height + 2*gap
            for step in 0..<15 {
                let level = step / 3
                let offset = step % 3 == 1 ? -stepX : step % 3 == 2 ? stepX : 0
                let y = natural - level*stepY
                if y < 0 { break }
                let x = max(0,min(width-text.width,x+offset))
                let rect = CGRect(x:x,y:y,width:text.width,height:text.height)
                if !placed.contains(where: { $0.intersects(rect.insetBy(dx:-rasterScale,dy:-rasterScale*0.5)) }) {
                    if level > 0 || offset != 0 {
                        let from = CGPoint(x:min(max(anchor.x,rect.minX+2*rasterScale),rect.maxX-2*rasterScale),y:rect.maxY)
                        let dx=anchor.x-from.x, dy=anchor.y-from.y, steps=max(1,Int(ceil(max(abs(dx),abs(dy)))))
                        for t in 0..<steps where (t/gap)%3 != 2 {
                            let k=CGFloat(t)/CGFloat(steps)
                            let px=Int((from.x+dx*k).rounded()), py=Int((from.y+dy*k).rounded())
                            if px>=0 && py>=0 && px<width && py<height &&
                                !placed.contains(where: { $0.contains(CGPoint(x:px,y:py)) }) {
                                let pixel=pixels.advanced(by:(py*width+px)*4).assumingMemoryBound(to:UInt8.self)
                                pixel[0]=141;pixel[1]=124;pixel[2]=77
                            }
                        }
                    }
                    placed.append(rect)
                    text.pixels.withUnsafeBytes { glyph in
                        guard let source=glyph.baseAddress else { return }
                        let dest=pixels.advanced(by:(y*width+x)*4), stride=text.width*4
                        for row in 0..<text.height {
                            dest.advanced(by:row*width*4).copyMemory(from:source.advanced(by:row*stride),byteCount:stride)
                        }
                    }
                    return
                }
            }
        }
        if let target { paint(target,highlighted:true) }
        if names {
            for actor in frame.npcs where actor.key != target?.key { paint(actor,highlighted:false) }
        }
    }
}
