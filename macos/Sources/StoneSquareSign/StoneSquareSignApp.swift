import SwiftUI

@main
struct StoneSquareSignApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .frame(
                    minWidth: 1120,
                    maxWidth: .infinity,
                    minHeight: 740,
                    maxHeight: .infinity
                )
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1280, height: 820)
    }
}
