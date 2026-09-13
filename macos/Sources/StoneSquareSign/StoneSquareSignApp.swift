import SwiftUI

@main
struct StoneSquareSignApp: App {
    @NSApplicationDelegateAdaptor(DashboardApplicationDelegate.self) private var appDelegate
    @StateObject private var updater = AppUpdater.shared
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .task { updater.start() }
                .frame(
                    minWidth: 1120,
                    maxWidth: .infinity,
                    minHeight: 740,
                    maxHeight: .infinity
                )
        }
        .commands {
            CommandGroup(after: .appInfo) {
                Button(updater.readyToRestart ? "Finish Update…" : "Check for Updates…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheck && !updater.readyToRestart)
            }
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1280, height: 820)
    }
}
