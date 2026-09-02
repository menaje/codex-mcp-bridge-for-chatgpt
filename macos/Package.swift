// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodexBridgeMac",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "CodexBridgeKit", targets: ["CodexBridgeKit"]),
        .executable(name: "CodexBridgeMenuBar", targets: ["CodexBridgeMenuBar"])
    ],
    targets: [
        .target(name: "CodexBridgeKit"),
        .executableTarget(
            name: "CodexBridgeMenuBar",
            dependencies: ["CodexBridgeKit"]
        ),
        .testTarget(
            name: "CodexBridgeKitTests",
            dependencies: ["CodexBridgeKit"]
        )
    ]
)
