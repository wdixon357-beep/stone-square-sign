import AppKit
import SwiftUI
import PDFKit
import UniformTypeIdentifiers

enum SignTheme {
    static let navy = Color(nsColor: .labelColor)
    static let blue = Color.accentColor
    static let gold = Color(red: 0.78, green: 0.60, blue: 0.26)
    static let ivory = Color(nsColor: .windowBackgroundColor)
}

struct NativeWorkspaceHeader<Actions: View>: View {
    let title: String
    let subtitle: String
    let symbol: String
    @ViewBuilder var actions: Actions
    init(title: String, subtitle: String, symbol: String, @ViewBuilder actions: () -> Actions) {
        self.title = title; self.subtitle = subtitle; self.symbol = symbol; self.actions = actions()
    }
    var body: some View {
        VStack(spacing: 0) {
            ViewThatFits(in: .horizontal) {
              HStack(spacing: 14) {
                Image(systemName: symbol).font(.title2).foregroundStyle(SignTheme.gold)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    Text(subtitle).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                HStack(spacing: 8) { actions }.fixedSize(horizontal: true, vertical: false)
              }
              VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 14) {
                    Image(systemName: symbol).font(.title2).foregroundStyle(SignTheme.gold)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Text(subtitle).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) { actions }
                        .fixedSize(horizontal: true, vertical: false)
                }
              }
            }.padding(22)
            Divider()
        }
    }
}
extension NativeWorkspaceHeader where Actions == EmptyView {
    init(title: String, subtitle: String, symbol: String) { self.init(title: title, subtitle: subtitle, symbol: symbol) { EmptyView() } }
}

struct AdaptiveWorkspaceSplit<Primary: View, Secondary: View>: View {
    let primaryTitle: String
    let secondaryTitle: String
    @Binding var compactPane: Int
    let primary: Primary
    let secondary: Secondary

    init(
        primaryTitle: String,
        secondaryTitle: String,
        compactPane: Binding<Int>,
        @ViewBuilder primary: () -> Primary,
        @ViewBuilder secondary: () -> Secondary
    ) {
        self.primaryTitle = primaryTitle
        self.secondaryTitle = secondaryTitle
        _compactPane = compactPane
        self.primary = primary()
        self.secondary = secondary()
    }

    var body: some View {
        GeometryReader { available in
            if available.size.width < 820 {
                VStack(spacing: 0) {
                    Picker("Workspace section", selection: $compactPane) {
                        Text(primaryTitle).tag(0)
                        Text(secondaryTitle).tag(1)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    Divider()
                    Group { compactPane == 0 ? AnyView(primary) : AnyView(secondary) }
                        .frame(width: available.size.width)
                        .frame(maxHeight: .infinity)
                        .clipped()
                }
                .frame(width: available.size.width, height: available.size.height)
                .clipped()
            } else {
                let primaryWidth = min(max(available.size.width * 0.46, 340), 620)
                HStack(spacing: 0) {
                    primary.frame(width: primaryWidth).frame(maxHeight: .infinity).clipped()
                    Divider()
                    secondary.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
                }
                .frame(width: available.size.width, height: available.size.height)
                .clipped()
            }
        }
    }
}

struct AdaptiveControlBar<Wide: View, Compact: View>: View {
    let wide: Wide
    let compact: Compact

    init(@ViewBuilder wide: () -> Wide, @ViewBuilder compact: () -> Compact) {
        self.wide = wide()
        self.compact = compact()
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            wide
            compact
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @State private var showRequiredSignature = false
    @State private var showPendingSignatureNotice = false
    @State private var pendingSignatureCount = 0
    @State private var pendingDocumentToSign: LodgeDocument?
    @State private var pendingNoticeUserId: Int?

    var body: some View {
        Group {
            if model.user != nil { WorkspaceView() }
            else if model.hasSavedSession {
                VStack(spacing: 16) {
                    if let error = model.sessionConnectionError {
                        Text(error).multilineTextAlignment(.center)
                        Button("Reconnect") { Task { await model.restoreSession() } }
                    } else {
                        ProgressView()
                        Text("Opening Stone Square Sign…")
                    }
                }.padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else { AuthenticationView() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .bottom) {
            if !model.message.isEmpty {
                Label(
                    model.message,
                    systemImage: model.isError || model.messageIsWarning ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
                )
                .font(.callout.weight(.semibold))
                .foregroundStyle(model.isError ? .red : model.messageIsWarning ? .orange : .green)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .shadow(radius: 12)
                .padding(.bottom, 18)
            }
        }
        .task {
            await model.restoreSession()
        }
        .onChange(of: model.user) { _, user in
            showRequiredSignature = user?.hasSignature == false && user?.canSign == true
            checkPendingSignatureNotice()
        }
        .onChange(of: model.documents.filter { $0.needsSignature && !$0.isTerminal }.count) { _, _ in
            checkPendingSignatureNotice()
        }
        .sheet(isPresented: $showRequiredSignature) {
            SignatureSetupView(required: true)
                .interactiveDismissDisabled(true)
        }
        .sheet(item: $pendingDocumentToSign) { document in
            SignatureApprovalView(document: document)
        }
        .alert(
            model.user?.role == "owner"
                ? (pendingSignatureCount == 1 ? "Dispensation activity awaiting review" : "\(pendingSignatureCount) dispensations awaiting review")
                : model.user?.role == "viewer"
                    ? (pendingSignatureCount == 1 ? "Dispensation activity ready to view" : "\(pendingSignatureCount) dispensations ready to view")
                    : (pendingSignatureCount == 1 ? "Dispensation awaiting review and signature" : "\(pendingSignatureCount) dispensations awaiting review and signature"),
            isPresented: $showPendingSignatureNotice
        ) {
            Button("Review now") {
                if model.user?.role == "owner" || model.user?.role == "viewer" {
                    model.requestedSection = .documents
                } else {
                    pendingDocumentToSign = model.documents.first { $0.needsSignature && !$0.isTerminal }
                }
            }
            Button("Later", role: .cancel) {}
        } message: {
            Text(model.user?.role == "owner"
                 ? "A dispensation is active in the officer signing queue and ready for your review."
                 : model.user?.role == "viewer"
                    ? "A dispensation is active in the officer signing queue and available for read-only review."
                    : "A dispensation assigned to you is ready. Review the PDF, enter your address, and apply your saved signature.")
        }
    }

    private func checkPendingSignatureNotice() {
        guard let user = model.user,
              (user.role == "owner" || user.can("documents.sign")),
              (user.hasSignature || !user.canSign),
              pendingNoticeUserId != user.id else { return }
        let pending = user.role == "owner" || user.role == "viewer"
            ? model.documents.filter { !$0.isTerminal }
            : model.documents.filter { $0.needsSignature && !$0.isTerminal }
        guard !pending.isEmpty else { return }
        pendingSignatureCount = pending.count
        pendingNoticeUserId = user.id
        showPendingSignatureNotice = true
    }
}

struct AuthenticationView: View {
    @EnvironmentObject var model: AppModel
    @State private var mode = 0
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "building.columns.circle.fill").font(.system(size: 52)).foregroundStyle(SignTheme.gold)
            Text("Stone Square Lodge Dashboard").font(.title2.weight(.semibold))
            Text("Sign in to your Lodge workspace").foregroundStyle(.secondary)
            Picker("Access", selection: $mode) {
                Text("Sign in").tag(0); Text("Owner setup").tag(1); Text("Reset password").tag(2)
            }.pickerStyle(.segmented)
            Form {
                Section {
                    if mode == 1 { TextField("Full name", text: $name).textContentType(.name) }
                    TextField("Email address", text: $email).textContentType(.emailAddress)
                    if mode == 2 { TextField("Six digit code", text: $code) }
                    SecureField(mode == 2 ? "New password" : mode == 1 ? "Create password" : "Password", text: $password)
                    if mode == 2 {
                        Button("Send reset code") { Task { await model.requestReset(email: email) } }
                            .disabled(model.emailDeliveryReady == false)
                        if model.emailDeliveryReady == false {
                            Text("Email recovery is temporarily unavailable. Ask the Worshipful Master to reset your account access.")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }
                }
                #if DEBUG
                Section {
                    DisclosureGroup("Debug connection settings") {
                        TextField("Signing service address", text: $model.serverAddress)
                        Text("Release builds always use the approved Lodge service.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                #endif
            }.formStyle(.grouped).textFieldStyle(.roundedBorder).frame(height: mode == 2 ? 250 : 230)
            if mode == 0 && model.biometricLoginEnabled {
                Button("Sign in with Touch ID", systemImage: "touchid") { Task { await model.signInWithBiometrics() } }
            }
            HStack {
                if model.isBusy { ProgressView().controlSize(.small) }
                Spacer()
                Button(buttonTitle, action: submit).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }.padding(32).frame(width: 470).disabled(model.isBusy)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(nsColor: .windowBackgroundColor))
            .task { await model.loadServiceSetup() }
    }

    private var buttonTitle: String {
        mode == 0 ? "Sign in securely" : mode == 1 ? "Create owner account" : "Set new password"
    }

    private func submit() {
        Task {
            if mode == 0 { await model.signIn(email: email, password: password) }
            else if mode == 1 { await model.createOwner(name: name, email: email, password: password) }
            else { await model.resetPassword(email: email, code: code, password: password) }
        }
    }
}

struct WorkspaceView: View {
    @EnvironmentObject var model: AppModel
    @State private var selection: AppSection? = .home
    @State private var updateGuardID = UUID()
    @StateObject private var reportBrowser = ReportBrowserModel()
    @StateObject private var minutesWorkspace = MinutesWorkspace()
    @StateObject private var treasuryWorkspace = TreasuryWorkspace()
    @StateObject private var agendaWorkspace = AgendaWorkspace()
    @StateObject private var activityPresence = ActivityPresence()

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("STONE SQUARE").font(.headline).tracking(1.5)
                    Text("LODGE DASHBOARD").font(.caption2).tracking(2).foregroundStyle(SignTheme.gold)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(22)
                if !model.minutesReviewAlerts.isEmpty {
                    ScrollView {
                        minutesReviewAlertButtons
                    }
                    .frame(height: model.minutesReviewAlerts.count == 1 ? 118 : 220)
                }
                if !model.treasuryAlerts.isEmpty {
                    ScrollView { treasuryAlertButtons }
                    .frame(height: model.treasuryAlerts.count == 1 ? 118 : 220)
                }
                List(selection: $selection) {
                Label("Home", systemImage: "square.grid.2x2.fill").tag(AppSection.home)
                if model.user?.canOpen(.building) == true { Label("Building Requests", systemImage: "building.2").tag(AppSection.building) }
                if model.user?.canOpen(.lodgeCalendar) == true { Label("Lodge Calendar", systemImage: "calendar").tag(AppSection.lodgeCalendar) }
                if model.user?.can("reports.create") == true { Label("Report Generator", systemImage: "doc.text").tag(AppSection.reportGenerator) }
                if model.user?.role == "owner" { Label("Received Reports", systemImage: "tray.full.fill").tag(AppSection.receivedReports) }
                if model.user?.canReadMinutes == true {
                    Label("Meeting Minutes", systemImage: "text.document.fill").tag(AppSection.minutes)
                }
                if model.user?.role == "owner" { Label("Agenda Creator", systemImage: "list.number").tag(AppSection.agenda) }
                if model.user?.canUseTreasury == true { Label("Treasurer Reports", systemImage: "chart.bar.doc.horizontal.fill").tag(AppSection.treasury) }
                if model.user?.can("documents.status") == true { Label("Live Queue", systemImage: "list.number").tag(AppSection.documents) }
                if model.user?.can("candidates.view") == true { Label("Candidate Tracker", systemImage: "person.text.rectangle.fill").tag(AppSection.candidateTracker) }
                if model.user?.role == "owner" {
                        Label("Create Dispensation", systemImage: "doc.badge.plus").tag(AppSection.createDispensation)
                        Label("Warden Proposals", systemImage: "square.and.pencil").tag(AppSection.proposalReview)
                        Label("Officer Access", systemImage: "person.badge.key.fill").tag(AppSection.access)
                        Label("Member Access", systemImage: "person.3.fill").tag(AppSection.memberAccess)
                        Label("Dashboard Activity",systemImage:"clock.arrow.circlepath").tag(AppSection.activity)
                    }
                    if model.user?.canReadApprovals == true { Label("Approvals", systemImage: "checkmark.seal.fill").tag(AppSection.approvals) }
                    if model.user?.role == "owner" {
                    }
                    if model.user?.canReadDues == true {
                        Label("Dues Ledger", systemImage: "list.bullet.rectangle.portrait.fill").tag(AppSection.dues)
                    }
                    if model.user?.can("dues.self") == true { Label("My Dues", systemImage: "dollarsign.circle.fill").tag(AppSection.myDues) }
                    if model.user?.can("suggestions.create") == true { Label("Suggestion Box", systemImage: "text.bubble.fill").tag(AppSection.suggestions) }
                    if model.user?.showsPersonalProposals == true {
                        Label("My Dispensation Proposals", systemImage: "square.and.pencil").tag(AppSection.proposalReview)
                    }
                    if model.user?.canSign == true { Label("Signature Profile", systemImage: "signature").tag(AppSection.profile) }
                    if model.user?.can("settings.manage") == true { Label("Service Settings", systemImage: "network").tag(AppSection.settings) }
                }
                .scrollContentBackground(.hidden)
                .frame(minHeight: 0, maxHeight: .infinity)
                VStack(alignment: .leading, spacing: 5) {
                    Label(
                        model.isLive ? "Live queue connected" : "Reconnecting",
                        systemImage: model.isLive ? "circle.fill" : "circle.dotted"
                    )
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(model.isLive ? .green : .secondary)
                    Divider().padding(.vertical, 5)
                    Text(model.user?.name ?? "").font(.callout.weight(.semibold))
                    Text(model.user?.roleLabel ?? "").font(.caption).foregroundStyle(.secondary)
                    Text("Automatic login on this Mac").font(.caption2).foregroundStyle(.secondary).padding(.top, 5)
                    Text("Sign-ins and actions are recorded for Lodge administration. Active time is estimated.").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .background(.bar)
            .navigationSplitViewColumnWidth(min: 240, ideal: 260, max: 320)
        } detail: {
            GeometryReader { available in
                VStack(spacing: 0) {
                    WorkspaceNotices()
                    workspaceContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(
                    width: available.size.width,
                    height: available.size.height,
                    alignment: .topLeading
                )
                .clipped()
            }
        }
        .task { activityPresence.start(model);await model.refresh() }
        .onAppear {
            AppUpdater.shared.setWorkspaceGuard(updateGuardID) {
                AppUpdater.unfinishedReportWork(report: reportBrowser, minutes: minutesWorkspace, treasury: treasuryWorkspace, agenda: agendaWorkspace, operationInProgress: model.isBusy)
            }
        }
        .onDisappear { activityPresence.stop(); AppUpdater.shared.setWorkspaceGuard(updateGuardID, check: nil) }
        .onChange(of:selection){_,section in activityPresence.visit(section)}
        .onChange(of: model.requestedSection) { _, requested in
            guard let requested else { return }
            selection = requested
            model.requestedSection = nil
        }
    }

    private var minutesReviewAlertButtons: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.minutesReviewAlerts) { alert in
                Button {
                    selection = .minutes
                    Task {
                        if alert.kind == "preparer_completion" {
                            model.requestedMinutesRecordID = alert.id
                            await model.markMinutesAlertSeen(alert)
                        } else {
                            minutesWorkspace.configure(model)
                            _ = await minutesWorkspace.openReviewedRecord(id: alert.id)
                        }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(alert.title, systemImage: "bell.badge.fill")
                            .font(.callout.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                        Text(alert.message ?? "Submitted by \(alert.submittedBy)").font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
                    .frame(minHeight: 100, alignment: .topLeading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("\(alert.title). Submitted by \(alert.submittedBy)")
                .padding(.horizontal, 22)
            }
        }
    }

    private var treasuryAlertButtons: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.treasuryAlerts) { alert in
                HStack(alignment: .top, spacing: 8) {
                    Button {
                        selection = .treasury
                        Task {
                            treasuryWorkspace.configure(model)
                            await treasuryWorkspace.refresh()
                            if let record = treasuryWorkspace.records.first(where: { $0.id == alert.id && $0.status == "awaiting_preparer" && $0.preparerUserId == nil }) {
                                treasuryWorkspace.open(record)
                                await model.dismissTreasuryAlert(alert)
                            } else {
                                treasuryWorkspace.message = "This banking information has already been claimed. The report list is current."
                                await model.refreshTreasuryAlerts()
                            }
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(alert.title, systemImage: "bell.badge.fill")
                                .font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                            Text(alert.message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                        .frame(minHeight: 100, alignment: .topLeading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(alert.message)
                    Button { Task { await model.dismissTreasuryAlert(alert) } } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Dismiss this reminder. The banking information remains in Treasurer Reports.")
                    .accessibilityLabel("Dismiss banking information alert from \(alert.uploadedBy)")
                }
                .padding(.horizontal, 22)
            }
        }
    }

    @ViewBuilder
    private var workspaceContent: some View {
        if model.user?.canOpen(selection) != true {
            ContentUnavailableView("This workspace is not assigned", systemImage: "lock")
        } else { switch selection {
        case .home:
            LandingDashboardView(
                openDispensations: { selection = .documents },
                openCandidateTracker: { selection = .candidateTracker },
                openReports: { selection = .reportGenerator },
                openReceivedReports: { selection = .receivedReports },
                openMinutes: { selection = .minutes },
                openAgenda: { selection = .agenda },
                openTreasury: { selection = .treasury },
                openBuilding: { selection = .building },
                openCalendar: { selection = .lodgeCalendar }
            )
        case .building: BuildingRequestsView()
        case .lodgeCalendar: LodgeCalendarView()
        case .reportGenerator:
            ReportGeneratorView(browser: reportBrowser)
        case .receivedReports:
            if model.user?.role == "owner" { ReceivedReportsView() }
        case .minutes:
            if model.user?.can("minutes.prepare") == true { MeetingMinutesView(workspace: minutesWorkspace, onExit: { selection = .home }) }
            else { FinalReportBrowserView(kind: .minutes) }
        case .agenda: if model.user?.role == "owner" { AgendaCreatorView(workspace: agendaWorkspace) }
        case .treasury:
            if model.user?.can("treasury.prepare") == true || model.user?.can("treasury.upload") == true { TreasuryView(workspace: treasuryWorkspace) }
            else { FinalReportBrowserView(kind: .treasury) }
        case .candidateTracker:
            NativeCandidateTrackerView()
        case .createDispensation: DispensationBuilderView()
        case .access: OfficerAccessView()
        case .memberAccess: if model.user?.role == "owner" { MemberAccessView() }
        case .activity: if model.user?.role == "owner" {OfficerActivityView()}
        case .dues: DuesView()
        case .myDues: MyDuesView()
        case .suggestions: SuggestionBoxView()
        case .approvals: ApprovalsView()
        case .proposalReview:
            if model.user?.role == "owner" { ProposalReviewView() }
            else if model.user?.canProposeDispensation == true { MyDispensationProposalsView() }
            else { ContentUnavailableView("Proposal access is not assigned", systemImage: "lock") }
        case .profile: SignatureProfileView()
        case .settings: SettingsView()
        default: DocumentsView()
        } }
    }
}

/// Persistent notices reserve their own space above the selected workspace.
struct WorkspaceNotices: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var updater = AppUpdater.shared
    @ObservedObject private var reliability = ReliabilityCenter.shared

    var body: some View {
        VStack(spacing: 0) {
            if let notice = reliability.notice {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: notice.recovered ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(notice.recovered ? .green : SignTheme.gold)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(notice.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                        Text(notice.message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Dismiss") { reliability.dismiss() }.fixedSize()
                }
                .padding(.horizontal, 22)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background((notice.recovered ? Color.green : SignTheme.gold).opacity(0.10))
                Divider()
            }
            if model.showSignInNotice, let session = model.signInSession {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: "checkmark.shield.fill")
                        .foregroundStyle(.green)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                        Text(session.explanation).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Got it") { model.dismissSignInNotice() }
                        .fixedSize()
                        .accessibilityLabel("Dismiss sign-in notice")
                }
                .padding(.horizontal, 22)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(SignTheme.gold.opacity(0.10))
                Divider()
            }
            if let version = updater.availableVersion {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: "arrow.down.circle.fill").foregroundStyle(SignTheme.gold)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Stone Square Sign update available").font(.headline)
                        Text("Version \(version) is ready.").font(.callout).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button(updater.readyToRestart ? "Finish update" : "Update") { updater.checkForUpdates() }.fixedSize()
                }
                .padding(.horizontal, 22)
                .padding(.vertical, 16)
                .background(Color(nsColor: .controlBackgroundColor))
                Divider()
            }
        }
    }
}

struct NativeCandidateTrackerView: View {
    @EnvironmentObject var model: AppModel
    @State private var category = "Entered Apprentices"
    @State private var query = ""
    @State private var ownerFilter = "All owners"
    @State private var statusFilter = "All statuses"
    @State private var editingRecord: CandidateRecord?
    @State private var creatingRecord = false

    private let categories = [
        "Entered Apprentices", "Degree History", "Prospects",
        "Website & Social Media Contacts", "Demits In", "Reclaimed", "Healing",
    ]

    private let categoryDescriptions = [
        "Entered Apprentices": "Instruction, proficiency, and degree progress",
        "Degree History": "Recently completed and inactive degree records",
        "Prospects": "Background, petition, investigation, and follow-up",
        "Website & Social Media Contacts": "Website, social media, and online contacts",
        "Demits In": "Transfers and documentary completion",
        "Reclaimed": "Reclamation progress, dues, and completed returns",
        "Healing": "Healing requests, requirements, and Lodge action",
    ]

    private let trackerGreen = Color.accentColor
    private let trackerGold = Color(red: 196 / 255, green: 154 / 255, blue: 67 / 255)
    private let trackerLine = Color(nsColor: .separatorColor)

    private var canEdit: Bool {
        model.user?.can("candidates.edit") == true
    }

    private var filteredRecords: [CandidateRecord] {
        let normalizedQuery = normalizedSearchText(query)
        let queryTerms = normalizedQuery.split(separator: " ").map(String.init)
        return model.candidateRecords.filter { record in
            let haystack = [record.name, record.phone, record.email, record.status, record.owner, record.nextStep, record.notes]
                .joined(separator: " ")
            let normalizedHaystack = normalizedSearchText(haystack)
            return record.category == category
                && (ownerFilter == "All owners" || record.owner == ownerFilter)
                && (statusFilter == "All statuses" || record.status == statusFilter)
                && queryTerms.allSatisfy { normalizedHaystack.contains($0) }
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func normalizedSearchText(_ value: String) -> String {
        let folded = value.folding(
            options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
            locale: Locale(identifier: "en_US_POSIX")
        )
        let searchable = folded.unicodeScalars.map {
            CharacterSet.alphanumerics.contains($0) ? String($0) : " "
        }.joined()
        return searchable.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private var ownerOptions: [String] {
        ["All owners"] + Array(Set(model.candidateRecords.map(\.owner).filter { !$0.isEmpty })).sorted()
    }

    private var statusOptions: [String] {
        ["All statuses"] + Array(Set(model.candidateRecords.filter { $0.category == category }.map(\.status).filter { !$0.isEmpty })).sorted()
    }

    private var attentionCount: Int {
        model.candidateRecords.filter { followUpTone(for: $0) == "attention" }.count
    }

    private var assignedCount: Int {
        model.candidateRecords.filter { !$0.owner.isEmpty }.count
    }

    @State private var selectedRecordID: String?
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Candidate Tracker", subtitle: "Candidate and membership records", symbol: "person.text.rectangle") {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.loadCandidateRecords() } }
                if canEdit { Button("Add record", systemImage: "plus") { editingRecord = .blank(category: category); creatingRecord = true }.buttonStyle(.borderedProminent) }
            }
            AdaptiveControlBar {
                HStack(spacing: 12) {
                    sectionPicker.frame(maxWidth: 270)
                    TextField("Search records", text: $query).textFieldStyle(.roundedBorder)
                    ownerPicker.frame(maxWidth: 200)
                    statusPicker.frame(maxWidth: 190)
                    clearFiltersButton
                }
            } compact: {
                VStack(alignment: .leading, spacing: 10) {
                    sectionPicker
                    TextField("Search records", text: $query).textFieldStyle(.roundedBorder)
                    HStack(spacing: 10) { ownerPicker; statusPicker; clearFiltersButton }
                }
            }.padding(16)
            Divider()
            GeometryReader { available in
                Group {
                    if available.size.width < 780 {
                        List(filteredRecords) { record in
                            Button { selectedRecordID = record.id } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack { Text(record.name).font(.headline); Spacer(); Text(record.status).font(.caption.weight(.semibold)).foregroundStyle(trackerGold) }
                                    if !record.owner.isEmpty { Text("Owner: \(record.owner)").font(.caption).foregroundStyle(.secondary) }
                                    if !record.nextStep.isEmpty { Text(record.nextStep).font(.callout).fixedSize(horizontal: false, vertical: true) }
                                }.padding(.vertical, 5).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    } else {
                        Table(filteredRecords, selection: $selectedRecordID) {
                            TableColumn("Name", value: \.name)
                            TableColumn("Status", value: \.status)
                            TableColumn("Owner", value: \.owner)
                            TableColumn("Next step", value: \.nextStep)
                        }
                    }
                }.overlay {
                    if model.candidateTrackerLoading && model.candidateRecords.isEmpty { ProgressView("Loading records…") }
                    else if filteredRecords.isEmpty { ContentUnavailableView("No matching records", systemImage: "person.text.rectangle", description: Text("Choose another section or adjust the filters.")) }
                }
            }
            if let record = filteredRecords.first(where: { $0.id == selectedRecordID }) {
                Divider()
                ScrollView { recordCard(record).padding(16) }.frame(height: 245)
            }
            Divider()
            HStack { Text("\(filteredRecords.count) records"); Spacer(); Text(categoryDescriptions[category] ?? "") }.font(.caption).foregroundStyle(.secondary).padding(12)
        }.background(Color(nsColor: .windowBackgroundColor))
        .onChange(of: category) { _, _ in statusFilter = "All statuses"; selectedRecordID = nil }
        .task {
            if model.candidateRecords.isEmpty { await model.loadCandidateRecords() }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 15_000_000_000)
                } catch {
                    break
                }
                if editingRecord == nil {
                    await model.loadCandidateRecords(silent: true)
                }
            }
        }
        .sheet(item: $editingRecord) { record in
            CandidateRecordEditorView(record: record, isNew: creatingRecord, categories: categories)
                .environmentObject(model)
        }
    }

    private var sectionPicker: some View {
        Picker("Section", selection: $category) { ForEach(categories, id: \.self) { Text($0).tag($0) } }
    }

    private var ownerPicker: some View {
        Picker("Owner", selection: $ownerFilter) { ForEach(ownerOptions, id: \.self) { Text($0).tag($0) } }
    }

    private var statusPicker: some View {
        Picker("Status", selection: $statusFilter) { ForEach(statusOptions, id: \.self) { Text($0).tag($0) } }
    }

    private var clearFiltersButton: some View {
        Button("Clear") { query = ""; ownerFilter = "All owners"; statusFilter = "All statuses" }
    }

    private func recordCard(_ record: CandidateRecord) -> some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    Circle().fill(trackerGold.opacity(0.18))
                    Text(initials(for: record.name)).font(.caption.weight(.bold)).foregroundStyle(trackerGreen)
                }
                .frame(width: 42, height: 42)
                VStack(alignment: .leading, spacing: 6) {
                    Text(record.name).font(.headline)
                    HStack(spacing: 12) {
                        if !record.phone.isEmpty { Label(record.phone, systemImage: "phone") }
                        if !record.email.isEmpty { Label(record.email, systemImage: "envelope") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                statusPill(record)
                if canEdit {
                    Button("Edit") {
                        creatingRecord = false
                        editingRecord = record
                    }
                    .buttonStyle(.bordered).tint(trackerGreen)
                } else {
                    Text("Read only").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 4), alignment: .leading, spacing: 18) {
                trackerDetail("OWNER", record.owner.isEmpty ? "Unassigned" : record.owner)
                trackerDetail("LAST CONTACTED", record.lastContacted.isEmpty ? "Not recorded" : record.lastContacted)
                trackerDetail("TARGET DATE", record.targetDate.isEmpty ? "Not set" : record.targetDate)
                trackerDetail("INSTRUCTOR", record.instructor.isEmpty ? "Not assigned" : record.instructor)
            }

            if !record.nextStep.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("NEXT STEP").font(.caption2.weight(.bold)).tracking(1.1).foregroundStyle(.secondary)
                    Text(record.nextStep).font(.callout).lineSpacing(3)
                }
                .padding(13).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor))
                .overlay(alignment: .leading) { Rectangle().fill(trackerGold).frame(width: 3) }
            }

            if !record.notes.isEmpty || !record.source.isEmpty {
                DisclosureGroup("Notes and record source") {
                    VStack(alignment: .leading, spacing: 7) {
                        if !record.notes.isEmpty { Text(record.notes).font(.caption).foregroundStyle(.secondary) }
                        if !record.source.isEmpty { Text("Source: \(record.source)").font(.caption2).foregroundStyle(.secondary) }
                    }
                    .padding(.top, 8).frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.caption.weight(.semibold)).tint(trackerGreen)
            }
        }
        .padding(19)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(trackerLine))
    }

    private func trackerDetail(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption2.weight(.bold)).tracking(0.9).foregroundStyle(.secondary)
            Text(value).font(.caption.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func statusPill(_ record: CandidateRecord) -> some View {
        let tone = followUpTone(for: record)
        let colors: (Color, Color) = switch tone {
        case "complete": (Color(red: 230 / 255, green: 243 / 255, blue: 235 / 255), Color(red: 26 / 255, green: 106 / 255, blue: 72 / 255))
        case "attention": (Color(red: 245 / 255, green: 234 / 255, blue: 208 / 255), Color(red: 119 / 255, green: 86 / 255, blue: 18 / 255))
        case "paused": (Color(red: 248 / 255, green: 227 / 255, blue: 223 / 255), Color(red: 139 / 255, green: 62 / 255, blue: 53 / 255))
        default: (Color(red: 232 / 255, green: 238 / 255, blue: 241 / 255), Color(red: 60 / 255, green: 89 / 255, blue: 102 / 255))
        }
        return Text(record.status.isEmpty ? "No status" : record.status)
            .font(.caption2.weight(.bold)).foregroundStyle(colors.1)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(colors.0, in: Capsule())
    }

    private func followUpTone(for record: CandidateRecord) -> String {
        let value = "\(record.status) \(record.nextStep)".lowercased()
        if value.contains("complete") || value.contains("raised") || value.contains("reclaimed") { return "complete" }
        if value.contains("not ready") || value.contains("dropped") || value.contains("withdrawn") { return "paused" }
        if value.contains("pending") || value.contains("confirm") || value.contains("needed") || value.contains("follow-up") { return "attention" }
        return "current"
    }

    private func initials(for name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined()
    }


}

struct CandidateRecordEditorView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State var record: CandidateRecord
    let isNew: Bool
    let categories: [String]
    private let initialRecord: CandidateRecord
    @State private var confirmCancel = false

    init(record: CandidateRecord, isNew: Bool, categories: [String]) {
        _record = State(initialValue: record)
        self.isNew = isNew
        self.categories = categories
        self.initialRecord = record
    }

    private let statuses = [
        "New", "Not started", "In progress", "Needs follow-up", "Background not submitted",
        "Background cleared", "Petition pending", "Investigation pending", "Ready for ballot",
        "Not active in current class", "Raised", "Demit pending", "Demit complete",
        "Reclaimed", "Healing in progress", "Healing complete",
        "Withdrawn — does not wish to continue", "Closed / no action",
    ]
    private let owners = [
        "", "WM Dixon-Saunders", "SW Xavier White", "JW Jamal Sadler",
        "SD Cliff Skinner", "PM Fred Cooke",
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(isNew ? "Add candidate record" : "Edit candidate record")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(SignTheme.navy)
                    Text("Changes appear in the Mac app and tracker URL.").foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(24)
            Divider()
            Form {
                Section("Candidate") {
                    TextField("Full name", text: $record.name)
                    Picker("Section", selection: $record.category) {
                        ForEach(categories, id: \.self) { Text($0).tag($0) }
                    }
                    TextField("Phone", text: $record.phone)
                    TextField("Email", text: $record.email)
                }
                Section("Progress") {
                    Picker("Status", selection: $record.status) {
                        ForEach(statuses, id: \.self) { Text($0).tag($0) }
                    }
                    Picker("Owner", selection: $record.owner) {
                        ForEach(owners, id: \.self) { Text($0.isEmpty ? "Unassigned" : $0).tag($0) }
                    }
                    TextField("Last contacted (YYYY-MM-DD)", text: $record.lastContacted)
                    TextField("Next step", text: $record.nextStep)
                    TextField("Target date (YYYY-MM-DD)", text: $record.targetDate)
                    TextField("Instructor", text: $record.instructor)
                }
                Section("Record details") {
                    TextField("Source", text: $record.source)
                    TextField("Notes", text: $record.notes, axis: .vertical)
                        .lineLimit(4...9)
                }
            }
            .formStyle(.grouped)
            HStack {
                Button("Cancel", role: .cancel) {
                    if record != initialRecord { confirmCancel = true }
                    else { dismiss() }
                }
                Spacer()
                Button(isNew ? "Add record" : "Save changes") {
                    Task {
                        if await model.saveCandidateRecord(record, isNew: isNew) { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent).tint(.accentColor)
                .disabled(record.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.candidateTrackerLoading)
            }
            .padding(20)
        }
        .frame(minWidth: 560, idealWidth: 720, minHeight: 560, idealHeight: 720)
        .updateDraftGuard(active: record != initialRecord || model.candidateTrackerLoading, reason: "Save or cancel the candidate record before updating.")
        .interactiveDismissDisabled(record != initialRecord || model.candidateTrackerLoading)
        .alert("Discard candidate record changes?", isPresented: $confirmCancel) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: { Text("The changes in this editor have not been saved.") }
    }
}

struct DispensationBuilderView: View {
    @EnvironmentObject var model: AppModel
    @State private var title = ""
    @State private var requestDate = Date()
    @State private var signerChoice = "both"

    /* The builder asks one question and the server takes a list. Sending to both is the
     * ordinary case: either Secretary may sign and the first one to do it finishes it. */
    private static let signerLabels = [
        "both": "Both Secretaries, whoever signs first",
        "secretary": "William McDuffie, Secretary",
        "assistant_secretary": "Adrian Reese, Assistant Secretary",
    ]
    private static func signerRoles(for choice: String) -> [String] {
        choice == "both" ? ["secretary", "assistant_secretary"] : [choice]
    }
    private static func signerLabel(for choice: String) -> String {
        signerLabels[choice] ?? signerLabels["both"]!
    }
    @State private var requestDetails = ""
    @State private var eventDate = Date()
    @State private var eventTime = Date()
    @State private var locationName = ""
    @State private var streetAddress = ""
    @State private var cityState = ""
    @State private var worshipfulMasterAddress = ""
    @State private var personalInfoConfirmed = false
    @State private var pastedDetails = ""
    @State private var parsedDraft: ParsedDispensationResponse?
    @State private var showingPasteReview = false
    @State private var previewDocument: PDFDocument?
    @State private var step = 0

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.dateFormat = "h:mm a"
        return formatter
    }()

    private static let pastedTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let displayDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.dateFormat = "MMMM d, yyyy"
        return formatter
    }()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                NativeWorkspaceHeader(title: "Create Dispensation", subtitle: "Prepare the request and review the official document", symbol: "doc.badge.plus").padding(.horizontal, -22)
                HStack(spacing: 30) {
                    Label("Stone Square Lodge No. 22", systemImage: "building.columns.fill")
                    Label(model.user?.name ?? "Worshipful Master", systemImage: "signature")
                }
                .font(.headline).foregroundStyle(SignTheme.navy)
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))

                if step == 0 {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Paste all dispensation details", systemImage: "doc.on.clipboard")
                            .font(.headline).foregroundStyle(SignTheme.navy)
                        Text("Include the event, date, time, location, and what the Lodge is requesting. You will approve the extracted details next.")
                            .font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: $pastedDetails)
                            .font(.body)
                            .frame(minHeight: 165)
                            .padding(8)
                            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                            .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator) }
                        Button("Read and review pasted details", systemImage: "text.magnifyingglass") { parsePastedDetails() }
                            .buttonStyle(.borderedProminent).tint(.accentColor)
                            .disabled(model.isBusy || pastedDetails.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .padding(20)
                    .background(SignTheme.gold.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                } else if step == 1 {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Remaining questions")
                            .font(.title2.weight(.semibold)).foregroundStyle(SignTheme.navy)
                        Text("The event information you approved is already saved. The officer will enter their own name and address when signing.")
                            .foregroundStyle(.secondary)
                        Form {
                            Section("Who should sign for the secretary's office?") {
                                Text("Goes to both Secretaries. Whoever signs it first completes it.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Section("Your information") {
                                TextField("Worshipful Master address", text: $worshipfulMasterAddress)
                                Toggle("Yes, use this Worshipful Master address for this submission", isOn: $personalInfoConfirmed)
                                Text("Only your address is collected here. The selected officer completes their information on their side.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .formStyle(.grouped)
                        .frame(height: 265)
                        HStack {
                            Button("Back to pasted details") { step = 0 }
                            Spacer()
                            Button("Review summary and PDF", systemImage: "doc.text.magnifyingglass") { createPreview() }
                                .buttonStyle(.borderedProminent).tint(.accentColor).controlSize(.large)
                                .disabled(model.isBusy || !personalInfoConfirmed || worshipfulMasterAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    .padding(22)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                } else {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Final review")
                            .font(.title2.weight(.semibold)).foregroundStyle(SignTheme.navy)
                        VStack(spacing: 0) {
                            ReviewField(label: "Title", value: title)
                            ReviewField(label: "Request", value: requestDetails)
                            ReviewField(label: "Event", value: "\(Self.displayDayFormatter.string(from: eventDate)) at \(Self.timeFormatter.string(from: eventTime))")
                            ReviewField(label: "Location", value: "\(locationName)\n\(streetAddress)\n\(cityState)")
                            ReviewField(label: "Send to", value: Self.signerLabel(for: signerChoice))
                            ReviewField(label: "Your address", value: worshipfulMasterAddress)
                        }
                        Text("The officer's section is intentionally blank in this preview. The selected officer completes it when signing.")
                            .font(.caption).foregroundStyle(.secondary)
                        if let previewDocument {
                            PDFKitContainer(document: previewDocument)
                                .frame(minHeight: 560)
                                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                                .overlay { RoundedRectangle(cornerRadius: 10).stroke(.separator) }
                        }
                        HStack {
                            Button("Back to remaining questions") { step = 1 }
                            Spacer()
                            Button("Send for officer signature", systemImage: "paperplane.fill") { create() }
                                .buttonStyle(.borderedProminent).tint(.accentColor).controlSize(.large)
                                .disabled(model.isBusy || previewDocument == nil)
                        }
                    }
                    .padding(22)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(22)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .updateDraftGuard(active: !pastedDetails.isEmpty || !title.isEmpty || !requestDetails.isEmpty || !locationName.isEmpty || !streetAddress.isEmpty || !cityState.isEmpty, reason: "Finish your dispensation draft before updating. Your entered details are still open.")
        .task { applySavedProfiles() }
        .onChange(of: worshipfulMasterAddress) { _, _ in personalInfoConfirmed = false }
        .sheet(isPresented: $showingPasteReview) {
            if let parsedDraft {
                DispensationPasteReviewView(
                    result: parsedDraft,
                    useDetails: applyParsedDraft,
                    reject: { showingPasteReview = false }
                )
            }
        }
    }

    private func create() {
        Task {
            let saved = await model.createDispensation(
                title: title,
                requestDate: Self.dayFormatter.string(from: requestDate),
                signerRoles: Self.signerRoles(for: signerChoice),
                requestDetails: requestDetails,
                eventDate: Self.dayFormatter.string(from: eventDate),
                eventTime: Self.timeFormatter.string(from: eventTime),
                locationName: locationName,
                streetAddress: streetAddress,
                cityState: cityState,
                worshipfulMasterAddress: worshipfulMasterAddress,
                personalInfoConfirmed: personalInfoConfirmed
            )
            if saved {
                title = ""
                requestDetails = ""
                locationName = ""
                streetAddress = ""
                cityState = ""
                pastedDetails = ""
                parsedDraft = nil
                previewDocument = nil
                personalInfoConfirmed = false
                step = 0
            }
        }
    }

    private func applySavedProfiles() {
        worshipfulMasterAddress = model.submissionProfiles
            .first(where: { $0.role == "worshipful_master" })?.address ?? ""
        personalInfoConfirmed = false
    }

    private func parsePastedDetails() {
        Task {
            guard let result = await model.parseDispensationText(pastedDetails) else { return }
            parsedDraft = result
            showingPasteReview = true
        }
    }

    private func applyParsedDraft() {
        guard let fields = parsedDraft?.fields else { return }
        title = fields.title
        if let value = Self.dayFormatter.date(from: fields.requestDate) { requestDate = value }
        // The Lodge no longer chooses a Secretary; every dispensation goes to both.
        requestDetails = fields.requestDetails
        if let value = Self.dayFormatter.date(from: fields.eventDate) { eventDate = value }
        if let value = Self.pastedTimeFormatter.date(from: fields.eventTime) { eventTime = value }
        locationName = fields.locationName
        streetAddress = fields.streetAddress
        cityState = fields.cityState
        applySavedProfiles()
        if !fields.worshipfulMasterAddress.isEmpty { worshipfulMasterAddress = fields.worshipfulMasterAddress }
        personalInfoConfirmed = false
        showingPasteReview = false
        step = 1
    }

    private func createPreview() {
        Task {
            guard let data = await model.previewDispensation(
                title: title,
                requestDate: Self.dayFormatter.string(from: requestDate),
                signerRoles: Self.signerRoles(for: signerChoice),
                requestDetails: requestDetails,
                eventDate: Self.dayFormatter.string(from: eventDate),
                eventTime: Self.timeFormatter.string(from: eventTime),
                locationName: locationName,
                streetAddress: streetAddress,
                cityState: cityState,
                worshipfulMasterAddress: worshipfulMasterAddress,
                personalInfoConfirmed: personalInfoConfirmed
            ), let document = PDFDocument(data: data) else { return }
            previewDocument = document
            step = 2
        }
    }
}

struct LandingDashboardView: View {
    @EnvironmentObject var model: AppModel
    let openDispensations: () -> Void
    let openCandidateTracker: () -> Void
    let openReports: () -> Void
    let openReceivedReports: () -> Void
    let openMinutes: () -> Void
    let openAgenda: () -> Void
    let openTreasury: () -> Void
    let openBuilding: () -> Void
    let openCalendar: () -> Void

    private var awaitingCount: Int {
        if model.user?.role == "owner" || model.user?.role == "viewer" {
            return model.documents.filter { !$0.isTerminal }.count
        }
        return model.documents.filter { $0.needsSignature && !$0.isTerminal }.count
    }

    private var easternGreeting: String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .current
        let hour = calendar.component(.hour, from: Date())
        if hour < 12 { return "Good morning" }
        if hour < 17 { return "Good afternoon" }
        return "Good evening"
    }

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Home", subtitle: "\(easternGreeting), \(model.user?.name ?? "")", symbol: "square.grid.2x2")
            List {
                if model.user?.role == "owner", model.emailDeliveryReady == false {
                    Section("Service status") {
                        Label("Email delivery needs attention", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text("Invitations, password reset codes, and record notifications are saved, but email cannot leave the Dashboard until the mail service is connected.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                Section("Reports and records") {
                    if model.user?.canOpen(.building) == true { homeRow("Building Requests", model.user?.can("building.view") == true ? "Submit building requests and view recorded decisions" : "Submit a request to use the Lodge building", "building.2", action: openBuilding) }
                    if model.user?.canOpen(.lodgeCalendar) == true { homeRow("Lodge Calendar", "View scheduled events", "calendar", action: openCalendar) }
                    if model.user?.can("reports.create") == true { homeRow("Report Generator", "Prepare, preview and send a Lodge report", "doc.text", action: openReports) }
                    if model.user?.role == "owner" { homeRow("Received Reports", "Review reports submitted to you", "tray.full.fill", action: openReceivedReports) }
                    if model.user?.can("documents.status") == true {
                        homeRow("Dispensations", awaitingCount > 0 ? "\(awaitingCount) awaiting action" : "Open the document queue", "doc.text.fill", action: openDispensations)
                    }
                    if model.user?.canReadMinutes == true {
                        homeRow("Meeting Minutes", model.user?.can("minutes.prepare") == true ? "Prepare, review and attest to meeting records" : "Read finalized meeting records", "text.document.fill", action: openMinutes)
                    }
                    if model.user?.role == "owner" { homeRow("Agenda Creator", "Create, save, resume, and preview Lodge agenda drafts", "list.number", action: openAgenda) }
                    if model.user?.canUseTreasury == true {
                        homeRow("Treasurer Reports", model.user?.can("treasury.prepare") == true ? (model.treasuryAlerts.isEmpty ? "Prepare and review treasurer reports" : "\(model.treasuryAlerts.count) banking record\(model.treasuryAlerts.count == 1 ? "" : "s") awaiting a preparer") : model.user?.can("treasury.upload") == true ? "Provide banking records and view reports" : "Read finalized treasurer reports", "chart.bar.doc.horizontal.fill", action: openTreasury)
                    }
                    if model.user?.can("candidates.view") == true {
                        homeRow("Candidate Tracker", "Open candidate and membership records", "person.text.rectangle", action: openCandidateTracker)
                    }
                }
                Section("Your account") {
                    LabeledContent("Signed in as", value: model.user?.name ?? "")
                    LabeledContent("Access", value: model.user?.roleLabel ?? "")
                }
            }.listStyle(.inset).environment(\.defaultMinListRowHeight, 48)
        }.background(Color(nsColor: .windowBackgroundColor))
            .task { if model.emailDeliveryReady == nil { await model.loadServiceSetup() } }
    }
    private func homeRow(_ title: String, _ detail: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: symbol).font(.title3).foregroundStyle(Color.accentColor).frame(width: 28)
                VStack(alignment: .leading, spacing: 4) { Text(title).font(.headline); Text(detail).font(.callout).foregroundStyle(.secondary) }
                Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }.padding(.vertical, 8).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct LocationConfirmationView: View {
    let match: LocationMatch
    let useAddress: () -> Void
    let reject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("ADDRESS CHECK").font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
            Text("Is this the correct event address?")
                .font(.title2.weight(.semibold)).foregroundStyle(SignTheme.navy)
            VStack(alignment: .leading, spacing: 8) {
                Text(match.displayName).font(.headline)
                Text(match.streetAddress)
                Text(match.cityState)
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(SignTheme.gold.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
            Text("Address search provided by OpenStreetMap.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("No, keep my current address", action: reject)
                Spacer()
                Button("Yes, use this address", action: useAddress)
                    .buttonStyle(.borderedProminent).tint(.accentColor)
            }
        }
        .padding(30)
        .frame(minWidth: 480, idealWidth: 640, maxWidth: 640)
    }
}

struct DispensationPasteReviewView: View {
    let result: ParsedDispensationResponse
    let useDetails: () -> Void
    let reject: () -> Void

    private func humanDate(_ value: String) -> String {
        let input = DateFormatter()
        input.locale = Locale(identifier: "en_US_POSIX")
        input.timeZone = TimeZone(secondsFromGMT: 0)
        input.dateFormat = "yyyy-MM-dd"
        guard let date = input.date(from: value) else { return value }
        let output = DateFormatter()
        output.locale = Locale(identifier: "en_US")
        output.timeZone = TimeZone(secondsFromGMT: 0)
        output.dateFormat = "MMMM d, yyyy"
        return output.string(from: date)
    }

    private var humanEventTime: String {
        let input = DateFormatter()
        input.locale = Locale(identifier: "en_US_POSIX")
        input.dateFormat = "HH:mm"
        guard let date = input.date(from: result.fields.eventTime) else { return result.fields.eventTime }
        let output = DateFormatter()
        output.locale = Locale(identifier: "en_US")
        output.dateFormat = "h:mm a"
        return output.string(from: date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("PASTED DETAILS REVIEW").font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
            Text("Does this look correct?")
                .font(.title2.weight(.semibold)).foregroundStyle(SignTheme.navy)
            ScrollView {
                VStack(spacing: 0) {
                    ReviewField(label: "Title", value: result.fields.title)
                    ReviewField(label: "Request date", value: humanDate(result.fields.requestDate))
                    ReviewField(label: "Send to", value: result.fields.signerRole == "assistant_secretary"
                        ? "Adrian Reese, Assistant Secretary" : "Both Secretaries, whoever signs first")
                    ReviewField(label: "Request", value: result.fields.requestDetails)
                    ReviewField(label: "Event date", value: humanDate(result.fields.eventDate))
                    ReviewField(label: "Event time", value: humanEventTime)
                    ReviewField(label: "Location", value: result.fields.locationName)
                    ReviewField(label: "Street", value: result.fields.streetAddress)
                    ReviewField(label: "City, state, ZIP", value: result.fields.cityState)
                    if !result.fields.worshipfulMasterAddress.isEmpty {
                        ReviewField(label: "Worshipful Master address", value: result.fields.worshipfulMasterAddress)
                    }
                    if !result.fields.secretaryAddress.isEmpty {
                        ReviewField(label: "Officer address", value: result.fields.secretaryAddress)
                    }
                }
            }
            .frame(maxHeight: 430)
            if !result.warnings.isEmpty {
                Text(result.warnings.joined(separator: "\n"))
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Button("No, go back", action: reject)
                Spacer()
                Button("Yes, use these details", action: useDetails)
                    .buttonStyle(.borderedProminent).tint(.accentColor)
            }
        }
        .padding(30)
        .frame(minWidth: 500, idealWidth: 680, maxWidth: 680)
    }
}

struct ReviewField: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            Text(label).font(.caption.weight(.bold)).foregroundStyle(.secondary).frame(width: 145, alignment: .leading)
            Text(value.isEmpty ? "Not found" : value).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 9)
        .overlay(alignment: .bottom) { Divider() }
    }
}

struct DocumentsView: View {
    @EnvironmentObject var model: AppModel
    @State private var showImporter = false
    @State private var signingDocument: LodgeDocument?
    @State private var viewingDocument: LodgeDocument?

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Lodge Documents", subtitle: "Requests, signatures and completed records", symbol: "doc.on.doc") {
                if model.user?.role == "owner" { Button("Upload document", systemImage: "arrow.up.doc") { showImporter = true }.buttonStyle(.borderedProminent) }
            }
            HStack(spacing: 16) {
                MetricBox(label: "All records", value: model.documents.count)
                MetricBox(label: "Awaiting signatures", value: model.documents.filter { !$0.isTerminal }.count)
                MetricBox(label: "Completed", value: model.documents.filter(\.isComplete).count)
            }.padding(16)
            Divider()
            List {
                if model.documents.isEmpty { ContentUnavailableView("The queue is clear", systemImage: "checkmark.seal", description: Text("New dispensations will appear here automatically.")) }
                ForEach(Array(model.documents.enumerated()), id: \.element.id) { index, document in
                    DocumentRow(document: document, queueNumber: document.isTerminal ? nil : index + 1, open: { viewingDocument = document }, sign: { signingDocument = document })
                }
            }.listStyle(.inset)
        }.background(Color(nsColor: .windowBackgroundColor))
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.pdf]) { result in
            if case .success(let url) = result { Task { await model.upload(url: url) } }
        }
        .sheet(item: $signingDocument) { document in SignatureApprovalView(document: document) }
        .sheet(item: $viewingDocument) { document in PDFPreviewView(document: document) }
    }
}

struct MetricBox: View {
    let label: String
    let value: Int
    var body: some View {
        HStack {
            Text(label).font(.callout.weight(.medium)).foregroundStyle(.secondary)
            Spacer()
            Text("\(value)").font(.title2.weight(.semibold)).foregroundStyle(SignTheme.navy)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.45)) }
    }
}

struct DocumentRow: View {
    @EnvironmentObject var model: AppModel
    let document: LodgeDocument
    let queueNumber: Int?
    let open: () -> Void
    let sign: () -> Void
    @State private var pendingQueueAction: QueueAction?

    private enum QueueAction {
        case offerToBothSecretaries, submitToDistrictDeputy, resendToDistrictDeputy

        var title: String {
            switch self {
            case .offerToBothSecretaries: return "Let either Secretary sign this dispensation?"
            case .submitToDistrictDeputy: return "Send this dispensation to the District Deputy?"
            case .resendToDistrictDeputy: return "Send this dispensation again?"
            }
        }
        var button: String {
            switch self {
            case .offerToBothSecretaries: return "Add the other Secretary"
            case .submitToDistrictDeputy: return "Send dispensation"
            case .resendToDistrictDeputy: return "Send again"
            }
        }
        var explanation: String {
            switch self {
            case .offerToBothSecretaries: return "The first Secretary to sign will complete the secretary step. The document and existing signatures remain unchanged."
            case .submitToDistrictDeputy: return "This sends the completed PDF and submission note. Review the document before continuing."
            case .resendToDistrictDeputy: return "This sends another copy of the completed PDF and submission note."
            }
        }
    }

    private var onlyOneSecretary: Bool {
        let roles = Set(document.signers.map(\.signerRole))
        return roles.contains("secretary") != roles.contains("assistant_secretary")
    }

    private var statusText: String {
        document.isRescinded ? "Rescinded" : document.isComplete ? "Completed" : document.needsSignature ? "Your signature" : "Awaiting"
    }

    private var statusColor: Color {
        document.isRescinded ? .red : document.isComplete ? .green : SignTheme.navy
    }

    @ViewBuilder private var compactActions: some View {
        if model.user?.role != "viewer" {
            Menu("Actions") {
                Button("View", action: open)
                if model.user?.role == "owner" && !document.isTerminal && onlyOneSecretary {
                    Button("Let either Secretary sign") { pendingQueueAction = .offerToBothSecretaries }
                }
                if model.user?.can("documents.sign") == true && document.needsSignature && !document.isTerminal {
                    Button("Review and sign", action: sign)
                }
                if model.user?.role == "owner" && document.isComplete && document.isDispensation {
                    Button("Draft in my mail app") { Task { await model.draftToDistrictDeputy(document: document) } }
                    if document.submittedAt == nil {
                        Button("Send to the District Deputy") { pendingQueueAction = .submitToDistrictDeputy }
                    } else {
                        Button("Send again") { pendingQueueAction = .resendToDistrictDeputy }
                    }
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize(horizontal: true, vertical: false)
        }
    }

    private var compactRow: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(document.isRescinded ? "R" : queueNumber.map(String.init) ?? "✓")
                .font(.caption.weight(.bold)).foregroundStyle(SignTheme.navy)
                .frame(width: 28, height: 28).background(SignTheme.gold.opacity(0.25), in: Circle())
            VStack(alignment: .leading, spacing: 8) {
                Text(document.displayTitle).font(.headline).foregroundStyle(SignTheme.navy)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(document.signers) { signer in SignerStatusView(signer: signer).font(.caption) }
                HStack(spacing: 10) {
                    Text(statusText).font(.caption.weight(.semibold)).foregroundStyle(statusColor)
                    Spacer(minLength: 8)
                    compactActions
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
        HStack(spacing: 14) {
            Text(document.isRescinded ? "R" : queueNumber.map(String.init) ?? "✓")
                .font(.caption.weight(.bold))
                .foregroundStyle(SignTheme.navy)
                .frame(width: 28, height: 28)
                .background(SignTheme.gold.opacity(0.25), in: Circle())
            Image(systemName: "doc.richtext.fill")
                .font(.title2).foregroundStyle(.red)
                .frame(width: 42, height: 48)
                .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 6) {
                Text(document.displayTitle).font(.headline).foregroundStyle(SignTheme.navy)
                HStack {
                    ForEach(document.signers) { signer in SignerStatusView(signer: signer) }
                }
                .font(.caption)
                /* Loud on failure on purpose. A dispensation that quietly did not send is one
                 * that misses its date, which is exactly how the invitations were lost. */
                if document.isComplete && document.isDispensation {
                    if let sentAt = document.submittedAt {
                        Text("Sent to the District Deputy \(LodgeDateTime.display(sentAt))")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else {
                        Text(document.submittedError.map { "NOT sent to the District Deputy. \($0)" }
                            ?? "Not yet sent to the District Deputy.")
                            .font(.caption2.weight(.semibold)).foregroundStyle(.red)
                    }
                }
            }
            Spacer()
            Text(document.isRescinded ? "Rescinded" : document.isComplete ? "Completed" : document.needsSignature ? "Your signature" : "Awaiting")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10).padding(.vertical, 6)
                .foregroundStyle(document.isRescinded ? .red : document.isComplete ? .green : SignTheme.navy)
                .background((document.isRescinded ? Color.red : document.isComplete ? Color.green : SignTheme.gold).opacity(0.11), in: Capsule())
            if model.user?.role != "viewer" {
                Button("View", action: open).buttonStyle(.borderless)
                /* Only worth offering while exactly one of the two Secretaries is on it. */
                if model.user?.role == "owner" && !document.isTerminal && onlyOneSecretary {
                    Button("Let either Secretary sign") {
                        pendingQueueAction = .offerToBothSecretaries
                    }
                    .buttonStyle(.borderless)
                }
                if model.user?.can("documents.sign") == true && document.needsSignature && !document.isTerminal {
                    Button("Review and sign", action: sign)
                        .buttonStyle(.borderedProminent).tint(.accentColor)
                }
                if model.user?.role == "owner" && document.isComplete && document.isDispensation {
                    Button("Draft in my mail app") {
                        Task { await model.draftToDistrictDeputy(document: document) }
                    }
                    .buttonStyle(.borderless)
                    if document.submittedAt == nil {
                        Button("Send to the District Deputy") {
                            pendingQueueAction = .submitToDistrictDeputy
                        }
                        .buttonStyle(.borderedProminent).tint(.accentColor)
                    } else {
                        Button("Send again") {
                            pendingQueueAction = .resendToDistrictDeputy
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
        }.fixedSize(horizontal: true, vertical: false)
        compactRow
        }
        .padding(.vertical, 13)
        .alert(pendingQueueAction?.title ?? "Confirm document action", isPresented: Binding(
            get: { pendingQueueAction != nil },
            set: { if !$0 { pendingQueueAction = nil } }
        )) {
            Button(pendingQueueAction?.button ?? "Continue") {
                let action = pendingQueueAction
                pendingQueueAction = nil
                Task {
                    switch action {
                    case .offerToBothSecretaries: _ = await model.offerToBothSecretaries(documentId: document.id)
                    case .submitToDistrictDeputy: _ = await model.submitToDistrictDeputy(documentId: document.id)
                    case .resendToDistrictDeputy: _ = await model.submitToDistrictDeputy(documentId: document.id, resend: true)
                    case nil: break
                    }
                }
            }
            Button("Cancel", role: .cancel) { pendingQueueAction = nil }
        } message: {
            Text(pendingQueueAction?.explanation ?? "Review the document before continuing.")
        }
    }
}

struct PDFPreviewView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let document: LodgeDocument
    @State private var pdfDocument: PDFDocument?
    @State private var errorMessage = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("LODGE RECORD").font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
                    Text(document.displayTitle).font(.title2.weight(.semibold)).foregroundStyle(SignTheme.navy)
                }
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(20)
            Divider()
            Group {
                if let pdfDocument {
                    PDFKitContainer(document: pdfDocument)
                } else if !errorMessage.isEmpty {
                    ContentUnavailableView("PDF unavailable", systemImage: "doc.badge.xmark", description: Text(errorMessage))
                } else {
                    ProgressView("Loading protected PDF...")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 620, idealWidth: 920, minHeight: 540, idealHeight: 720)
        .task {
            do {
                let data = try await model.pdfData(document: document)
                guard let loaded = PDFDocument(data: data) else {
                    throw ClientError.server("The file is not a readable PDF.")
                }
                pdfDocument = loaded
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

struct PDFKitContainer: NSViewRepresentable {
    let document: PDFDocument

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.document = document
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}

struct SignerStatusView: View {
    let signer: Signer
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: signer.signedAt == nil ? "circle" : "checkmark.circle.fill")
            Text(signer.signerName)
        }
        .foregroundStyle(signer.signedAt == nil ? Color.secondary : Color.green)
    }
}

struct OfficerAccessView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @State private var email = ""
    @State private var role = "secretary"
    @State private var privateLink = ""
    @State private var revokeTargetName = ""
    @State private var revokeTargetEmail = ""
    @State private var showRevokeConfirmation = false
    private var canCreateInvitation: Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedName.isEmpty && trimmedEmail.contains("@") && trimmedEmail.split(separator: "@").last?.contains(".") == true && !model.isBusy
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                NativeWorkspaceHeader(title: "Officer Access", subtitle: "Invitations and account access", symbol: "person.badge.key").padding(.horizontal, -22)
                NativeAccountPermissionsView()
                /* One card per man, in one grid, so a Lodge Viewer reads exactly the way the
                 * two Secretaries do. Viewers previously had nowhere to appear at all, which made
                 * an invited Brother invisible until he signed in. */
                let seats: [(name: String, office: String, state: OfficerSeatState)] =
                    [(model.seatName(role: "secretary", fallback: "William McDuffie"),
                      "Secretary", model.seatState(role: "secretary")),
                     (model.seatName(role: "assistant_secretary", fallback: "Adrian Reese"),
                      "Assistant Secretary", model.seatState(role: "assistant_secretary")),
                     (model.seatName(role: "treasurer", fallback: "Treasurer"), "Treasurer", model.seatState(role: "treasurer")),
                     (model.seatName(role: "assistant_treasurer", fallback: "Assistant Treasurer"), "Assistant Treasurer", model.seatState(role: "assistant_treasurer"))]
                    + model.officers.filter { ["viewer","member","warden","treasury_preparer","officer"].contains($0.role) }
                        .map { ($0.name, User.roleLabel(for: $0.role), OfficerSeatState.active) }
                    + model.pendingInvitations.filter { ["viewer","member","warden","treasury_preparer","officer"].contains($0.role) }
                        .map { ($0.name, User.roleLabel(for: $0.role), OfficerSeatState.pending) }
                VStack(spacing: 0) {
                    ForEach(Array(seats.enumerated()), id: \.offset) { _, seat in
                        OfficerCard(name: seat.name, office: seat.office, state: seat.state)
                    }
                }
                Form {
                    Picker("Office", selection: $role) {
                        Text("Secretary").tag("secretary")
                        Text("Assistant Secretary").tag("assistant_secretary")
                    Text("Treasurer").tag("treasurer")
                    Text("Assistant Treasurer").tag("assistant_treasurer")
                    Text("Treasury Report Preparer").tag("treasury_preparer")
                        Text("Lodge Officer").tag("officer")
                        Text("Lodge Viewer").tag("viewer")
                        Text("Lodge Member (permissions assigned separately)").tag("member")
                    }
                    TextField("Full name", text: $name)
                    TextField("Email address", text: $email)
                    Button("Create private invitation") {
                        Task {
                            if let invite = await model.invite(name: name, email: email, role: role) {
                                privateLink = invite.inviteUrl
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent).tint(.accentColor)
                    .disabled(!canCreateInvitation)
                    if !privateLink.isEmpty {
                        TextField("Private link", text: $privateLink)
                        Button("Copy private link") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(privateLink, forType: .string)
                        }
                    }
                }
                .formStyle(.grouped)
                .frame(maxWidth: 660)

                if !model.pendingInvitations.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Invited, waiting on them")
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(SignTheme.navy)
                        Text("They can create their account with the address you invited, or with the private link.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        ForEach(model.pendingInvitations) { invite in
                            HStack(spacing: 14) {
                                Image(systemName: "hourglass.circle.fill")
                                    .font(.title2)
                                    .foregroundStyle(.orange)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(invite.name).font(.headline)
                                    Text("\(User.roleLabel(for: invite.role)) · \(invite.email)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("Pending")
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .foregroundStyle(.orange)
                                    .background(Color.orange.opacity(0.12), in: Capsule())
                            }
                            .padding(.vertical, 10)
                            if invite.email != model.pendingInvitations.last?.email { Divider() }
                        }
                    }
                    .padding(20)
                    .background(.background, in: RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.5)) }
                }

                if !model.officers.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Active access")
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(SignTheme.navy)
                        Text("Revocation signs the person out immediately. Signed documents and audit history are preserved.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        ForEach(model.officers) { officer in
                            HStack(spacing: 14) {
                                Image(systemName: "person.crop.circle.badge.checkmark")
                                    .font(.title2)
                                    .foregroundStyle(SignTheme.gold)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(officer.name).font(.headline)
                                    Text("\(User.roleLabel(for: officer.role)) · \(officer.email)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Revoke access", role: .destructive) {
                                    revokeTargetName = officer.name
                                    revokeTargetEmail = officer.email
                                    showRevokeConfirmation = true
                                }
                            }
                            .padding(14)
                            .background(.background, in: RoundedRectangle(cornerRadius: 8))
                            .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.4)) }
                        }
                    }
                    .frame(maxWidth: 760, alignment: .leading)
                }
            }
            .padding(22)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .alert("Revoke access for \(revokeTargetName)?", isPresented: $showRevokeConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Revoke access", role: .destructive) {
                Task { await model.revokeAccess(email: revokeTargetEmail) }
            }
        } message: {
            Text("This immediately signs the person out and removes all unsigned assignments. You can invite them again later.")
        }
    }
}

struct OfficerCard: View {
    let name: String
    let office: String
    let state: OfficerSeatState

    /* Amber for pending. It is neither done nor undone, and the Master has to see the
     * difference or he invites the same man twice. */
    private var dot: Color {
        switch state {
        case .active: return .green
        case .pending: return .orange
        case .none: return .gray.opacity(0.4)
        }
    }

    var body: some View {
        HStack {
            Image(systemName: "person.crop.circle.fill").font(.largeTitle).foregroundStyle(SignTheme.gold)
            VStack(alignment: .leading) {
                Text(name).font(.headline)
                Text("\(office) · \(state.label)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Circle().fill(dot).frame(width: 9)
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.4)) }
    }
}

struct SignatureProfileView: View {
    @EnvironmentObject var model: AppModel
    @State private var showEditor = false
    @State private var image: NSImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            NativeWorkspaceHeader(title: "Signature Profile", subtitle: "Applied only after document review and your consent", symbol: "signature").padding(.horizontal, -22)
            Group {
                if let image { Image(nsImage: image).resizable().scaledToFit().padding(24) }
                else { ContentUnavailableView("No signature saved", systemImage: "signature") }
            }
            .frame(maxWidth: 680, minHeight: 210)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
            .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.5)) }
            Button(model.user?.hasSignature == true ? "Change signature" : "Create signature") {
                showEditor = true
            }
            .buttonStyle(.borderedProminent).tint(.accentColor)
            Spacer()
        }
        .padding(22)
        .background(Color(nsColor: .windowBackgroundColor))
        .task { image = try? await model.signatureImage() }
        .sheet(isPresented: $showEditor, onDismiss: {
            Task { image = try? await model.signatureImage() }
        }) { SignatureSetupView(required: false) }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        Form {
            Section("Shared signing service") {
                #if DEBUG
                TextField("Service address", text: $model.serverAddress)
                #else
                LabeledContent("Service", value: "Stone Square Lodge secure service")
                #endif
                Text("Officer access is securely connected to the approved Lodge service.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Test and refresh") { Task { await model.refresh() } }
            }
            Section("Automatic login") {
                Label("This Mac opens your saved account automatically", systemImage: "desktopcomputer")
                if let session = model.signInSession {
                    Text(session.title).font(.headline)
                    Text(session.explanation).font(.callout)
                }
                Text("Connection interruptions keep your login saved. Signing out, resetting your password, or losing account access ends the saved sign-in.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Service Settings")
    }
}

struct SignatureApprovalView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let document: LodgeDocument
    @State private var consent = false
    @State private var signatureImage: NSImage?
    @State private var showingPDF = false
    @State private var officerProfile: SubmissionProfile?
    @State private var profileError = ""

    private var profileReady: Bool {
        guard document.isDispensation else { return true }
        guard let profile = officerProfile else { return false }
        return !profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !profile.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && profile.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                != profile.address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("ELECTRONIC SIGNATURE")
                .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
            Text("Sign \(document.displayTitle)")
                .font(.title2.weight(.semibold))
                .foregroundStyle(SignTheme.navy)
            Text("Review the PDF before applying your saved signature. The action is added to the document audit history.")
                .foregroundStyle(.secondary)
            Group {
                if let signatureImage {
                    Image(nsImage: signatureImage).resizable().scaledToFit().padding(18)
                } else { ProgressView() }
            }
            .frame(maxWidth: .infinity, minHeight: 170)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(.gray.opacity(0.4)) }
            Toggle(
                "I agree that this electronic signature represents my signature on this document.",
                isOn: $consent
            )
            if document.isDispensation {
                if let officerProfile {
                    Text(officerProfile.name).font(.headline)
                    Text(officerProfile.address)
                    Text("These details fill the secretary section when you sign. Contact the Worshipful Master if a correction is needed.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !profileError.isEmpty { Text(profileError).foregroundStyle(.red) }
            }
            HStack {
                Button("View PDF") { showingPDF = true }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Apply saved signature") {
                    Task { if await model.sign(document: document) { dismiss() } }
                }
                .buttonStyle(.borderedProminent).tint(.accentColor)
                .disabled(!consent || signatureImage == nil || !profileReady || model.isBusy)
            }
        }
        .updateDraftGuard(reason: "Finish or cancel the signature review before updating.")
        .padding(30)
        .frame(minWidth: 520, idealWidth: 760, maxWidth: 760)
        .task {
            signatureImage = try? await model.signatureImage()
            if document.isDispensation {
                do {
                    officerProfile = try await model.signingProfile()
                    if !profileReady { profileError = "Ask the Worshipful Master to save your name and mailing address before signing." }
                } catch { profileError = error.localizedDescription }
            }
        }
        .sheet(isPresented: $showingPDF) { PDFPreviewView(document: document) }
    }
}

struct SignatureSetupView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let required: Bool
    @State private var mode = 1
    @State private var name = ""
    @State private var initials = ""
    @State private var selectedStyle = 0
    @State private var paths: [[CGPoint]] = []
    @State private var currentPath: [CGPoint] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            Text("SIGNATURE PROFILE")
                .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
            Text(required ? "Create your signature to continue" : "Change your saved signature")
                .font(.title2.weight(.semibold))
                .foregroundStyle(SignTheme.navy)
            Text(required
                 ? "Draw your signature, choose a cursive style, or create your initials."
                 : "The new signature will be used on documents you approve after it is saved.")
                .foregroundStyle(.secondary)
            Picker("Signature method", selection: $mode) {
                Text("Draw signature").tag(0)
                Text("Cursive styles").tag(1)
                Text("Initials").tag(2)
            }
            .pickerStyle(.segmented)
            if mode == 0 {
                DrawingPad(paths: $paths, currentPath: $currentPath)
                    .frame(height: 200)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 9))
                    .overlay { RoundedRectangle(cornerRadius: 9).stroke(.gray.opacity(0.5)) }
                Button("Clear drawing") { paths = []; currentPath = [] }
            } else {
                if mode == 2 {
                    Text("Enter your initials, then choose a cursive style below.")
                        .font(.callout).foregroundStyle(.secondary)
                    TextField("Initials as they should appear", text: $initials)
                } else {
                    Text("Type your name, then choose one of the cursive signature styles below.")
                        .font(.callout).foregroundStyle(.secondary)
                    TextField("Name as it should appear", text: $name)
                }
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(typedSignatureStyles.indices, id: \.self) { style in
                            Button {
                                selectedStyle = style
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Image(nsImage: renderTypedSignature(name: signaturePreviewText, style: style))
                                        .resizable().scaledToFit().padding(.horizontal, 7)
                                        .frame(height: 72)
                                    Text(typedSignatureStyles[style].label.uppercased())
                                        .font(.caption2.weight(.bold)).tracking(0.8)
                                        .foregroundStyle(Color.black.opacity(0.65)).padding(.horizontal, 9).padding(.bottom, 7)
                                }
                                    .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 8)
                                            .stroke(selectedStyle == style ? SignTheme.gold : .gray.opacity(0.3), lineWidth: selectedStyle == style ? 2 : 1)
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(height: 370)
            }
            HStack {
                if !required { Button("Cancel") { dismiss() } }
                Spacer()
                Button("Save my signature") { save() }
                    .buttonStyle(.borderedProminent).tint(.accentColor)
                    .disabled(model.isBusy || (mode == 0 ? paths.isEmpty : signatureInput.trimmingCharacters(in: .whitespaces).isEmpty))
            }
        }
        .updateDraftGuard(reason: "Save or cancel the signature setup before updating.")
        .padding(30)
        .frame(minWidth: 520, idealWidth: 780, maxWidth: 780)
        .onAppear {
            if name.isEmpty { name = model.user?.name ?? "" }
            if initials.isEmpty { initials = initialsForName(model.user?.name ?? "") }
        }
    }

    private var signatureInput: String {
        mode == 2 ? initials.uppercased() : name
    }

    private var signaturePreviewText: String {
        if !signatureInput.trimmingCharacters(in: .whitespaces).isEmpty { return signatureInput }
        return mode == 2 ? "WDS" : "Your Name"
    }

    private func initialsForName(_ fullName: String) -> String {
        fullName.split(whereSeparator: { $0.isWhitespace })
            .compactMap(\.first)
            .prefix(4)
            .map(String.init)
            .joined()
            .uppercased()
    }

    private func save() {
        let dataURL: String?
        let type: String
        let style: String
        if mode == 0 {
            dataURL = renderDrawnSignature(paths: paths, size: NSSize(width: 760, height: 200))
            type = "drawn"
            style = "drawn"
        } else {
            dataURL = signatureDataURL(image: renderTypedSignature(name: signatureInput, style: selectedStyle))
            type = mode == 2 ? "initials" : "typed"
            style = mode == 2 ? "initials-\(selectedStyle + 1)" : "cursive-\(selectedStyle + 1)"
        }
        guard let dataURL else { return }
        Task { if await model.saveSignature(dataURL: dataURL, type: type, style: style) { dismiss() } }
    }
}

struct DrawingPad: View {
    @Binding var paths: [[CGPoint]]
    @Binding var currentPath: [CGPoint]
    var body: some View {
        Canvas { context, _ in
            for points in paths + (currentPath.isEmpty ? [] : [currentPath]) {
                guard let first = points.first else { continue }
                var path = Path()
                path.move(to: first)
                points.dropFirst().forEach { path.addLine(to: $0) }
                context.stroke(path, with: .color(SignTheme.navy), lineWidth: 2.5)
            }
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { currentPath.append($0.location) }
                .onEnded { _ in
                    if !currentPath.isEmpty { paths.append(currentPath) }
                    currentPath = []
                }
        )
    }
}

func renderDrawnSignature(paths: [[CGPoint]], size: NSSize) -> String? {
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: size).fill()
    NSColor(calibratedRed: 0.03, green: 0.11, blue: 0.19, alpha: 1).setStroke()
    for points in paths {
        guard let first = points.first else { continue }
        let line = NSBezierPath()
        line.lineWidth = 2.5
        line.lineCapStyle = .round
        line.move(to: NSPoint(x: first.x, y: size.height - first.y))
        for point in points.dropFirst() {
            line.line(to: NSPoint(x: point.x, y: size.height - point.y))
        }
        line.stroke()
    }
    image.unlockFocus()
    return signatureDataURL(image: image)
}

struct TypedSignatureStyle {
    let label: String
    let fontName: String
    let fontSize: CGFloat
}

let typedSignatureStyles = [
    TypedSignatureStyle(label: "Classic Script", fontName: "SnellRoundhand", fontSize: 62),
    TypedSignatureStyle(label: "Bold Script", fontName: "SnellRoundhand-Bold", fontSize: 58),
    TypedSignatureStyle(label: "Formal Chancery", fontName: "Apple-Chancery", fontSize: 53),
    TypedSignatureStyle(label: "Elegant Script", fontName: "SavoyeLetPlain", fontSize: 58),
    TypedSignatureStyle(label: "House Script", fontName: "SignPainter-HouseScriptSemibold", fontSize: 58),
    TypedSignatureStyle(label: "Ornate Pen", fontName: "Zapfino", fontSize: 40),
    TypedSignatureStyle(label: "Personal Note", fontName: "Noteworthy-Light", fontSize: 54),
    TypedSignatureStyle(label: "Natural Hand", fontName: "BradleyHandITCTT-Bold", fontSize: 55),
]

func renderTypedSignature(name: String, style: Int) -> NSImage {
    let size = NSSize(width: 620, height: 145)
    let image = NSImage(size: size)
    image.lockFocus()
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: size).fill()
    let selected = typedSignatureStyles.indices.contains(style) ? typedSignatureStyles[style] : typedSignatureStyles[0]
    let font = NSFont(name: selected.fontName, size: selected.fontSize)
        ?? NSFont.systemFont(ofSize: selected.fontSize, weight: .regular)
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(calibratedRed: 0.03, green: 0.11, blue: 0.19, alpha: 1),
        .paragraphStyle: paragraph,
    ]
    NSString(string: name).draw(in: NSRect(x: 25, y: 37, width: 570, height: 82), withAttributes: attributes)
    image.unlockFocus()
    return image
}

func signatureDataURL(image: NSImage) -> String? {
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
    return "data:image/png;base64,\(png.base64EncodedString())"
}


// MARK: - Dues
// The Mac twin of the web dues page. Same ordering, needs-attention-first, because the
// page exists to show who to call rather than to admire a total.

struct DuesView: View {
    @EnvironmentObject var model: AppModel
    @State private var showingAdjustment = false
    @State private var exporting: DuesExportFormat?
    @State private var exportNotice: String?
    @State private var exportFailed = false

    private enum DuesExportFormat: String {
        case pdf, xlsx

        var label: String { self == .pdf ? "PDF" : "Excel" }
        var contentType: UTType { self == .pdf ? .pdf : (UTType(filenameExtension: "xlsx") ?? .data) }
    }

    private func tint(_ status: String) -> Color {
        switch status {
        case "paid": return .green
        case "partial": return SignTheme.gold
        default: return .red
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                NativeWorkspaceHeader(title: "Dues", subtitle: "Payments, balances and reconciliation", symbol: "dollarsign.circle") {
                    if model.user?.can("dues.manage") == true { Button("Record activity", systemImage: "plus") { showingAdjustment = true } }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.loadDues() } }.disabled(model.duesLoading)
                    Menu {
                        Button("Save PDF", systemImage: "doc.richtext") { Task { await export(.pdf) } }
                        Button("Save Excel", systemImage: "tablecells") { Task { await export(.xlsx) } }
                    } label: { Label("Export", systemImage: "square.and.arrow.down") }
                        .disabled(model.dues == nil || exporting != nil)
                }.padding(.horizontal, -22)
                if let ledger = model.dues { Text("\(ledger.duesYear) dues, \(lodgeMoney(ledger.rateCents)) each, reconciled against both Zeffy campaigns.").font(.callout).foregroundStyle(.secondary) }
                if exporting != nil { ProgressView("Preparing dues snapshot…") }
                if let exportNotice {
                    Text(exportNotice)
                        .foregroundStyle(exportFailed ? .red : .secondary)
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background((exportFailed ? Color.red : Color.primary).opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                if model.duesLoading && model.dues == nil {
                    ProgressView("Reading payments from Zeffy…").frame(maxWidth: .infinity)
                }
                if let error = model.duesError {
                    Text(error).foregroundStyle(.red)
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.red.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 8))
                }

                if let ledger = model.dues {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 14)], spacing: 14) {
                        duesTile("Collected", lodgeMoney(ledger.totals.collectedCents))
                        duesTile("Outstanding", lodgeMoney(ledger.totals.outstandingCents))
                        duesTile("Paid in full", "\(ledger.totals.paidCount)")
                        duesTile("Not yet paid", "\(ledger.totals.unpaidCount)")
                    }

                    if let stale = ledger.staleCampaign {
                        Text("Last year's custom dues campaign is still open and has taken \(stale.count) payment(s) totalling \(lodgeMoney(stale.totalCents)). Those are NOT counted above. Close that campaign in Zeffy.")
                            .font(.callout)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(SignTheme.gold.opacity(0.14))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }

                    Text("BY BROTHER").font(.caption2).tracking(1.4).foregroundStyle(.secondary)
                    VStack(spacing: 8) {
                        ForEach(ledger.rows) { row in
                            HStack(alignment: .top, spacing: 12) {
                                RoundedRectangle(cornerRadius: 2).fill(tint(row.status)).frame(width: 3)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(row.name).font(.callout.weight(.semibold))
                                    Text(detail(for: row)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(row.status.uppercased())
                                    .font(.caption2.weight(.bold)).foregroundStyle(tint(row.status))
                            }
                            .padding(12)
                            .background(Color.primary.opacity(0.04))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }

                    if !ledger.unmatched.isEmpty {
                        Text("COULD NOT BE MATCHED").font(.caption2).tracking(1.4).foregroundStyle(.secondary)
                        Text("These came through Zeffy but matched nobody on the roster. Usually a nickname, a spouse's card, or a Brother missing from the roster.")
                            .font(.caption).foregroundStyle(.secondary)
                        VStack(spacing: 8) {
                            ForEach(ledger.unmatched) { item in
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(item.buyerName.isEmpty ? item.buyerEmail : item.buyerName)
                                            .font(.callout.weight(.semibold))
                                        Text("\(item.dateISO) · \(lodgeMoney(item.amountCents)) · \(item.buyerEmail)")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                }
                                .padding(12)
                                .background(Color.primary.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                }
            }
            .padding(28)
        }
        .task {
            // Zeffy payments arrive from outside the app, so nothing in-app can announce
            // them. Re-read while this screen is on top so the Mac and the web page agree.
            if model.dues == nil { await model.loadDues() }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                if Task.isCancelled { break }
                await model.loadDues()
            }
        }
        .sheet(isPresented: $showingAdjustment) { DuesAdjustmentView(rows: model.dues?.rows ?? []) { await model.loadDues() } }
    }

    @MainActor
    private func export(_ format: DuesExportFormat) async {
        guard exporting == nil, model.dues != nil else { return }
        exporting = format
        exportNotice = nil
        defer { exporting = nil }
        do {
            let workspace = MinutesWorkspace()
            workspace.configure(model)
            let data = try await workspace.request("/api/dues/export.\(format.rawValue)")
            let valid = format == .pdf ? data.starts(with: Data("%PDF-".utf8)) : data.starts(with: [0x50, 0x4b])
            guard valid else { throw ClientError.invalidResponse }

            let stamp = DateFormatter()
            stamp.locale = Locale(identifier: "en_US_POSIX")
            stamp.timeZone = TimeZone(identifier: "America/New_York")
            stamp.dateFormat = "yyyy-MM-dd_HH-mm-ssZ"
            let filename = "Stone-Square-Dues-Snapshot-\(stamp.string(from: Date())).\(format.rawValue)"
            let panel = NSSavePanel()
            panel.allowedContentTypes = [format.contentType]
            panel.nameFieldStringValue = filename
            panel.title = "Save dues snapshot as \(format.label)"
            guard panel.runModal() == .OK, let destination = panel.url else { return }
            try data.write(to: destination, options: .atomic)
            exportFailed = false
            exportNotice = "Saved dues snapshot: \(destination.lastPathComponent)"
        } catch {
            exportFailed = true
            exportNotice = "Could not save the \(format.label) snapshot. \(error.localizedDescription)"
        }
    }

    private func detail(for row: DuesRow) -> String {
        var text: String
        switch row.status {
        case "paid":
            text = "Paid in full" + (row.lastPaymentISO.map { " on \($0)" } ?? "")
        case "partial":
            text = "\(lodgeMoney(row.paidCents)) of \(lodgeMoney(row.assessedCents)), \(lodgeMoney(row.remainingCents)) outstanding"
        default:
            text = "Nothing received"
        }
        if row.creditCents > 0 { text += " · \(lodgeMoney(row.creditCents)) credit" }
        let ways = Set(row.payments.map(\.matchedVia)).sorted()
        if !ways.isEmpty { text += " · matched by " + ways.joined(separator: ", ") }
        return text
    }

    @ViewBuilder
    private func duesTile(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.caption2).tracking(1.2).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}


/* What the District Deputy decided about each dispensation.
 *
 * Deliberately loud about a missing endorsed copy. Neither dispensation the Lodge holds as
 * approved has a single mark in its approval block; both were granted by email over a blank
 * endorsement. Showing them as simply "approved" would let the Lodge believe it holds paper it
 * does not hold. */
struct ApprovalsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                NativeWorkspaceHeader(title: "Approvals", subtitle: "Decisions and endorsed dispensation records", symbol: "checkmark.seal").padding(.horizontal, -22)
                if model.approvalsLoading && model.approvals.isEmpty {
                    ProgressView().frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 40)
                } else if !model.approvalsError.isEmpty {
                    Text(model.approvalsError).foregroundStyle(.red)
                } else if model.approvals.isEmpty {
                    Text("No dispensation has been recorded as decided yet.")
                        .foregroundStyle(.secondary).padding(.vertical, 30)
                } else {
                    VStack(spacing: 0) {
                        ForEach(model.approvals) { item in
                            HStack(alignment: .top, spacing: 14) {
                                Image(systemName: item.isApproved ? "checkmark.seal.fill" : "seal")
                                    .font(.title2)
                                    .foregroundStyle(item.isApproved ? .green : .secondary)
                                    .frame(width: 30)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(item.displayTitle).font(.headline).foregroundStyle(SignTheme.navy)
                                    Text("\(item.approvedBy ?? "Not recorded") · \(item.approvedOn ?? "no date") · \(item.route)")
                                        .font(.caption).foregroundStyle(.secondary)
                                    if item.hasEndorsedCopy != true {
                                        Text("No approval document on file. The approval block on the form is blank.")
                                            .font(.caption2.weight(.semibold)).foregroundStyle(.red)
                                    }
                                    if let note = item.approvalNote, !note.isEmpty {
                                        Text(note).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Text(item.verdict)
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .foregroundStyle(item.isApproved ? .green : SignTheme.navy)
                                    .background((item.isApproved ? Color.green : SignTheme.gold).opacity(0.12), in: Capsule())
                            }
                            .padding(.vertical, 13)
                            if item.id != model.approvals.last?.id { Divider() }
                        }
                    }
                    .padding(20)
                    .background(.background, in: RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator.opacity(0.5)) }
                }
            }
            .padding(22)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await model.loadApprovals() }
    }
}

/* What the Wardens have put up, and the Master ruling on it.
 *
 * Xavier and Jamal work on their phones through the web page, because the Mac build is
 * ad hoc signed and only runs on the machine it was built on. So the proposing side is
 * deliberately web only and this is the deciding side. */
struct ProposalReviewView: View {
    @EnvironmentObject var model: AppModel
    @State private var notes: [String: String] = [:]
    @State private var busyID: String?
    @State private var pendingDecision: PendingDecision?
    @State private var edits: [String: [String: String]] = [:]

    private func editBinding(_ proposal: WardenProposal, _ key: String, _ original: String?) -> Binding<String> {
        Binding(
            get: { edits[proposal.id]?[key] ?? original ?? "" },
            set: { value in var row = edits[proposal.id] ?? [:]; row[key] = value; edits[proposal.id] = row }
        )
    }

    private struct PendingDecision: Identifiable {
        let proposal: WardenProposal
        let decision: String
        var id: String { proposal.id + ":" + decision }
        var title: String {
            switch decision {
            case "approve": return "Approve this dispensation proposal?"
            case "changes": return "Send this proposal back for changes?"
            default: return "Decline this dispensation proposal?"
            }
        }
        var button: String {
            switch decision {
            case "approve": return "Approve proposal"
            case "changes": return "Send back"
            default: return "Decline proposal"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                NativeWorkspaceHeader(title: "Warden Proposals", subtitle: "Review proposals and respond to the preparing Warden", symbol: "square.and.pencil").padding(.horizontal, -22)
                if model.proposalsLoading && model.proposals.isEmpty {
                    ProgressView().frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 40)
                } else if !model.proposalsError.isEmpty {
                    Text(model.proposalsError).foregroundStyle(.red)
                } else if model.proposals.isEmpty {
                    Text("No Warden has proposed a dispensation yet.")
                        .foregroundStyle(.secondary).padding(.vertical, 20)
                } else {
                    ForEach(model.proposals) { proposal in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(proposal.displayTitle)
                                    .font(.headline).foregroundStyle(SignTheme.navy)
                                Spacer()
                                Text(proposal.verdict)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(proposal.isPending ? SignTheme.gold : .secondary)
                            }
                            Text("Proposed by \(proposal.proposerName)")
                                .font(.subheadline).foregroundStyle(.secondary)
                            if let date = proposal.eventDate, !date.isEmpty {
                                Text("Event date: \(LodgeCalendarDates.displayDate(date))\(proposal.eventTime.map { $0.isEmpty ? "" : ", \(LodgeCalendarDates.displayTime($0))" } ?? "")")
                                    .font(.subheadline)
                            }
                            if let place = proposal.locationName, !place.isEmpty {
                                Text(place).font(.subheadline).foregroundStyle(.secondary)
                            }
                            if let details = proposal.requestDetails, !details.isEmpty {
                                Text(details).font(.body).padding(.top, 2)
                            }
                            if let his = proposal.proposerNote, !his.isEmpty {
                                Text("His note: \(his)")
                                    .font(.callout).foregroundStyle(.secondary)
                                    .padding(8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(SignTheme.navy.opacity(0.05))
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            if proposal.isPending {
                                Group {
                                    TextField("What it is", text: editBinding(proposal, "title", proposal.title))
                                    TextField("What is being asked", text: editBinding(proposal, "requestDetails", proposal.requestDetails), axis: .vertical).lineLimit(3...8)
                                    TextField("Event date, YYYY-MM-DD", text: editBinding(proposal, "eventDate", proposal.eventDate))
                                    TextField("Time", text: editBinding(proposal, "eventTime", proposal.eventTime))
                                    TextField("Location", text: editBinding(proposal, "locationName", proposal.locationName))
                                    TextField("Street", text: editBinding(proposal, "streetAddress", proposal.streetAddress))
                                    TextField("City, state, and ZIP", text: editBinding(proposal, "cityState", proposal.cityState))
                                }
                                .textFieldStyle(.roundedBorder)
                                TextField("A note back to him, optional", text: Binding(
                                    get: { notes[proposal.id] ?? "" },
                                    set: { notes[proposal.id] = $0 }
                                ))
                                    .textFieldStyle(.roundedBorder).padding(.top, 4)
                                HStack(spacing: 10) {
                                    Button("Approve") { pendingDecision = PendingDecision(proposal: proposal, decision: "approve") }
                                        .buttonStyle(.borderedProminent)
                                    Button("Send back") { pendingDecision = PendingDecision(proposal: proposal, decision: "changes") }
                                    Button("Decline") { pendingDecision = PendingDecision(proposal: proposal, decision: "decline") }
                                    if busyID == proposal.id { ProgressView().controlSize(.small) }
                                }
                                .disabled(busyID != nil)
                                Text("Your edits above become the wording on the dispensation when you approve it.")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else if let wm = proposal.wmNote, !wm.isEmpty {
                                Text("Your note: \(wm)").font(.callout).foregroundStyle(.secondary)
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(nsColor: .controlBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            .padding(30)
        }
        .updateDraftGuard(active: notes.values.contains(where: { !$0.isEmpty }) || busyID != nil, reason: "Finish or clear your proposal note before updating.")
        .task { await model.loadProposals() }
        .alert(item: $pendingDecision) { pending in
            Alert(
                title: Text(pending.title),
                message: Text("This records your decision and notifies the proposing officer.\((notes[pending.proposal.id] ?? "").isEmpty ? "" : " Your note will be included.")"),
                primaryButton: .default(Text(pending.button)) { decide(pending.proposal, pending.decision) },
                secondaryButton: .cancel()
            )
        }
    }

    private func decide(_ proposal: WardenProposal, _ decision: String) {
        busyID = proposal.id
        let text = notes[proposal.id] ?? ""
        Task {
            let defaults = [
                "requestDate": proposal.requestDate ?? "", "eventDate": proposal.eventDate ?? "",
                "requestDetails": proposal.requestDetails ?? "", "eventTime": proposal.eventTime ?? "",
                "locationName": proposal.locationName ?? "", "streetAddress": proposal.streetAddress ?? "",
                "cityState": proposal.cityState ?? "", "title": proposal.title ?? "",
            ]
            if await model.decideProposal(id: proposal.id, decision: decision, wmNote: text, editedFields: defaults.merging(edits[proposal.id] ?? [:]) { _, edited in edited }) {
                notes[proposal.id] = nil; edits[proposal.id] = nil
            }
            busyID = nil
        }
    }
}

// MARK: - Personal dues and confidential suggestions

struct MyDuesView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                NativeWorkspaceHeader(title: "My Dues", subtitle: "Your private balance and payment options", symbol: "dollarsign.circle") {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.loadMyDues() } }
                }.padding(.horizontal, -22)
                if let error = model.myDuesError { Text(error).foregroundStyle(.red).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color.red.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 8)) }
                if let record = model.myDues {
                    Text(record.duesYear).font(.headline)
                    ViewThatFits(in: .horizontal) {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 12)], spacing: 12) { tile("Assessment", lodgeMoney(record.row.assessedCents)); tile("Received", lodgeMoney(record.row.paidCents)); tile("Balance", record.row.creditCents > 0 ? "\(lodgeMoney(record.row.creditCents)) credit" : lodgeMoney(record.row.remainingCents)); tile("Status", status(record.row.status)) }
                        VStack(spacing: 12) { tile("Assessment", lodgeMoney(record.row.assessedCents)); tile("Received", lodgeMoney(record.row.paidCents)); tile("Balance", record.row.creditCents > 0 ? "\(lodgeMoney(record.row.creditCents)) credit" : lodgeMoney(record.row.remainingCents)); tile("Status", status(record.row.status)) }
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack { paymentLinks(record) }
                        VStack(alignment: .leading) { paymentLinks(record) }
                    }
                    Text("PAYMENT HISTORY").font(.caption2).tracking(1.3).foregroundStyle(.secondary).padding(.top, 8)
                    if record.row.payments.isEmpty { Text("No payments have been recorded for this dues year.").foregroundStyle(.secondary) }
                    ForEach(Array(record.row.payments.enumerated()), id: \.offset) { _, payment in
                        HStack { VStack(alignment: .leading) { Text(payment.campaign == "annual" ? "Full dues payment" : payment.campaign == "custom" ? "Custom dues payment" : "Lodge entry").fontWeight(.semibold); Text("\(payment.dateISO) · \(lodgeMoney(payment.amountCents))").font(.caption).foregroundStyle(.secondary) }; Spacer() }.padding(12).background(Color.primary.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                } else if model.myDuesError == nil { ProgressView("Reading your private dues record…").frame(maxWidth: .infinity) }
            }.padding(28)
        }.task { await model.loadMyDues() }
    }
    @ViewBuilder private func paymentLinks(_ record: MyDuesResponse) -> some View {
        if let full=URL(string: record.paymentLinks.full) { Link("Pay full dues", destination: full).buttonStyle(.borderedProminent) }
        if let custom=URL(string: record.paymentLinks.custom) { Link("Pay a custom amount", destination: custom).buttonStyle(.bordered) }
    }
    private func status(_ value:String)->String { value == "paid" ? "Paid in full" : value == "partial" ? "Partially paid" : "Payment due" }
    private func tile(_ label:String,_ value:String)->some View { VStack(alignment:.leading,spacing:4){Text(label.uppercased()).font(.caption2).foregroundStyle(.secondary);Text(value).font(.title3.weight(.semibold)).fixedSize(horizontal:false,vertical:true)}.padding(14).frame(maxWidth:.infinity,alignment:.leading).background(Color.primary.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius:10)) }
}

private struct SuggestionDraft: Encodable { let category:String; let subject:String; let body:String }

struct SuggestionBoxView: View {
    @EnvironmentObject var model: AppModel
    @State private var category="General Lodge suggestion"
    @State private var subject=""
    @State private var bodyText=""
    @State private var receipts:[SuggestionReceipt]=[]
    @State private var ownerSuggestions:[OwnerSuggestion]=[]
    @State private var message=""
    @State private var working=false
    private let categories=["General Lodge suggestion","Event or program","Member experience","Building or property","Community service"]
    var body: some View {
        ScrollView { VStack(alignment:.leading,spacing:18){
            NativeWorkspaceHeader(title:"Suggestion Box",subtitle:"Confidential to WM Dixon-Saunders",symbol:"text.bubble.fill").padding(.horizontal,-22)
            Text("Your suggestion and its assessment are visible only to WM Dixon-Saunders.").foregroundStyle(.secondary)
            GroupBox { VStack(alignment:.leading,spacing:12){ Picker("Category",selection:$category){ForEach(categories,id:\.self){Text($0)}};TextField("Subject",text:$subject);TextEditor(text:$bodyText).frame(minHeight:140).overlay(RoundedRectangle(cornerRadius:6).stroke(Color.secondary.opacity(0.25)));HStack{Text(message).font(.caption).foregroundStyle(message.hasPrefix("Received") ? .green : .secondary);Spacer();Button("Send confidential suggestion"){Task{await submit()}}.buttonStyle(.borderedProminent).disabled(working||subject.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty||bodyText.trimmingCharacters(in:.whitespacesAndNewlines).count<10)}}.padding(8) }
            Text("YOUR RECEIPTS").font(.caption2).tracking(1.3).foregroundStyle(.secondary)
            if receipts.isEmpty { Text("No suggestions submitted yet.").foregroundStyle(.secondary) }
            ForEach(receipts){item in VStack(alignment:.leading,spacing:5){HStack{Text(item.subject).fontWeight(.semibold);Spacer();Text(item.status).font(.caption.weight(.semibold)).foregroundStyle(SignTheme.gold)};Text("\(item.referenceCode) · \(item.category)").font(.caption).foregroundStyle(.secondary);if let response=item.ownerResponse,!response.isEmpty{Text(response).padding(.top,4)}}.padding(14).frame(maxWidth:.infinity,alignment:.leading).background(Color.primary.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius:10)) }
            if model.user?.role == "owner" { Text("WORSHIPFUL MASTER ONLY").font(.caption2).tracking(1.3).foregroundStyle(.secondary).padding(.top,12);ForEach(ownerSuggestions){item in OwnerSuggestionCard(item:item){await load()} } }
        }.padding(28)}.task{await load()}
    }
    @MainActor private func load() async { do{let result:SuggestionsResponse=try await model.request("/api/suggestions/me");receipts=result.suggestions;if model.user?.role=="owner"{let all:OwnerSuggestionsResponse=try await model.request("/api/admin/suggestions");ownerSuggestions=all.suggestions}}catch{message=error.localizedDescription} }
    @MainActor private func submit() async { working=true;defer{working=false};do{let data=try JSONEncoder().encode(SuggestionDraft(category:category,subject:subject,body:bodyText));let result:SuggestionSubmitResponse=try await model.request("/api/suggestions",method:"POST",body:data);message="\(result.message) Reference \(result.reference).";subject="";bodyText="";await load()}catch{message=error.localizedDescription} }
}

private struct SuggestionAssessmentDraft: Encodable { let status:String; let response:String }
struct OwnerSuggestionCard: View {
    @EnvironmentObject var model:AppModel
    let item:OwnerSuggestion
    let saved:() async -> Void
    @State private var status:String
    @State private var response:String
    @State private var working=false
    init(item:OwnerSuggestion,saved:@escaping() async->Void){self.item=item;self.saved=saved;_status=State(initialValue:item.status);_response=State(initialValue:item.ownerResponse ?? "")}
    var body:some View{VStack(alignment:.leading,spacing:8){HStack{Text(item.subject).fontWeight(.semibold);Spacer();Text(item.submittedBy).foregroundStyle(.secondary)};Text(item.body);HStack{Picker("Status",selection:$status){ForEach(["Received","Under Review","Responded","Closed"],id:\.self){Text($0)}}.labelsHidden();TextField("Private response",text:$response);Button("Save assessment"){Task{await save()}}.disabled(working)}}.padding(14).background(Color.primary.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius:10))}
    @MainActor private func save()async{working=true;defer{working=false};do{let data=try JSONEncoder().encode(SuggestionAssessmentDraft(status:status,response:response));let _:MessageResponse=try await model.request("/api/admin/suggestions/\(item.id)",method:"PATCH",body:data);await saved()}catch{}}
}

private struct DuesAdjustmentDraft: Encodable {
    let rosterId:Int; let transactionType:String; let amount:String; let effectiveDate:String; let paymentMethod:String; let sourceReference:String; let note:String
}
private struct DuesAssistRequest: Encodable { let text: String }
private struct DuesAssistResponse: Decodable { let proposal: DuesAssistProposal; let saved: Bool }
private struct DuesAssistProposal: Decodable {
    let brotherName: String
    let rosterId: Int?
    let rosterName: String?
    let amount: String
    let effectiveDate: String
    let paymentMethod: String
    let sourceReference: String
    let note: String
    let currentBalanceCents: Int?
    let projectedBalanceCents: Int?
    let warnings: [String]
}

struct DuesAdjustmentView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let rows:[DuesRow]
    let saved:() async -> Void
    @State private var rosterId:Int?
    @State private var type="payment"
    @State private var amount=""
    @State private var date=Date()
    @State private var method=""
    @State private var reference=""
    @State private var note=""
    @State private var message=""
    @State private var working=false
    @State private var assistText=""
    @State private var assistWarnings:[String]=[]
    @State private var assistReady=false
    @State private var assisting=false
    @State private var assistMessage=""
    @State private var dateConfirmed=true
    private var selectedRow:DuesRow? { rows.first { $0.rosterId == rosterId } }
    private var projectedBalance:Int? {
        guard let row=selectedRow, let dollars=Double(amount), dollars > 0 else { return nil }
        let direction = ["refund","chargeback"].contains(type) ? -1 : 1
        return max(0,row.assessedCents-row.paidCents-direction*Int((dollars*100).rounded()))
    }
    var body: some View { VStack(alignment:.leading,spacing:12){
        HStack{VStack(alignment:.leading){Text("Record non-Zeffy dues activity").font(.title2.weight(.semibold));Text("Review the details before recording a payment.").foregroundStyle(.secondary)};Spacer();Button("Cancel"){dismiss()}}
        ScrollView { VStack(alignment:.leading,spacing:14){
            VStack(alignment:.leading,spacing:8){
                Text("Describe one manual payment").font(.headline)
                Text("For example: Bro. James Smith paid $175 by check 1042 today.").font(.caption).foregroundStyle(.secondary)
                TextEditor(text:$assistText).frame(minHeight:76).padding(5).background(Color.primary.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius:8))
                HStack{Button("Prepare payment details"){Task{await prepare()}}.disabled(assisting || assistText.trimmingCharacters(in:.whitespacesAndNewlines).count < 12);if assisting{ProgressView()};Text(assistMessage).font(.caption).foregroundStyle(.secondary)}
            }.padding(14).background(SignTheme.gold.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius:12))
            if assistReady {
                VStack(alignment:.leading,spacing:6){
                    Text("Review before recording").font(.headline)
                    Text("\(selectedRow?.name ?? "Select the Brother") · \(amount.isEmpty ? "Confirm amount" : "$\(amount)") · \(dateConfirmed ? date.formatted(date:.abbreviated,time:.omitted) : "Confirm date") · \(method.isEmpty ? "Choose method" : method)")
                    if let row=selectedRow,let projectedBalance { Text("Current balance \(lodgeMoney(row.remainingCents)) → projected balance \(lodgeMoney(projectedBalance))") }
                    ForEach(assistWarnings,id:\.self){ Text("• \($0)").font(.caption).foregroundStyle(.secondary) }
                }.padding(14).frame(maxWidth:.infinity,alignment:.leading).background(Color.primary.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius:10))
            }
            Form {
                Picker("Brother",selection:$rosterId){Text("Choose a Brother").tag(Int?.none);ForEach(rows.sorted{$0.name<$1.name}){row in if let id=row.rosterId{Text(row.name).tag(Int?.some(id))}}}
                Picker("Type",selection:$type){ForEach(["payment","credit","refund","chargeback","correction"],id:\.self){Text($0.capitalized)}}
                TextField("Amount",text:$amount)
                DatePicker("Date",selection:$date,displayedComponents:.date).onChange(of:date){_,_ in dateConfirmed=true}
                if !dateConfirmed { Button("Confirm the displayed date") { dateConfirmed=true } }
                Picker("Method",selection:$method){Text("Choose a method").tag("");ForEach(["Cash","Check","Money order","Bank transfer","Other"],id:\.self){Text($0)}}
                TextField("Reference",text:$reference)
                TextField("Note",text:$note,axis:.vertical).lineLimit(2...5)
            }.frame(minHeight:300)
        }}
        if !message.isEmpty { Text(message).font(.caption).foregroundStyle(.red) }
        HStack{Spacer();Button("Confirm and record activity"){Task{await save()}}.buttonStyle(.borderedProminent).disabled(working || rosterId == nil || Double(amount) == nil || method.isEmpty || !dateConfirmed)}
    }.padding(24).frame(minWidth:520,idealWidth:650,minHeight:580,idealHeight:680) }
    @MainActor private func prepare() async {
        assisting=true;defer{assisting=false};assistReady=false;assistMessage="Reading the payment note…"
        do {
            let data=try JSONEncoder().encode(DuesAssistRequest(text:assistText))
            let response:DuesAssistResponse=try await model.request("/api/dues/manual-assist",method:"POST",body:data)
            let proposal=response.proposal
            rosterId=proposal.rosterId;type="payment";amount=proposal.amount;method=proposal.paymentMethod;reference=proposal.sourceReference;note=proposal.note
            dateConfirmed=false
            if !proposal.effectiveDate.isEmpty {
                let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.dateFormat="yyyy-MM-dd"
                if let parsed=formatter.date(from:proposal.effectiveDate){date=parsed;dateConfirmed=true}
            }
            assistWarnings=proposal.warnings;assistReady=true;assistMessage="Check the fields and confirm when correct."
        } catch { assistMessage=error.localizedDescription }
    }
    @MainActor private func save() async { guard let rosterId else{return};working=true;defer{working=false};let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.dateFormat="yyyy-MM-dd";do{let data=try JSONEncoder().encode(DuesAdjustmentDraft(rosterId:rosterId,transactionType:type,amount:amount,effectiveDate:formatter.string(from:date),paymentMethod:method,sourceReference:reference,note:note));let _:MessageResponse=try await model.request("/api/dues/adjustments",method:"POST",body:data);await saved();dismiss()}catch{message=error.localizedDescription}}
}

private struct MemberInviteDraft:Encodable{let email:String;let sendEmail:Bool}
struct MemberAccessView:View{
    @EnvironmentObject var model:AppModel
    @State private var members:[MemberAccessRecord]=[]
    @State private var message=""
    var body:some View{ScrollView{VStack(alignment:.leading,spacing:16){NativeWorkspaceHeader(title:"Member Access",subtitle:"Roster-linked Brother accounts",symbol:"person.3.fill"){Button("Refresh",systemImage:"arrow.clockwise"){Task{await load()}}}.padding(.horizontal,-22);Text(message).font(.caption).foregroundStyle(.secondary);ForEach(members){member in HStack{VStack(alignment:.leading,spacing:3){Text(member.displayName).fontWeight(.semibold);Text(member.userId != nil ? "Active account · \(member.accountEmail ?? "")" : member.invitationId != nil ? "Invitation pending · \(member.invitationEmail ?? "")" : member.emails.isEmpty ? "Email review needed" : member.emails.joined(separator:", ")).font(.caption).foregroundStyle(.secondary)};Spacer();if member.userId==nil && member.invitationId==nil && !member.emails.isEmpty{Button("Create invitation"){Task{await invite(member)}}}}.padding(14).background(Color.primary.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius:10))}}.padding(28)}.task{await load()}}
    @MainActor private func load()async{do{let result:MemberAccessResponse=try await model.request("/api/admin/member-access");members=result.members;message="\(members.count) roster records checked. Invitations are not emailed until you distribute them."}catch{message=error.localizedDescription}}
    @MainActor private func invite(_ member:MemberAccessRecord)async{guard let email=member.emails.first else{return};do{let data=try JSONEncoder().encode(MemberInviteDraft(email:email,sendEmail:false));let result:InviteResponse=try await model.request("/api/admin/member-access/\(member.id)/invite",method:"POST",body:data);NSPasteboard.general.clearContents();NSPasteboard.general.setString(result.inviteUrl,forType:.string);message="Invitation created for \(member.displayName). The private link was copied.";await load()}catch{message=error.localizedDescription}}
}
