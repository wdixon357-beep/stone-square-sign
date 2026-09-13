// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "StoneSquareSign",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "StoneSquareSign", targets: ["StoneSquareSign"])],
    dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.6")],
    targets: [
        .executableTarget(
            name: "StoneSquareSign",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/StoneSquareSign",
            linkerSettings: [.linkedFramework("Security"), .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        )
    ],
    swiftLanguageModes: [.v5]
)
