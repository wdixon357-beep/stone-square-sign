import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else { exit(2) }
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let files = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

func icon(_ pixels: Int) throws -> Data {
    let scale = CGFloat(pixels) / 1024
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw CocoaError(.fileWriteUnknown)
    }
    bitmap.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: scale, y: scale)

    let tile = NSBezierPath(roundedRect: NSRect(x: 45, y: 45, width: 934, height: 934), xRadius: 205, yRadius: 205)
    NSGradient(colors: [
        NSColor(red: 0.02, green: 0.08, blue: 0.14, alpha: 1),
        NSColor(red: 0.05, green: 0.23, blue: 0.38, alpha: 1),
    ])!.draw(in: tile, angle: -45)
    NSColor.white.withAlphaComponent(0.12).setStroke()
    tile.lineWidth = 10
    tile.stroke()

    let gold = NSColor(red: 0.82, green: 0.64, blue: 0.29, alpha: 1)
    gold.setStroke()
    let document = NSBezierPath(roundedRect: NSRect(x: 250, y: 210, width: 525, height: 610), xRadius: 42, yRadius: 42)
    document.lineWidth = 30
    document.stroke()

    let signature = NSBezierPath()
    signature.move(to: NSPoint(x: 345, y: 390))
    signature.curve(
        to: NSPoint(x: 675, y: 400),
        controlPoint1: NSPoint(x: 440, y: 270),
        controlPoint2: NSPoint(x: 530, y: 520)
    )
    signature.lineWidth = 34
    signature.lineCapStyle = .round
    NSColor.white.setStroke()
    signature.stroke()

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    NSString(string: "22").draw(
        in: NSRect(x: 325, y: 535, width: 375, height: 185),
        withAttributes: [
            .font: NSFont.systemFont(ofSize: 145, weight: .bold),
            .foregroundColor: gold,
            .paragraphStyle: paragraph,
        ]
    )
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw CocoaError(.fileWriteUnknown)
    }
    return png
}

for (name, pixels) in files {
    try icon(pixels).write(to: output.appendingPathComponent(name), options: .atomic)
}
