#!/usr/bin/env swift
/**
 * macOS CoreText watermark text → transparent PNG
 * Usage: watermark_text <width> <height> <fontsize> <out.png> [scale]
 * scale=2/3 draws at higher pixel density then the PNG is already hi-res;
 * caller should request width*scale and fontsize*scale, then downscale in PIL.
 */
import AppKit
import Foundation

guard CommandLine.arguments.count >= 5 else {
  fputs("usage: watermark_text W H fontsize out.png [scale]\n", stderr)
  exit(2)
}

let width = Int(CommandLine.arguments[1]) ?? 0
let height = Int(CommandLine.arguments[2]) ?? 0
let fontsize = CGFloat(Double(CommandLine.arguments[3]) ?? 0)
let outPath = CommandLine.arguments[4]
let scale = max(1, Int(CommandLine.arguments.count > 5 ? CommandLine.arguments[5] : "1") ?? 1)

guard width > 0, height > 0, fontsize > 0 else {
  fputs("bad args\n", stderr)
  exit(2)
}

let pw = width * scale
let ph = height * scale
let fs = fontsize * CGFloat(scale)

guard let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: pw,
  pixelsHigh: ph,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("bitmap failed\n", stderr)
  exit(1)
}
rep.size = NSSize(width: pw, height: ph)

guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
  fputs("context failed\n", stderr)
  exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = ctx
ctx.imageInterpolation = .high
ctx.shouldAntialias = true

let bounds = NSRect(x: 0, y: 0, width: pw, height: ph)
NSColor.clear.setFill()
bounds.fill()

let font =
  NSFont(name: "PingFangSC-Semibold", size: fs)
  ?? NSFont(name: "HiraginoSansGB-W6", size: fs)
  ?? NSFont.systemFont(ofSize: fs, weight: .semibold)

let pink = NSColor(srgbRed: 236 / 255, green: 72 / 255, blue: 153 / 255, alpha: 1)
let stroke = NSColor.black
// AppKit: strokeWidth 单位是「字号的百分比」；负值 = 填充+描边。约 3～4 即可，过大粉色会被黑边吃掉。
let strokeW = -3.2

let para = NSMutableParagraphStyle()
para.alignment = .center
para.lineBreakMode = .byClipping

let strokeAttrs: [NSAttributedString.Key: Any] = [
  .font: font,
  .foregroundColor: pink,
  .strokeColor: stroke,
  .strokeWidth: strokeW,
  .paragraphStyle: para,
]
// 再叠一层纯填充，确保粉色实心、边缘仍由上一层描边撑开
let fillAttrs: [NSAttributedString.Key: Any] = [
  .font: font,
  .foregroundColor: pink,
  .paragraphStyle: para,
]

let line1 = "Lovemi官方出品: https://ackr.app/e2"
let line2 = "禁止未授权搬运"
let gap = max(fs * 1.55, 40 * CGFloat(scale))
let block = gap * 2
// NSBitmapImageRep 坐标系：原点在左下，y 向上；这里按自上而下排两行
let topPadding = max(CGFloat(8 * scale), (CGFloat(ph) - block) / 2)
var yFromTop = topPadding

for line in [line1, line2] {
  let s = line as NSString
  let size = s.size(withAttributes: strokeAttrs)
  let x = max(0, (CGFloat(pw) - size.width) / 2)
  let y = CGFloat(ph) - yFromTop - size.height
  s.draw(at: NSPoint(x: x, y: y), withAttributes: strokeAttrs)
  s.draw(at: NSPoint(x: x, y: y), withAttributes: fillAttrs)
  yFromTop += gap
}

NSGraphicsContext.restoreGraphicsState()

guard let data = rep.representation(using: .png, properties: [:]) else {
  fputs("png encode failed\n", stderr)
  exit(1)
}
do {
  try data.write(to: URL(fileURLWithPath: outPath), options: .atomic)
} catch {
  fputs("write failed: \(error)\n", stderr)
  exit(1)
}
