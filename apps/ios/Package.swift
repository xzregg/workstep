// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WorkStepCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "WorkStepCore", targets: ["WorkStepCore"])],
    targets: [
        .target(name: "WorkStepCore", path: "WorkStep/Core"),
        .executableTarget(name: "CoreChecks", dependencies: ["WorkStepCore"], path: "WorkStepTests")
    ]
)
