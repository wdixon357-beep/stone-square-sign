import AppKit
import Combine
import Foundation
import Sparkle
import SwiftUI

/// Sparkle verifies the release archive before its sandbox installer replaces the app.
@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    static let shared = AppUpdater()
    @Published private(set) var availableVersion: String?
    @Published private(set) var readyToRestart = false
    @Published private(set) var status = ""
    @Published private(set) var canCheck = false
    private var workspaceGuards: [UUID: () -> String?] = [:]
    private var editorGuards: [UUID: String] = [:]
    var unfinishedWorkReason: String? {
        editorGuards.values.sorted().first ?? workspaceGuards.values.compactMap { $0() }.sorted().first
    }
    func setWorkspaceGuard(_ id: UUID, check: (() -> String?)?) { workspaceGuards[id] = check }
    func setEditorGuard(_ id: UUID, reason: String?) { editorGuards[id] = reason }

    private var controller: SPUStandardUpdaterController?
    private var observation: AnyCancellable?
    private var resumeInstall: (() -> Void)?

    static func unfinishedReportWork(report: ReportBrowserModel, minutes: MinutesWorkspace, treasury: TreasuryWorkspace, agenda: AgendaWorkspace, operationInProgress: Bool) -> String? {
        if operationInProgress || report.busy || minutes.busy || treasury.busy || agenda.busy {
            return "An operation is still running. Wait for it to finish, then try the update again."
        }
        if minutes.dirty || (minutes.draft != nil && minutes.draft != minutes.selected?.draft) {
            return "Save or discard your Meeting Minutes edits before updating."
        }
        if !minutes.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || minutes.fileURL != nil {
            return "Save or clear the source notes in Meeting Minutes before updating."
        }
        if treasury.dirty || (treasury.draft != nil && treasury.draft != treasury.selected?.draft) {
            return "Save or discard your Treasurer Report edits before updating."
        }
        if !treasury.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !treasury.files.isEmpty {
            return "Save or clear the source material in Treasurer Reports before updating."
        }
        if agenda.dirty { return "Save or discard your Agenda Creator edits before updating." }
        if !report.draftSaved && (!report.fields.isEmpty || !report.source.isEmpty) {
            return "Your Report Generator draft has not saved on this Mac. Keep it open and save your work before updating."
        }
        return nil
    }

    func start() {
        guard controller == nil else { return }
        guard let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: key)?.count == 32 else {
            status = "Updates are not configured in this build."
            return
        }
        let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        do {
            try controller.updater.start()
            observation = controller.updater.publisher(for: \.canCheckForUpdates)
                .receive(on: RunLoop.main).sink { [weak self] in self?.canCheck = $0 }
            controller.updater.checkForUpdateInformation()
        } catch { status = "Updates could not start. \(error.localizedDescription)" }
    }

    func checkForUpdates() {
        start()
        if let reason = unfinishedWorkReason { showUnfinishedWork(reason); return }
        if let resumeInstall {
            self.resumeInstall = nil; readyToRestart = false
            resumeInstall()
        } else { controller?.checkForUpdates(nil) }
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        availableVersion = item.displayVersionString
        status = ""
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) { availableVersion = nil }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        guard let reason = unfinishedWorkReason else { return false }
        resumeInstall = installHandler; readyToRestart = true
        showUnfinishedWork(reason)
        return true
    }

    func showUnfinishedWork(_ reason: String) {
        status = reason
        let alert = NSAlert()
        alert.messageText = "Finish your work before updating"
        alert.informativeText = reason
        alert.addButton(withTitle: "Return to report")
        alert.runModal()
    }
}

@MainActor
final class DashboardApplicationDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let reason = AppUpdater.shared.unfinishedWorkReason else { return .terminateNow }
        AppUpdater.shared.showUnfinishedWork(reason)
        return .terminateCancel
    }
}

private struct UpdateDraftGuard: ViewModifier {
    let active: Bool
    let reason: String
    @State private var id = UUID()
    func body(content: Content) -> some View {
        content
            .onChange(of: active, initial: true) { _, value in
                AppUpdater.shared.setEditorGuard(id, reason: value ? reason : nil)
            }
            .onDisappear { AppUpdater.shared.setEditorGuard(id, reason: nil) }
    }
}

extension View {
    func updateDraftGuard(active: Bool = true, reason: String) -> some View {
        modifier(UpdateDraftGuard(active: active, reason: reason))
    }
}
