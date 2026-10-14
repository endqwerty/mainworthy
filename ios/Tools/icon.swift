// Draws the app icon from the mark in `src/web/icon.svg`: `swift ios/Tools/icon.swift <out.png>`.
// The two paths and the two colours are that file's. iOS rounds the corners itself and refuses an icon with
// transparency, so the square is filled to its edges.
import AppKit

let size = 1024.0
let scale = size / 64
let green = CGColor(srgbRed: 0x17 / 255.0, green: 0x7a / 255.0, blue: 0x47 / 255.0, alpha: 1)
let paper = CGColor(srgbRed: 0xf6 / 255.0, green: 0xf5 / 255.0, blue: 0xf2 / 255.0, alpha: 1)

guard CommandLine.arguments.count == 2 else {
	FileHandle.standardError.write(Data("usage: swift ios/Tools/icon.swift <out.png>\n".utf8))
	exit(2)
}
let context = CGContext(
	data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
	space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
)!
context.setFillColor(green)
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
// SVG counts y downwards from the top; Core Graphics counts it upwards from the bottom.
context.translateBy(x: 0, y: size)
context.scaleBy(x: scale, y: -scale)
context.setStrokeColor(paper)
context.setLineWidth(7)
context.setLineCap(.round)
context.setLineJoin(.round)
// M13 50V17H51V50
context.move(to: CGPoint(x: 13, y: 50))
context.addLine(to: CGPoint(x: 13, y: 17))
context.addLine(to: CGPoint(x: 51, y: 17))
context.addLine(to: CGPoint(x: 51, y: 50))
// M23 36L30 43L42 28
context.move(to: CGPoint(x: 23, y: 36))
context.addLine(to: CGPoint(x: 30, y: 43))
context.addLine(to: CGPoint(x: 42, y: 28))
context.strokePath()

let image = NSBitmapImageRep(cgImage: context.makeImage()!)
try image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
