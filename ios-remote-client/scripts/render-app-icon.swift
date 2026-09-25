// Renders the app icon PNG with CoreGraphics only (no window server needed). Usage:
//   swift scripts/render-app-icon.swift App/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let output = CommandLine.arguments.dropFirst().first ?? "AppIcon.png"
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CGContext(
  data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!

let gradient = CGGradient(
  colorsSpace: space,
  colors: [
    CGColor(srgbRed: 0.33, green: 0.30, blue: 0.93, alpha: 1),
    CGColor(srgbRed: 0.58, green: 0.27, blue: 0.86, alpha: 1),
  ] as CFArray,
  locations: [0, 1])!
context.drawLinearGradient(
  gradient, start: CGPoint(x: 0, y: size), end: CGPoint(x: size, y: 0), options: [])

let bubble = CGMutablePath()
bubble.addRoundedRect(
  in: CGRect(x: 172, y: 232, width: 680, height: 560), cornerWidth: 180, cornerHeight: 180)
bubble.move(to: CGPoint(x: 300, y: 262))
bubble.addLine(to: CGPoint(x: 236, y: 150))
bubble.addLine(to: CGPoint(x: 420, y: 240))
bubble.closeSubpath()
context.addPath(bubble)
context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.16))
context.fillPath()

let font = CTFontCreateWithName("SFProRounded-Bold" as CFString, 520, nil)
let glyph = NSAttributedString(
  string: "π",
  attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(
      srgbRed: 1, green: 1, blue: 1, alpha: 1),
  ])
let line = CTLineCreateWithAttributedString(glyph)
let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
context.textPosition = CGPoint(
  x: (CGFloat(size) - bounds.width) / 2 - bounds.minX,
  y: 512 + 30 - bounds.height / 2 - bounds.minY)
CTLineDraw(line, context)

let destination = CGImageDestinationCreateWithURL(
  URL(fileURLWithPath: output) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Failed to write \(output)") }
