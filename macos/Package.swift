// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "StoneSquareSign",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "StoneSquareSign", targets: ["StoneSquareSign"])],
    targets: [
        .executableTarget(
            name: "StoneSquareSign",
            path: "Sources/StoneSquareSign",
            linkerSettings: [.linkedFramework("Security")]
        )
    ],
    swiftLanguageModes: [.v5]
)
