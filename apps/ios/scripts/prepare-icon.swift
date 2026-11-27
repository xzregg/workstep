// Flatten the generated desktop artwork (including its native mask padding) for iOS.
import CoreGraphics
import ImageIO
import Foundation

let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let arguments = CommandLine.arguments.dropFirst().filter { $0 != "--check" }
let source = arguments.count > 0 ? URL(fileURLWithPath: arguments[0])
    : ios.appendingPathComponent("../desktop/build/icons/1024x1024.png").standardizedFileURL
let output = arguments.count > 1 ? URL(fileURLWithPath: arguments[1])
    : ios.appendingPathComponent("WorkStep/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
let encoded = NSMutableData()
guard let sourceImage = CGImageSourceCreateWithURL(source as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(sourceImage, 0, nil),
      let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
      let destination = CGImageDestinationCreateWithData(encoded, "public.png" as CFString, 1, nil)
else { fatalError("Cannot load application artwork") }
let rect = CGRect(x: 0, y: 0, width: 1024, height: 1024)
context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(rect); context.draw(image, in: rect)
guard let result = context.makeImage() else { fatalError("Cannot render icon") }
CGImageDestinationAddImage(destination, result, nil)
precondition(CGImageDestinationFinalize(destination), "Cannot encode icon")
if CommandLine.arguments.contains("--check") {
    guard try Data(contentsOf: output) == encoded as Data else {
        FileHandle.standardError.write(Data("Regenerate iOS icon with scripts/prepare-icon.swift\n".utf8))
        exit(1)
    }
    print("iOS icon matches generated website artwork")
} else {
    try (encoded as Data).write(to: output)
}
