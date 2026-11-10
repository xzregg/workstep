// Package the existing WorkStep artwork on an opaque iOS app-icon canvas.
import CoreGraphics
import ImageIO
import Foundation

let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard let sourceImage = CGImageSourceCreateWithURL(source as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(sourceImage, 0, nil),
      let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
      let destination = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 1, nil)
else { fatalError("Cannot load application artwork") }
let rect = CGRect(x: 0, y: 0, width: 1024, height: 1024)
context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(rect); context.draw(image, in: rect)
guard let result = context.makeImage() else { fatalError("Cannot render icon") }
CGImageDestinationAddImage(destination, result, nil)
precondition(CGImageDestinationFinalize(destination), "Cannot encode icon")
