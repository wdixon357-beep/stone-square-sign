import AppKit
import SwiftUI
import PDFKit
import UniformTypeIdentifiers

enum SignTheme {
    static let navy = Color(nsColor: .labelColor)
    static let blue = Color.accentColor
    static let gold = Color(red: 0.79, green: 0.61, blue: 0.29)
    static let ivory = Color(nsColor: .windowBackgroundColor)
    static let brandNavy = Color(red: 0.063, green: 0.231, blue: 0.357)
    static let sidebarInk = Color(red: 0.96, green: 0.98, blue: 0.99)
    static let page = adaptive(light: NSColor(red: 0.949, green: 0.961, blue: 0.965, alpha: 1),
                               dark: NSColor(red: 0.078, green: 0.137, blue: 0.200, alpha: 1))
    static let surface = adaptive(light: .white,
                                  dark: NSColor(red: 0.125, green: 0.196, blue: 0.271, alpha: 1))
    static let cardLine = adaptive(light: NSColor(red: 0.85, green: 0.88, blue: 0.90, alpha: 1),
                                   dark: NSColor(red: 0.26, green: 0.33, blue: 0.40, alpha: 1))

    private static func adaptive(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        })
    }
}

private enum GrandViewPortal {
    static let url = URL(string: "https://phde.grandview.systems/users/sign_in")!
}

struct NativeWorkspaceHeader<Actions: View>: View {
    let title: String
    let subtitle: String
    let symbol: String
    @ViewBuilder var actions: Actions
    init(title: String, subtitle: String, symbol: String, @ViewBuilder actions: () -> Actions) {
        self.title = title; self.subtitle = subtitle; self.symbol = symbol; self.actions = actions()
    }
    private var eyebrow: String {
        switch title {
        case "Dues Ledger": return "LODGE DUES RECORD"
        case "My Dues": return "YOUR DUES"
        default: return "STONE SQUARE LODGE NO. 22"
        }
    }
    private var heading: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(eyebrow)
                .font(.system(size: 10, weight: .bold))
                .tracking(1.5)
                .foregroundStyle(SignTheme.gold)
            Text(title)
                .font(.system(size: 34, weight: .medium, design: .serif))
                .foregroundStyle(Color(red: 0.33, green: 0.44, blue: 0.53))
                .fixedSize(horizontal: false, vertical: true)
            Text(subtitle)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
    var body: some View {
        ViewThatFits(in: .horizontal) {
              HStack(alignment: .center, spacing: 14) {
                heading
                Spacer()
                HStack(spacing: 8) { actions }.fixedSize(horizontal: true, vertical: false)
              }
              VStack(alignment: .leading, spacing: 14) {
                heading
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) { actions }
                        .fixedSize(horizontal: true, vertical: false)
                }
              }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SignTheme.page)
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
        GeometryReader { available in
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Text("22")
                        .font(.system(size: 18, weight: .bold, design: .serif))
                        .foregroundStyle(SignTheme.gold)
                        .frame(width: 46, height: 46)
                        .overlay(Circle().stroke(SignTheme.gold))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("STONE SQUARE").font(.system(size: 14, weight: .bold)).tracking(1)
                        Text("LODGE DASHBOARD").font(.system(size: 9)).tracking(1.5)
                    }
                    .foregroundStyle(SignTheme.brandNavy)
                    Spacer()
                    Label("Private Lodge records", systemImage: "circle.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(SignTheme.brandNavy)
                }
                .padding(.horizontal, 24)
                .frame(height: 72)

                HStack(spacing: 0) {
                    if available.size.width >= 900 { authStory.frame(maxWidth: .infinity, maxHeight: .infinity) }
                    ScrollView {
                        authForm
                            .frame(maxWidth: 470)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 30)
                            .padding(.vertical, 40)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.white)
                }
                .background(.white)
                .clipShape(RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(SignTheme.cardLine))
            }
            .padding(22)
            .frame(width: available.size.width, height: available.size.height)
        }
        .background(Color(red: 0.96, green: 0.94, blue: 0.90))
        .environment(\.colorScheme, .light)
        .task { await model.loadServiceSetup() }
    }

    private var authStory: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PRIVATE LODGE DASHBOARD")
                .font(.system(size: 10, weight: .bold))
                .tracking(2)
                .foregroundStyle(SignTheme.gold)
                .padding(.bottom, 12)
            Text("Stone Square")
                .font(.system(size: 60, weight: .medium, design: .serif))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text("Lodge Dashboard")
                .font(.system(size: 56, weight: .medium, design: .serif))
                .foregroundStyle(Color(red: 0.92, green: 0.84, blue: 0.68))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.bottom, 24)
            Text("Read Lodge records, prepare reports, review your dues, and use the private tools available to your account.")
                .font(.system(size: 17))
                .foregroundStyle(.white.opacity(0.75))
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 25)
            HStack(alignment: .top, spacing: 20) {
                authStep("01", "Document uploaded")
                authStep("02", "Officers identified")
                authStep("03", "Signed copies delivered")
            }
        }
        .padding(60)
        .background(LinearGradient(
            colors: [Color(red: 0.027, green: 0.106, blue: 0.184), Color(red: 0.051, green: 0.204, blue: 0.341)],
            startPoint: .topLeading, endPoint: .bottomTrailing))
    }

    private func authStep(_ number: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Rectangle().fill(.white.opacity(0.2)).frame(height: 1)
            Text(number).font(.system(size: 14, design: .serif)).foregroundStyle(SignTheme.gold)
            Text(label).font(.system(size: 11)).foregroundStyle(.white.opacity(0.65))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var authForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 0) {
                authTab("Sign In", mode: 0)
                authTab("Owner Setup", mode: 1)
                authTab("Reset", mode: 2)
            }
            .padding(.bottom, 28)
            Text(mode == 2 ? "ACCOUNT RECOVERY" : mode == 1 ? "PRIVATE LODGE DASHBOARD" : "WELCOME BACK")
                .font(.system(size: 10, weight: .bold))
                .tracking(2)
                .foregroundStyle(Color(red: 0.50, green: 0.34, blue: 0.07))
            Text(mode == 2 ? "Reset your password" : mode == 1 ? "Create owner account" : "Sign in to continue")
                .font(.system(size: 31, weight: .medium, design: .serif))
                .foregroundStyle(SignTheme.brandNavy)
                .padding(.bottom, 18)
            if mode == 1 {
                authLabel("Full Name")
                authTextField(TextField("Full name", text: $name).textContentType(.name))
            }
            authLabel("Email Address")
            authTextField(TextField("name@example.com", text: $email).textContentType(.emailAddress))
            if mode == 2 {
                Button("Send A Six-Digit Code") { Task { await model.requestReset(email: email) } }
                    .disabled(model.emailDeliveryReady == false || model.isBusy)
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(SignTheme.brandNavy)
                if model.emailDeliveryReady == false {
                    Text("Email recovery is temporarily unavailable. Ask the Worshipful Master to reset your account access.")
                        .font(.system(size: 12)).foregroundStyle(.orange)
                }
                authLabel("Reset Code")
                authTextField(TextField("Six digit code", text: $code))
            }
            authLabel(mode == 2 ? "New Password" : mode == 1 ? "Create Password" : "Password")
            authTextField(SecureField(mode == 2 ? "New password" : mode == 1 ? "Create password" : "Your password", text: $password))
            Button(buttonTitle, action: submit)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .background(SignTheme.brandNavy, in: RoundedRectangle(cornerRadius: 8))
                .keyboardShortcut(.defaultAction)
                .padding(.top, 13)
                .disabled(model.isBusy)
            if mode == 0 && model.biometricLoginEnabled {
                Button("Sign in with Touch ID", systemImage: "touchid") { Task { await model.signInWithBiometrics() } }
                    .disabled(model.isBusy)
            }
            if model.isBusy { ProgressView().controlSize(.small) }
            #if DEBUG
            DisclosureGroup("Debug connection settings") {
                TextField("Signing service address", text: $model.serverAddress)
                Text("Release builds always use the approved Lodge service.").font(.caption).foregroundStyle(.secondary)
            }
            #endif
        }
    }

    private func authTab(_ title: String, mode tab: Int) -> some View {
        Button { mode = tab } label: {
            Text(title)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(mode == tab ? SignTheme.brandNavy : Color.gray)
                .frame(maxWidth: .infinity)
                .frame(height: 45)
                .overlay(alignment: .bottom) { if mode == tab { SignTheme.gold.frame(height: 2) } }
        }
        .buttonStyle(.plain)
    }

    private func authLabel(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .bold))
            .tracking(0.4)
            .foregroundStyle(Color(red: 0.09, green: 0.14, blue: 0.20))
    }

    private func authTextField<Field: View>(_ field: Field) -> some View {
        field
            .textFieldStyle(.plain)
            .font(.system(size: 14))
            .padding(.horizontal, 14)
            .frame(height: 46)
            .background(.white, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var selection: AppSection? = .home
    @State private var toolSearch = ""
    @State private var meetingsExpanded = false
    @State private var documentsExpanded = false
    @State private var financeExpanded = false
    @State private var peopleExpanded = false
    @State private var accountExpanded = false
    @State private var alertsExpanded = false
    @State private var startExpanded = true
    @State private var compactNavigationOpen = false
    @State private var groupLanding: String?
    @State private var updateGuardID = UUID()
    @StateObject private var reportBrowser = ReportBrowserModel()
    @StateObject private var minutesWorkspace = MinutesWorkspace()
    @StateObject private var treasuryWorkspace = TreasuryWorkspace()
    @StateObject private var agendaWorkspace = AgendaWorkspace()
    @StateObject private var correspondenceWorkspace = CorrespondenceWorkspace()
    @StateObject private var activityPresence = ActivityPresence()

    var body: some View {
        GeometryReader { window in
            HStack(spacing: 0) {
                if window.size.width >= 1100 {
                    sidebar.frame(width: 260)
                }
                VStack(spacing: 0) {
                    if window.size.width < 1100 {
                        compactHeader
                    }
                    GeometryReader { available in
                        VStack(spacing: 0) {
                            if selection != .home && selection != .mySettings {
                                standardHeader
                            }
                            WorkspaceNotices(correspondenceCount: correspondenceWorkspace.lettersForMySignature.count,
                                             openCorrespondence: { selection = .correspondence })
                            if alertCount > 0 {
                                VStack(spacing: 0) {
                                    Button {
                                        alertsExpanded.toggle()
                                    } label: {
                                        HStack {
                                            Text("Needs Attention (\(alertCount))")
                                                .font(.system(size: 14, weight: .semibold))
                                            Spacer()
                                            Text(alertsExpanded ? "Hide" : "Show")
                                                .font(.system(size: 12))
                                            Image(systemName: alertsExpanded ? "chevron.up" : "chevron.down")
                                                .font(.system(size: 11))
                                        }
                                        .foregroundStyle(SignTheme.brandNavy)
                                        .padding(.horizontal, 22)
                                        .frame(height: 44)
                                    }
                                    .buttonStyle(.plain)
                                    if alertsExpanded {
                                        ScrollView {
                                            VStack(alignment: .leading, spacing: 4) {
                                                minutesReviewAlertButtons
                                                treasuryAlertButtons
                                                buildingAlertButtons
                                            }
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                        }
                                        .frame(maxHeight: 210)
                                    }
                                }
                                .background(SignTheme.surface)
                                .overlay(alignment: .bottom) { SignTheme.cardLine.frame(height: 1) }
                            }
                            workspaceContent
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .transition(reduceMotion ? .identity : .opacity)
                        }
                        .frame(width: available.size.width, height: available.size.height, alignment: .topLeading)
                        .clipped()
                        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: selection)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(SignTheme.page)
        }
        .task {
            activityPresence.start(model)
            correspondenceWorkspace.configure(model)
            await model.refresh()
        }
        .onAppear {
            AppUpdater.shared.setWorkspaceGuard(updateGuardID) {
                AppUpdater.unfinishedReportWork(report: reportBrowser, minutes: minutesWorkspace, treasury: treasuryWorkspace, agenda: agendaWorkspace, operationInProgress: model.isBusy)
            }
        }
        .onDisappear { activityPresence.stop(); AppUpdater.shared.setWorkspaceGuard(updateGuardID, check: nil) }
        .onChange(of:selection){_,section in
            activityPresence.visit(section)
            alertsExpanded = false
            startExpanded = false
            meetingsExpanded = false
            documentsExpanded = false
            financeExpanded = false
            peopleExpanded = false
            accountExpanded = false
            switch section {
            case .home:
                startExpanded = groupLanding == nil
                if let groupLanding {
                    meetingsExpanded = groupLanding == "Meetings And Reports"
                    documentsExpanded = groupLanding == "Documents And Approvals"
                    financeExpanded = groupLanding == "Dues And Finance"
                    peopleExpanded = groupLanding == "People And Lodge"
                    accountExpanded = groupLanding == "Account"
                }
            case .lodgeCalendar, .agenda, .minutes, .reportGenerator, .receivedReports:
                meetingsExpanded = true
            case .correspondence, .documents, .approvals, .createDispensation, .proposalReview:
                documentsExpanded = true
            case .myDues, .dues, .treasury:
                financeExpanded = true
            case .building, .candidateTracker, .access, .memberAccess, .suggestions:
                peopleExpanded = true
            case .activity, .profile, .settings, .mySettings:
                accountExpanded = true
            default: break
            }
        }
        .onChange(of: model.correspondenceRecordsRevision) { _, _ in
            guard model.user?.canPrepareCorrespondence == true else { return }
            Task {
                correspondenceWorkspace.configure(model)
                await correspondenceWorkspace.refresh()
            }
        }
        .onChange(of: model.requestedSection) { _, requested in
            guard let requested else { return }
            selection = requested
            model.requestedSection = nil
        }
    }

    private var standardHeader: some View {
        HStack {
            Text(sectionHeaderTitle)
                .font(.system(size: 30, weight: .medium, design: .serif))
                .foregroundStyle(SignTheme.brandNavy)
            Spacer()
            Text("Stone Square Lodge No. 22")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 38)
        .frame(height: 72)
        .background(.white)
        .overlay(alignment: .bottom) { SignTheme.cardLine.frame(height: 1) }
    }

    private var sectionHeaderTitle: String {
        switch selection {
        case .building: return "Building Requests"
        case .lodgeCalendar: return "Lodge Calendar"
        case .reportGenerator: return "Report Generator"
        case .correspondence: return "Lodge Correspondence"
        case .receivedReports: return "Received Reports"
        case .minutes: return "Meeting Minutes"
        case .agenda: return "Agenda Creator"
        case .treasury: return "Treasurer Reports"
        case .candidateTracker: return "Candidate Tracker"
        case .createDispensation: return "Create Dispensation"
        case .access: return "Officer Access"
        case .memberAccess: return "Member Access"
        case .activity: return "Dashboard Activity"
        case .dues: return "Dues Ledger"
        case .myDues: return "My Dues"
        case .suggestions: return "Suggestion Box"
        case .approvals: return "Approvals"
        case .proposalReview: return model.user?.role == "owner" ? "Warden Proposals" : "My Dispensation Proposals"
        case .profile: return "Signature Profile"
        case .settings: return "Service Settings"
        case .documents: return "Live Queue"
        case .home, .mySettings, nil: return "Home"
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 11) {
                Text("22")
                    .font(.system(size: 21, weight: .medium, design: .serif))
                    .foregroundStyle(SignTheme.gold)
                    .frame(width: 42, height: 42)
                    .overlay(Circle().stroke(SignTheme.gold, lineWidth: 2))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Stone Square")
                        .font(.system(size: 19, weight: .medium, design: .serif))
                        .foregroundStyle(.white)
                    Text("Lodge Dashboard")
                        .font(.system(size: 11))
                        .foregroundStyle(SignTheme.sidebarInk.opacity(0.85))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 18)
            .overlay(alignment: .bottom) { SignTheme.sidebarInk.opacity(0.20).frame(height: 1) }

            HStack(spacing: 10) {
                Text(userInitials)
                    .font(.system(size: 12, weight: .semibold, design: .serif))
                    .foregroundStyle(SignTheme.brandNavy)
                    .frame(width: 34, height: 34)
                    .background(Color(red: 0.84, green: 0.90, blue: 0.92), in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.user?.name ?? "")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(model.user?.roleLabel ?? "")
                        .font(.system(size: 10))
                        .foregroundStyle(SignTheme.sidebarInk.opacity(0.8))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12)
            .overlay(alignment: .bottom) { SignTheme.sidebarInk.opacity(0.14).frame(height: 1) }

            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    navGroup("Start Here", expanded: $startExpanded) {
                        navItem("Home", mark: "▦", section: .home)
                        Link(destination: GrandViewPortal.url) {
                            navRow("Grand View ↗", mark: "GV", active: false)
                        }
                        .buttonStyle(.plain)
                    }
                    if hasMeetingsTools {
                        navGroup("Meetings And Reports", expanded: $meetingsExpanded) {
                            if model.user?.canOpen(.lodgeCalendar) == true { navItem("Lodge Calendar", mark: "CAL", section: .lodgeCalendar) }
                            if model.user?.canReadMinutes == true { navItem("Meeting Minutes", mark: "MIN", section: .minutes) }
                            if model.user?.role == "owner" { navItem("Agenda Creator", mark: "AG", section: .agenda) }
                            if model.user?.can("reports.create") == true { navItem("Report Generator", mark: "✎", section: .reportGenerator) }
                            if model.user?.role == "owner" { navItem("Received Reports", mark: "IN", section: .receivedReports) }
                        }
                    }
                    if hasDocumentsTools {
                        navGroup("Documents And Approvals", expanded: $documentsExpanded) {
                            if model.user?.canPrepareCorrespondence == true { navItem("Lodge Correspondence", mark: "LTR", section: .correspondence) }
                            if model.user?.can("documents.status") == true { navItem("Live Queue", mark: "◫", section: .documents) }
                            if model.user?.role == "owner" { navItem("Create Dispensation", mark: "+", section: .createDispensation) }
                            if model.user?.canReadApprovals == true { navItem("Approvals", mark: "✓", section: .approvals) }
                            if model.user?.canProposeDispensation == true || model.user?.role == "owner" {
                                navItem(model.user?.role == "owner" ? "Warden Proposals" : "My Dispensation Proposals", mark: "✎", section: .proposalReview)
                            }
                        }
                    }
                    if hasFinanceTools {
                        navGroup("Dues And Finance", expanded: $financeExpanded) {
                            if model.user?.canReadDues == true { navItem("Dues Ledger", mark: "$", section: .dues) }
                            if model.user?.can("dues.self") == true { navItem("My Dues", mark: "ME", section: .myDues) }
                            if model.user?.canUseTreasury == true { navItem("Treasurer Reports", mark: "TR", section: .treasury) }
                        }
                    }
                    if hasPeopleTools {
                        navGroup("People And Lodge", expanded: $peopleExpanded) {
                            if model.user?.role == "owner" {
                                navItem("Officer Access", mark: "ACC", section: .access)
                                navItem("Member Access", mark: "MEM", section: .memberAccess)
                            }
                            if model.user?.can("candidates.view") == true { navItem("Candidate Tracker", mark: "CT", section: .candidateTracker) }
                            if model.user?.can("suggestions.create") == true { navItem("Suggestion Box", mark: "SB", section: .suggestions) }
                            if model.user?.canOpen(.building) == true { navItem("Building Requests", mark: "BLD", section: .building) }
                        }
                    }
                    if hasAccountTools {
                        navGroup("Account", expanded: $accountExpanded) {
                            if model.user?.role == "owner" { navItem("Dashboard Activity", mark: "ACT", section: .activity) }
                            if model.user?.canOpen(.mySettings) == true { navItem("My Settings", mark: "⚙", section: .mySettings) }
                            if model.user?.canOpen(.settings) == true { navItem("Service Settings", mark: "NET", section: .settings) }
                            if model.user?.canSign == true { navItem("Signature Profile", mark: "✎", section: .profile) }
                        }
                    }
                }
                .padding(.top, 6)
            }
            .scrollIndicators(.hidden)

            VStack(alignment: .leading, spacing: 9) {
                Text("Sign-ins and actions are recorded for Lodge administration. Active time is estimated.")
                    .font(.system(size: 10))
                    .foregroundStyle(SignTheme.sidebarInk.opacity(0.78))
                    .fixedSize(horizontal: false, vertical: true)
                Label(model.isLive ? "Live Queue Connected" : "Reconnecting",
                      systemImage: model.isLive ? "circle.fill" : "circle.dotted")
                    .font(.system(size: 10))
                    .foregroundStyle(SignTheme.sidebarInk.opacity(0.83))
                Button("Sign Out") { model.signOut() }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 13)
            .overlay(alignment: .top) { SignTheme.sidebarInk.opacity(0.14).frame(height: 1) }
        }
        .padding(.horizontal, 17)
        .padding(.top, 21)
        .padding(.bottom, 16)
        .background(SignTheme.brandNavy)
    }

    private var compactHeader: some View {
        HStack(spacing: 12) {
            Text("22")
                .font(.system(size: 18, design: .serif))
                .foregroundStyle(SignTheme.gold)
                .frame(width: 38, height: 38)
                .overlay(Circle().stroke(SignTheme.gold, lineWidth: 2))
            VStack(alignment: .leading, spacing: 2) {
                Text("Stone Square").font(.system(size: 16, design: .serif))
                Text("Lodge Dashboard").font(.system(size: 10))
            }
            .foregroundStyle(.white)
            Spacer()
            Button { compactNavigationOpen.toggle() } label: {
                Label("Sections", systemImage: "line.3.horizontal")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(10)
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(.white.opacity(0.3)))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .popover(isPresented: $compactNavigationOpen, arrowEdge: .bottom) {
                sidebar.frame(width: 260, height: 600)
            }
        }
        .padding(.horizontal, 18)
        .frame(height: 62)
        .background(SignTheme.brandNavy)
    }

    private var userInitials: String {
        (model.user?.name ?? "")
            .split(separator: " ")
            .prefix(2)
            .compactMap(\.first)
            .map(String.init)
            .joined()
            .uppercased()
    }

    private var hasMeetingsTools: Bool { [.lodgeCalendar, .minutes, .agenda, .reportGenerator, .receivedReports].contains { model.user?.canOpen($0) == true } }
    private var hasDocumentsTools: Bool { [.correspondence, .documents, .createDispensation, .approvals, .proposalReview].contains { model.user?.canOpen($0) == true } }
    private var hasFinanceTools: Bool { [.dues, .myDues, .treasury].contains { model.user?.canOpen($0) == true } }
    private var hasPeopleTools: Bool { [.access, .memberAccess, .candidateTracker, .suggestions, .building].contains { model.user?.canOpen($0) == true } }
    private var hasAccountTools: Bool { [.activity, .mySettings, .settings, .profile].contains { model.user?.canOpen($0) == true } }

    private func navGroup<Content: View>(_ title: String, expanded: Binding<Bool>, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Button { openNavigationGroup(title) } label: {
                HStack {
                    Text(title.uppercased())
                        .font(.system(size: 11, weight: .bold))
                        .tracking(0.4)
                    Spacer()
                    Image(systemName: expanded.wrappedValue ? "chevron.up" : "chevron.down")
                        .foregroundStyle(Color(red: 0.89, green: 0.74, blue: 0.46))
                }
                .foregroundStyle(SignTheme.sidebarInk)
                .padding(.horizontal, 11)
                .frame(height: 41)
                .background(expanded.wrappedValue ? Color.white.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 7))
            }
            .buttonStyle(.plain)
            if expanded.wrappedValue { content() }
        }
        .padding(.vertical, 5)
    }

    private func navItem(_ title: String, mark: String, section: AppSection) -> some View {
        Button {
            selection = section
            groupLanding = nil
            compactNavigationOpen = false
        } label: {
            navRow(title, mark: mark, active: selection == section)
        }
        .buttonStyle(.plain)
    }

    private func openNavigationGroup(_ title: String) {
        startExpanded = title == "Start Here"
        meetingsExpanded = title == "Meetings And Reports"
        documentsExpanded = title == "Documents And Approvals"
        financeExpanded = title == "Dues And Finance"
        peopleExpanded = title == "People And Lodge"
        accountExpanded = title == "Account"
        groupLanding = title == "Start Here" ? nil : title
        selection = .home
        compactNavigationOpen = false
    }

    private func navRow(_ title: String, mark: String, active: Bool) -> some View {
        HStack(spacing: 8) {
            Text(mark)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color(red: 0.89, green: 0.74, blue: 0.46))
                .fixedSize(horizontal: true, vertical: false)
                .frame(width: 30, alignment: .leading)
            Text(title)
                .font(.system(size: 13))
                .foregroundStyle(SignTheme.sidebarInk)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 43, alignment: .leading)
        .background(active ? Color.white.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 7))
        .overlay(alignment: .leading) { if active { SignTheme.gold.frame(width: 3) } }
    }

    private var alertCount: Int {
        model.minutesReviewAlerts.count + model.treasuryAlerts.count + model.buildingAlerts.count
    }

    private struct SearchTool: Identifiable {
        let section: AppSection
        let title: String
        let symbol: String
        var id: AppSection { section }
    }

    private var navigationTools: [SearchTool] {
        let all: [SearchTool] = [
            .init(section: .home, title: "Home", symbol: "house.fill"),
            .init(section: .lodgeCalendar, title: "Lodge Calendar", symbol: "calendar"),
            .init(section: .agenda, title: "Agenda Creator", symbol: "list.number"),
            .init(section: .minutes, title: "Meeting Minutes", symbol: "text.document.fill"),
            .init(section: .reportGenerator, title: "Report Generator", symbol: "doc.text"),
            .init(section: .receivedReports, title: "Received Reports", symbol: "tray.full.fill"),
            .init(section: .correspondence, title: "Lodge Correspondence", symbol: "envelope.open.fill"),
            .init(section: .documents, title: "Live Queue", symbol: "list.number"),
            .init(section: .approvals, title: "Approvals", symbol: "checkmark.seal.fill"),
            .init(section: .createDispensation, title: "Create Dispensation", symbol: "doc.badge.plus"),
            .init(section: .proposalReview, title: model.user?.role == "owner" ? "Warden Proposals" : "My Dispensation Proposals", symbol: "square.and.pencil"),
            .init(section: .myDues, title: "My Dues", symbol: "dollarsign.circle.fill"),
            .init(section: .dues, title: "Dues Ledger", symbol: "list.bullet.rectangle.portrait.fill"),
            .init(section: .treasury, title: "Treasurer Reports", symbol: "chart.bar.doc.horizontal.fill"),
            .init(section: .candidateTracker, title: "Candidate Tracker", symbol: "person.text.rectangle.fill"),
            .init(section: .access, title: "Officer Access", symbol: "person.badge.key.fill"),
            .init(section: .memberAccess, title: "Member Access", symbol: "person.3.fill"),
            .init(section: .suggestions, title: "Suggestion Box", symbol: "text.bubble.fill"),
            .init(section: .building, title: "Building Requests", symbol: "building.2"),
            .init(section: .activity, title: "Dashboard Activity", symbol: "clock.arrow.circlepath"),
            .init(section: .profile, title: "Signature Profile", symbol: "signature"),
            .init(section: .mySettings, title: "My Settings", symbol: "gearshape"),
            .init(section: .settings, title: "Service Settings", symbol: "network")
        ]
        return all.filter { model.user?.canOpen($0.section) == true }
    }

    private var searchResults: [SearchTool] {
        navigationTools.filter { $0.title.localizedCaseInsensitiveContains(toolSearch) }
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

    private var buildingAlertButtons: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.buildingAlerts) { alert in
                Button {
                    model.requestedBuildingRequestID = alert.requestId
                    selection = .building
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(alert.title, systemImage: "bell.badge.fill")
                            .font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Text(alert.message).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
                    .frame(minHeight: 100, alignment: .topLeading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(alert.message)
                .padding(.horizontal, 22)
            }
        }
    }

    private func groupLandingView(_ group: String) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(group)
                    .font(.system(size: 30, weight: .medium, design: .serif))
                    .foregroundStyle(SignTheme.brandNavy)
                Spacer()
                Text("Stone Square Lodge No. 22")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 38)
            .frame(height: 72)
            .background(.white)
            .overlay(alignment: .bottom) { SignTheme.cardLine.frame(height: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("STONE SQUARE LODGE NO. 22")
                        .font(.system(size: 10, weight: .bold)).tracking(1.5)
                        .foregroundStyle(SignTheme.gold)
                    Text(group)
                        .font(.system(size: 34, weight: .medium, design: .serif))
                        .foregroundStyle(SignTheme.brandNavy)
                    Text(groupDescription(group))
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(navigationTools.filter { toolBelongsToGroup($0.section, group: group) }) { tool in
                            Button {
                                selection = tool.section
                                groupLanding = nil
                            } label: {
                                HStack {
                                    Text(tool.title).font(.system(size: 14, weight: .semibold))
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                }
                                .foregroundStyle(SignTheme.brandNavy)
                                .padding(.horizontal, 16)
                                .frame(minHeight: 52)
                                .overlay(alignment: .bottom) { SignTheme.cardLine.frame(height: 1) }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.white, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(38)
            }
            .background(SignTheme.page)
        }
    }

    private func groupDescription(_ group: String) -> String {
        switch group {
        case "Meetings And Reports": return "Calendar, minutes, agendas, and Lodge reports."
        case "Documents And Approvals": return "Prepare, review, sign, and follow Lodge documents."
        case "Dues And Finance": return "Your dues and authorized Lodge finance records."
        case "People And Lodge": return "Member access, candidates, suggestions, and building requests."
        case "Account": return "Your settings, signature, and permitted activity records."
        default: return "Open a Lodge tool."
        }
    }

    private func toolBelongsToGroup(_ section: AppSection, group: String) -> Bool {
        switch group {
        case "Meetings And Reports": return [.lodgeCalendar, .minutes, .agenda, .reportGenerator, .receivedReports].contains(section)
        case "Documents And Approvals": return [.correspondence, .documents, .createDispensation, .approvals, .proposalReview].contains(section)
        case "Dues And Finance": return [.dues, .myDues, .treasury].contains(section)
        case "People And Lodge": return [.access, .memberAccess, .candidateTracker, .suggestions, .building].contains(section)
        case "Account": return [.activity, .mySettings, .settings, .profile].contains(section)
        default: return false
        }
    }

    @ViewBuilder
    private var workspaceContent: some View {
        if model.user?.canOpen(selection) != true {
            ContentUnavailableView("This workspace is not assigned", systemImage: "lock")
        } else { switch selection {
        case .home:
            if let groupLanding {
                groupLandingView(groupLanding)
            } else {
                LandingDashboardView(
                correspondenceCount: correspondenceWorkspace.lettersForMySignature.count,
                openSection: { selection = $0 },
                openDispensations: { selection = .documents },
                openCandidateTracker: { selection = .candidateTracker },
                openReports: { selection = .reportGenerator },
                openCorrespondence: { selection = .correspondence },
                openReceivedReports: { selection = .receivedReports },
                openMinutes: { selection = .minutes },
                openAgenda: { selection = .agenda },
                openTreasury: { selection = .treasury },
                openBuilding: { selection = .building },
                openCalendar: { selection = .lodgeCalendar },
                openMyDues: { selection = .myDues },
                openSettings: { selection = .settings }
            )
            }
        case .building: BuildingRequestsView()
        case .lodgeCalendar: LodgeCalendarView()
        case .reportGenerator:
            ReportGeneratorView(browser: reportBrowser)
        case .correspondence:
            CorrespondenceView(workspace: correspondenceWorkspace)
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
        case .mySettings: MySettingsView()
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
    let correspondenceCount: Int
    let openCorrespondence: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            if correspondenceCount > 0 {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "envelope.badge.fill")
                        .foregroundStyle(SignTheme.gold)
                    Text("\(correspondenceCount) Lodge letter\(correspondenceCount == 1 ? "" : "s") awaiting your signature")
                        .font(.callout.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Review letters", action: openCorrespondence)
                        .fixedSize()
                }
                .padding(.horizontal, 22)
                .padding(.vertical, 11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(SignTheme.gold.opacity(0.12))
                Divider()
            }
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

    private let trackerGold = Color(red: 196 / 255, green: 154 / 255, blue: 67 / 255)
    private let trackerLine = Color(nsColor: .separatorColor)

    private var categoryOptions: [String] {
        let otherCategories = Set(model.candidateRecords.map(\.category)).subtracting(categories)
        return categories + otherCategories.sorted()
    }

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
    @State private var viewingRecord: CandidateRecord?
    @State private var pendingEditRecord: CandidateRecord?
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
                ScrollView {
                    LazyVStack(spacing: 9) {
                        ForEach(filteredRecords) { record in
                            Button {
                                if available.size.width < 780 { viewingRecord = record }
                                else { selectedRecordID = record.id }
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack(alignment: .top, spacing: 12) {
                                        Text(record.name)
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(.primary)
                                        Spacer(minLength: 12)
                                        Text(record.status)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(.primary)
                                            .multilineTextAlignment(.trailing)
                                    }
                                    if !record.owner.isEmpty {
                                        Text("Owner: \(record.owner)")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    if !record.nextStep.isEmpty {
                                        Text("Next Step: \(record.nextStep)")
                                            .font(.callout)
                                            .foregroundStyle(.primary)
                                            .multilineTextAlignment(.leading)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(14)
                                .background(selectedRecordID == record.id ? SignTheme.page : SignTheme.surface,
                                            in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
                            }
                            .buttonStyle(.plain)
                            .accessibilityValue(selectedRecordID == record.id ? "Selected Record" : "")
                        }
                    }
                    .padding(14)
                }
                .overlay {
                    if model.candidateTrackerLoading && model.candidateRecords.isEmpty { ProgressView("Loading records…") }
                    else if filteredRecords.isEmpty { ContentUnavailableView("No matching records", systemImage: "person.text.rectangle", description: Text("Choose another section or adjust the filters.")) }
                }
                .onChange(of: available.size.width) { _, width in
                    if width < 780 { selectedRecordID = nil }
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
            CandidateRecordEditorView(record: record, isNew: creatingRecord, categories: categoryOptions)
                .environmentObject(model)
        }
        .sheet(item: $viewingRecord, onDismiss: {
            if let record = pendingEditRecord {
                pendingEditRecord = nil
                editingRecord = record
            }
        }) { record in
            VStack(spacing: 0) {
                HStack {
                    Text("Candidate Record")
                        .font(.system(size: 22, weight: .medium, design: .serif))
                    Spacer()
                    Button("Done") { viewingRecord = nil }
                }
                .padding(20)
                ScrollView { recordCard(record).padding(20) }
            }
            .frame(minWidth: 520, minHeight: 430)
        }
    }

    private var sectionPicker: some View {
        Picker("Section", selection: $category) {
            ForEach(categoryOptions, id: \.self) { Text($0.isEmpty ? "Unfiled Records" : $0).tag($0) }
        }
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
                    Text(initials(for: record.name)).font(.caption.weight(.bold)).foregroundStyle(.primary)
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
                        if viewingRecord != nil {
                            pendingEditRecord = record
                            viewingRecord = nil
                        } else {
                            editingRecord = record
                        }
                    }
                    .buttonStyle(.bordered)
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
                .font(.caption.weight(.semibold))
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

    private var statusChoices: [String] {
        record.status.isEmpty ? [""] + statuses : (statuses.contains(record.status) ? statuses : [record.status] + statuses)
    }

    private var ownerChoices: [String] {
        record.owner.isEmpty || owners.contains(record.owner) ? owners : owners + [record.owner]
    }

    private var categoryChoices: [String] {
        record.category.isEmpty && !categories.contains("") ? [""] + categories :
            (categories.contains(record.category) ? categories : [record.category] + categories)
    }

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
                        ForEach(categoryChoices, id: \.self) { Text($0.isEmpty ? "Unfiled Records" : $0).tag($0) }
                    }
                    TextField("Phone", text: $record.phone)
                    TextField("Email", text: $record.email)
                }
                Section("Progress") {
                    Picker("Status", selection: $record.status) {
                        ForEach(statusChoices, id: \.self) { Text($0.isEmpty ? "No Status Recorded" : $0).tag($0) }
                    }
                    Picker("Owner", selection: $record.owner) {
                        ForEach(ownerChoices, id: \.self) { Text($0.isEmpty ? "Unassigned" : $0).tag($0) }
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

private struct UpcomingCalendarResponse: Decodable {
    let events: [LodgeCalendarEvent]
    let warnings: [String]
}

struct LandingDashboardView: View {
    @EnvironmentObject var model: AppModel
    @State private var upcomingEvents: [LodgeCalendarEvent] = []
    @State private var upcomingUnavailable = false
    @State private var hasCalendarSourceWarnings = false
    @State private var homeToolSearch = ""
    @State private var allToolsExpanded = false
    @State private var toolJump = 0
    @FocusState private var toolSearchFocused: Bool
    let correspondenceCount: Int
    let openSection: (AppSection) -> Void
    let openDispensations: () -> Void
    let openCandidateTracker: () -> Void
    let openReports: () -> Void
    let openCorrespondence: () -> Void
    let openReceivedReports: () -> Void
    let openMinutes: () -> Void
    let openAgenda: () -> Void
    let openTreasury: () -> Void
    let openBuilding: () -> Void
    let openCalendar: () -> Void
    let openMyDues: () -> Void
    let openSettings: () -> Void

    private var awaitingCount: Int {
        if model.user?.role == "owner" || model.user?.role == "viewer" {
            return model.documents.filter { !$0.isTerminal }.count
        }
        return model.documents.filter { $0.needsSignature && !$0.isTerminal }.count
    }

    private var hasAttentionItems: Bool {
        (model.user?.canReadMinutes == true && !model.minutesReviewAlerts.isEmpty)
            || (model.user?.canUseTreasury == true && !model.treasuryAlerts.isEmpty)
            || (model.user?.canOpen(.building) == true && !model.buildingAlerts.isEmpty)
            || (model.user?.canPrepareCorrespondence == true && correspondenceCount > 0)
    }

    private var easternGreeting: String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .current
        let hour = calendar.component(.hour, from: Date())
        if hour < 12 { return "Good Morning" }
        if hour < 17 { return "Good Afternoon" }
        return "Good Evening"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Home")
                    .font(.system(size: 30, weight: .medium, design: .serif))
                    .foregroundStyle(Color(red: 0.12, green: 0.17, blue: 0.21))
                Spacer()
                Text("Stone Square Lodge No. 22")
                    .font(.system(size: 12))
                    .foregroundStyle(Color(red: 0.35, green: 0.42, blue: 0.47))
            }
            .padding(.horizontal, 38)
            .frame(height: 72)
            .background(.white)
            .overlay(alignment: .bottom) { SignTheme.cardLine.frame(height: 1) }
            GeometryReader { available in
                ScrollViewReader { scroll in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 15) {
                            hero
                            if available.size.width > 760 {
                                HStack(alignment: .top, spacing: 15) {
                                    VStack(spacing: 15) {
                                        attentionPanel
                                        upcomingPanel
                                    }
                                    .frame(maxWidth: .infinity, alignment: .top)
                                    VStack(spacing: 15) {
                                        quickAccessPanel
                                        jurisdictionPanel
                                    }
                                    .frame(width: max(235, (available.size.width - 76 - 15) / 2.45), alignment: .top)
                                }
                            } else {
                                attentionPanel
                                upcomingPanel
                                quickAccessPanel
                                jurisdictionPanel
                            }
                            allToolsDisclosure
                                .id("allDashboardTools")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, available.size.width > 760 ? 38 : 18)
                        .padding(.top, 25)
                        .padding(.bottom, 32)
                    }
                    .background(SignTheme.page)
                    .onChange(of: toolJump) { _, _ in
                        withAnimation(.easeInOut(duration: 0.2)) {
                            scroll.scrollTo("allDashboardTools", anchor: .top)
                        }
                    }
                }
            }
        }.background(SignTheme.page)
            .task {
                if model.emailDeliveryReady == nil { await model.loadServiceSetup() }
                await loadUpcomingEvents()
            }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("YOUR LODGE WORK")
                .font(.system(size: 10, weight: .bold))
                .tracking(1)
                .foregroundStyle(Color(red: 0.93, green: 0.78, blue: 0.48))
            Text("\(easternGreeting), \(model.user?.name ?? "")")
                .font(.system(size: 34, weight: .medium, design: .serif))
                .foregroundStyle(SignTheme.sidebarInk)
            Text(model.user?.role == "warden"
                 ? "View Lodge status, prepare reports, and follow your dispensation proposals."
                 : "Review what needs attention and open your Lodge tools.")
                .font(.system(size: 14))
                .foregroundStyle(SignTheme.sidebarInk.opacity(0.86))
            Text((model.user?.roleLabel ?? "").uppercased())
                .font(.system(size: 10))
                .foregroundStyle(SignTheme.sidebarInk.opacity(0.86))
            primaryAction.padding(.top, 10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 174, alignment: .leading)
        .padding(.horizontal, 29)
        .padding(.vertical, 25)
        .background(SignTheme.brandNavy, in: RoundedRectangle(cornerRadius: 9))
    }

    private func homeCard<Content: View>(_ title: String, eyebrow: String, trailingTitle: String? = nil,
                                          trailingAction: (() -> Void)? = nil,
                                          @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(eyebrow)
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1)
                        .foregroundStyle(Color(red: 0.43, green: 0.36, blue: 0.22))
                    Text(title)
                        .font(.system(size: 20, weight: .medium, design: .serif))
                        .foregroundStyle(SignTheme.brandNavy)
                }
                Spacer()
                if let trailingTitle, let trailingAction {
                    Button(trailingTitle, action: trailingAction)
                        .buttonStyle(.plain)
                        .font(.system(size: 12))
                        .foregroundStyle(SignTheme.brandNavy)
                        .underline()
                }
            }
            Rectangle().fill(SignTheme.brandNavy).frame(height: 3)
            content()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(SignTheme.surface, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine, lineWidth: 1))
    }

    private var attentionPanel: some View {
        homeCard("Needs Attention", eyebrow: "YOUR LODGE WORK") {
            if !hasAttentionItems {
                Text("No Lodge records need attention.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            }
            if model.user?.canReadMinutes == true && !model.minutesReviewAlerts.isEmpty {
                summaryRow("Meeting Minutes · \(model.minutesReviewAlerts.count) \(model.minutesReviewAlerts.count == 1 ? "notice" : "notices")", action: openMinutes)
            }
            if model.user?.canUseTreasury == true && !model.treasuryAlerts.isEmpty {
                summaryRow("Treasurer Reports · \(model.treasuryAlerts.count) \(model.treasuryAlerts.count == 1 ? "notice" : "notices")", action: openTreasury)
            }
            if model.user?.canOpen(.building) == true {
                ForEach(model.buildingAlerts) { alert in
                    summaryRow("Building Requests · \(alert.title)") {
                        model.requestedBuildingRequestID = alert.requestId
                        openBuilding()
                    }
                }
            }
            if model.user?.canPrepareCorrespondence == true && correspondenceCount > 0 {
                summaryRow("Correspondence · \(correspondenceCount) \(correspondenceCount == 1 ? "notice" : "notices")", action: openCorrespondence)
            }
        }
    }

    private var quickAccessPanel: some View {
        homeCard("Open A Tool", eyebrow: "QUICK ACCESS") {
            VStack(alignment: .leading, spacing: 7) {
                Text("Find A Tool")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(SignTheme.brandNavy)
                TextField("Search available tools", text: $homeToolSearch)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($toolSearchFocused)
                    .padding(.horizontal, 13)
                    .frame(height: 46)
                    .background(.white, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
            }
            .padding(.bottom, 5)
            if homeToolSearch.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 {
                let matches = availableTools.filter { $0.title.localizedCaseInsensitiveContains(homeToolSearch) }
                if matches.isEmpty {
                    Text("No matching tools are available to your account.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                } else {
                    ForEach(matches.prefix(8)) { tool in
                        quickButton(tool.title, action: tool.action)
                    }
                }
            } else {
                ForEach(quickTools.prefix(4)) { tool in
                    quickButton(tool.title, action: tool.action)
                }
            }
        }
    }

    @ViewBuilder private var upcomingPanel: some View {
        if model.user?.canOpen(.lodgeCalendar) == true {
            homeCard("Coming Up", eyebrow: "LODGE CALENDAR", trailingTitle: "Open Calendar", trailingAction: openCalendar) {
                if upcomingUnavailable {
                    Text("The calendar could not load. Open the calendar to try again.")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                } else if upcomingEvents.isEmpty {
                    Text("No upcoming events are listed in the next 60 days.")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                } else {
                    ForEach(upcomingEvents) { event in
                        let time = LodgeCalendarDates.displayTime(event.startTime)
                        eventRow(event.title, detail: [LodgeCalendarDates.displayDate(event.startDate), time, event.location]
                            .filter { !$0.isEmpty }.joined(separator: " · "), action: openCalendar)
                    }
                }
                if hasCalendarSourceWarnings && !upcomingUnavailable {
                    Text("Some building calendar updates are unavailable. Open the calendar for details.")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func loadUpcomingEvents() async {
        guard model.user?.canOpen(.lodgeCalendar) == true else { return }
        let from = LodgeCalendarDates.key(Date())
        let end = LodgeCalendarDates.key(LodgeCalendarDates.calendar.date(byAdding: .day, value: 60, to: Date()) ?? Date())
        do {
            let result: UpcomingCalendarResponse = try await model.request("/api/lodge-calendar?from=\(from)&to=\(end)")
            upcomingEvents = Array(result.events
                .filter { ($0.endDate.isEmpty ? $0.startDate : $0.endDate) >= from && $0.status.lowercased() != "cancelled" }
                .sorted { ($0.startDate, $0.startTime ?? "", $0.title) < ($1.startDate, $1.startTime ?? "", $1.title) }
                .prefix(3))
            upcomingUnavailable = false
            hasCalendarSourceWarnings = !result.warnings.isEmpty
        } catch {
            upcomingEvents = []
            upcomingUnavailable = true
            hasCalendarSourceWarnings = false
        }
    }

    private var jurisdictionPanel: some View {
        homeCard("Grand View", eyebrow: "GRAND LODGE") {
            Text("Open the official Delaware member portal with your Grand View account.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Link(destination: GrandViewPortal.url) {
                HStack {
                    Text("Open Grand View ↗")
                        .font(.system(size: 13, weight: .semibold))
                    Spacer()
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 13)
                .frame(height: 44)
                .background(SignTheme.brandNavy, in: RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)
        }
    }

    private var allToolsDisclosure: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { allToolsExpanded.toggle() } label: {
                HStack {
                    Text("Browse All Dashboard Tools")
                        .font(.system(size: 17, weight: .medium, design: .serif))
                    Image(systemName: allToolsExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12))
                }
                .foregroundStyle(SignTheme.brandNavy)
            }
            .buttonStyle(.plain)
            if allToolsExpanded {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 12)], spacing: 12) {
                    ForEach(availableTools) { tool in
                        Button(action: tool.action) {
                            HStack {
                                Text(tool.title).font(.system(size: 14, weight: .semibold))
                                Spacer()
                                Image(systemName: "chevron.right")
                            }
                            .foregroundStyle(SignTheme.brandNavy)
                            .padding(14)
                            .frame(minHeight: 52)
                            .background(.white, in: RoundedRectangle(cornerRadius: 9))
                            .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    private struct HomeTool: Identifiable {
        let title: String
        let action: () -> Void
        var id: String { title }
    }

    private var quickTools: [HomeTool] {
        var tools: [HomeTool] = []
        if model.user?.canOpen(.lodgeCalendar) == true { tools.append(.init(title: "Lodge Calendar", action: openCalendar)) }
        if model.user?.can("dues.self") == true { tools.append(.init(title: "My Dues", action: openMyDues)) }
        if model.user?.canReadMinutes == true { tools.append(.init(title: "Meeting Minutes", action: openMinutes)) }
        if model.user?.can("documents.status") == true { tools.append(.init(title: "Live Queue", action: openDispensations)) }
        if model.user?.can("reports.create") == true { tools.append(.init(title: "Report Generator", action: openReports)) }
        if model.user?.can("candidates.view") == true { tools.append(.init(title: "Candidate Tracker", action: openCandidateTracker)) }
        return tools
    }

    private var availableTools: [HomeTool] {
        var tools = quickTools
        func append(_ title: String, _ action: @escaping () -> Void) {
            if !tools.contains(where: { $0.title == title }) { tools.append(.init(title: title, action: action)) }
        }
        append("Grand View", { NSWorkspace.shared.open(GrandViewPortal.url) })
        if model.user?.role == "owner" { append("Agenda Creator", openAgenda); append("Received Reports", openReceivedReports) }
        if model.user?.canPrepareCorrespondence == true { append("Lodge Correspondence", openCorrespondence) }
        if model.user?.canUseTreasury == true { append("Treasurer Reports", openTreasury) }
        if model.user?.canOpen(.building) == true { append("Building Requests", openBuilding) }
        if model.user?.canReadDues == true { append("Dues Ledger", { openSection(.dues) }) }
        if model.user?.canReadApprovals == true { append("Approvals", { openSection(.approvals) }) }
        if model.user?.role == "owner" {
            append("Create Dispensation", { openSection(.createDispensation) })
            append("Officer Access", { openSection(.access) })
            append("Member Access", { openSection(.memberAccess) })
            append("Dashboard Activity", { openSection(.activity) })
        }
        if model.user?.canOpen(.proposalReview) == true {
            append(model.user?.role == "owner" ? "Warden Proposals" : "My Dispensation Proposals", { openSection(.proposalReview) })
        }
        if model.user?.canOpen(.suggestions) == true { append("Suggestion Box", { openSection(.suggestions) }) }
        if model.user?.canOpen(.mySettings) == true { append("My Settings", { openSection(.mySettings) }) }
        if model.user?.canOpen(.settings) == true { append("Service Settings", openSettings) }
        if model.user?.canOpen(.profile) == true { append("Signature Profile", { openSection(.profile) }) }
        return tools
    }

    private var primaryAction: some View {
        heroButton(hasAttentionItems ? "Review What Needs Attention" : "Open Lodge Tools") {
            if hasAttentionItems { openFirstAttentionItem() }
            else {
                allToolsExpanded = true
                toolJump += 1
            }
        }
    }

    private func openFirstAttentionItem() {
        if let alert = model.buildingAlerts.first, model.user?.canOpen(.building) == true {
            model.requestedBuildingRequestID = alert.requestId
            openBuilding()
        } else if !model.minutesReviewAlerts.isEmpty, model.user?.canReadMinutes == true {
            openMinutes()
        } else if !model.treasuryAlerts.isEmpty, model.user?.canUseTreasury == true {
            openTreasury()
        } else if model.user?.canPrepareCorrespondence == true && correspondenceCount > 0 {
            openCorrespondence()
        }
    }

    private func heroButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 0)
                Image(systemName: "arrow.right")
            }
            .foregroundStyle(SignTheme.brandNavy)
            .padding(.horizontal, 17)
            .frame(height: 43)
            .fixedSize(horizontal: true, vertical: false)
            .background(SignTheme.gold, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    private func quickButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 13))
                Spacer()
            }
            .foregroundStyle(Color(red: 0.09, green: 0.19, blue: 0.26))
            .padding(.horizontal, 12)
            .frame(height: 43)
            .background(Color(red: 0.91, green: 0.94, blue: 0.95), in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    private func summaryRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 13))
                Spacer()
            }
            .foregroundStyle(Color(red: 0.12, green: 0.17, blue: 0.21))
            .frame(minHeight: 46)
            .overlay(alignment: .bottom) { SignTheme.cardLine.frame(height: 1) }
        }
        .buttonStyle(.plain)
    }

    private func eventRow(_ title: String, detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
            .overlay(alignment: .bottom) { SignTheme.cardLine.frame(height: 1) }
        }
        .buttonStyle(.plain)
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
    @State private var permissionsExpanded = false
    @State private var permissionsDirty = false
    private var canCreateInvitation: Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedName.isEmpty && trimmedEmail.contains("@") && trimmedEmail.split(separator: "@").last?.contains(".") == true && !model.isBusy
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                NativeWorkspaceHeader(title: "Officer Access", subtitle: "Invitations and account access", symbol: "person.badge.key").padding(.horizontal, -22)
                Button {
                    permissionsDirty = false
                    permissionsExpanded = true
                } label: {
                    HStack {
                        Text("Individual Permissions")
                            .font(.system(size: 20, weight: .medium, design: .serif))
                        Spacer()
                        Text("Manage")
                            .font(.system(size: 13))
                        Image(systemName: "arrow.up.right")
                    }
                    .foregroundStyle(SignTheme.brandNavy)
                    .padding(18)
                    .background(.white, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
                }
                .buttonStyle(.plain)
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
                LazyVStack(spacing: 0) {
                    ForEach(Array(seats.enumerated()), id: \.offset) { _, seat in
                        OfficerCard(name: seat.name, office: seat.office, state: seat.state)
                    }
                }
                VStack(alignment: .leading, spacing: 14) {
                    Text("Invite An Officer")
                        .font(.system(size: 22, weight: .medium, design: .serif))
                        .foregroundStyle(SignTheme.brandNavy)
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
                    .pickerStyle(.menu)
                    TextField("Full name", text: $name)
                        .textFieldStyle(.roundedBorder)
                    TextField("Email address", text: $email)
                        .textFieldStyle(.roundedBorder)
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
                            .textFieldStyle(.roundedBorder)
                        Button("Copy private link") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(privateLink, forType: .string)
                        }
                    }
                }
                .frame(maxWidth: 660)
                .padding(20)
                .background(.white, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))

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
        .sheet(isPresented: $permissionsExpanded) {
            VStack(spacing: 0) {
                HStack {
                    Text("Individual Permissions")
                        .font(.system(size: 25, weight: .medium, design: .serif))
                    Spacer()
                    Button("Done") { permissionsExpanded = false }
                        .disabled(permissionsDirty)
                }
                .padding(20)
                ScrollView {
                    NativeAccountPermissionsView(hasUnsavedChanges: $permissionsDirty)
                        .padding(20)
                }
            }
            .frame(minWidth: 680, minHeight: 520)
            .interactiveDismissDisabled(permissionsDirty)
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

struct MySettingsView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var deviceSessions = AccountSessionsWorkspace()
    @State private var sessionToRevoke: DeviceSession?
    @State private var confirmOtherDevices = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("My Settings")
                    .font(.system(size: 30, weight: .medium, design: .serif))
                    .foregroundStyle(SignTheme.brandNavy)
                Spacer()
                Text("Stone Square Lodge No. 22")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 38)
            .frame(height: 72)
            .background(.white)
            .overlay(alignment: .bottom) { SignTheme.cardLine.frame(height: 1) }

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("My Settings")
                            .font(.system(size: 31, weight: .medium, design: .serif))
                            .foregroundStyle(SignTheme.brandNavy)
                        Text("Your account and signed-in devices.")
                            .font(.system(size: 14)).foregroundStyle(.secondary)
                    }
                    settingsCard {
                        Text(model.user?.name ?? "")
                            .font(.system(size: 23, weight: .medium, design: .serif))
                            .foregroundStyle(SignTheme.brandNavy)
                        Text(model.user?.email ?? "")
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                        Text("New sign-ins last up to 90 days and renew when used near expiration. Older sign-ins may have a different expiration. Sign out when finished on a shared device.")
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack {
                            if model.user?.canSign == true {
                                Button("Manage My Signature") { model.requestedSection = .profile }
                                    .buttonStyle(.bordered)
                            }
                            Button("Sign Out on This Device") { model.signOut() }
                                .buttonStyle(.bordered)
                        }
                    }
                    settingsCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("ACCOUNT SECURITY")
                                    .font(.system(size: 10, weight: .bold)).tracking(1.5)
                                    .foregroundStyle(SignTheme.gold)
                                Text("Signed-in devices")
                                    .font(.system(size: 23, weight: .medium, design: .serif))
                                    .foregroundStyle(SignTheme.brandNavy)
                            }
                            Spacer()
                            Button("Refresh") { Task { await deviceSessions.load(using: model) } }
                                .disabled(deviceSessions.isLoading)
                        }
                        Text("Review devices that can open your Lodge account. End any sign-in you do not recognize.")
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                        if deviceSessions.isLoading { ProgressView().controlSize(.small) }
                        if !deviceSessions.message.isEmpty {
                            Text(deviceSessions.message)
                                .font(.system(size: 12))
                                .foregroundStyle(deviceSessions.isError ? .red : .secondary)
                        }
                        ForEach(deviceSessions.sessions) { session in
                            HStack(alignment: .top, spacing: 12) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(session.current ? "\(session.label.isEmpty ? "This device" : session.label) · Current" : (session.label.isEmpty ? "Signed-in device" : session.label))
                                        .font(.system(size: 14, weight: .semibold))
                                    Text("Last used \(displayDate(session.lastUsedAt)) · \(expirationDescription(session.expiresAt))")
                                        .font(.system(size: 12)).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if !session.current {
                                    Button("Sign Out Device") { sessionToRevoke = session }
                                        .buttonStyle(.bordered)
                                        .disabled(deviceSessions.isLoading)
                                }
                            }
                            .padding(13)
                            .background(.white, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(SignTheme.cardLine))
                        }
                        if deviceSessions.sessions.contains(where: { !$0.current }) {
                            Button("Sign Out All Other Devices") { confirmOtherDevices = true }
                                .buttonStyle(.bordered)
                                .disabled(deviceSessions.isLoading)
                        }
                    }
                }
                .frame(maxWidth: 1000, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(38)
            }
            .background(SignTheme.page)
        }
        .task { await deviceSessions.load(using: model) }
        .alert("Sign Out Device?", isPresented: Binding(
            get: { sessionToRevoke != nil },
            set: { if !$0 { sessionToRevoke = nil } }
        )) {
            Button("Cancel", role: .cancel) { sessionToRevoke = nil }
            Button("Sign Out Device", role: .destructive) {
                guard let id = sessionToRevoke?.id else { return }
                sessionToRevoke = nil
                Task { await deviceSessions.revoke(id: id, using: model) }
            }
        } message: {
            Text("This device will need the account password to reconnect.")
        }
        .alert("Sign Out All Other Devices?", isPresented: $confirmOtherDevices) {
            Button("Cancel", role: .cancel) {}
            Button("Sign Out All Other Devices", role: .destructive) {
                Task { await deviceSessions.revokeOthers(using: model) }
            }
        } message: {
            Text("Every other device will need the account password to reconnect.")
        }
    }

    private func settingsCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(22)
            .background(.white, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
    }

    private func displayDate(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "unavailable" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        guard let date else { return "unavailable" }
        return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
    }

    private func expirationDescription(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "Expiration unavailable" }
        if raw.hasPrefix("9999-") { return "No scheduled expiration (older sign-in)" }
        return "Expires \(displayDate(raw))"
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var checkingConnection = false
    @State private var connectionStatus = ""
    @State private var connectionFailed = false
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
                Button("Test and refresh") {
                    Task {
                        checkingConnection = true
                        connectionStatus = "Checking connection…"
                        connectionFailed = false
                        do {
                            let _: MeResponse = try await model.request("/api/auth/me")
                            await model.refresh()
                            connectionStatus = "Connection confirmed. Updated records were requested."
                        } catch {
                            connectionStatus = "Connection check failed: \(error.localizedDescription)"
                            connectionFailed = true
                        }
                        checkingConnection = false
                    }
                }
                .disabled(checkingConnection)
                if !connectionStatus.isEmpty {
                    Text(connectionStatus)
                        .font(.caption)
                        .foregroundStyle(connectionFailed ? .red : .secondary)
                }
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
    @State private var activityRow: DuesRow?
    @State private var correctionNotice: String?
    @State private var correctionNeedsReview = false
    @State private var exporting: DuesExportFormat?
    @State private var exportNotice: String?
    @State private var exportFailed = false

    private let moneyColumnWidth: CGFloat = 108
    private let statusColumnWidth: CGFloat = 94
    private let activityColumnWidth: CGFloat = 150

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
        GeometryReader { available in
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                NativeWorkspaceHeader(title: "Dues Ledger", subtitle: model.dues.map { "Standard \($0.duesYear) dues rate: \(lodgeMoney($0.rateCents)). Payments reconcile against both Zeffy campaigns. Life member assessments require separate review." } ?? "Review payments, balances, and corrections", symbol: "dollarsign.circle") {
                    if model.user?.canManageDues == true { Button("Record Activity", systemImage: "plus") { showingAdjustment = true } }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.loadDues() } }.disabled(model.duesLoading)
                    Button("Download PDF") { Task { await export(.pdf) } }
                        .disabled(model.dues == nil || exporting != nil)
                    Button("Download Excel") { Task { await export(.xlsx) } }
                        .disabled(model.dues == nil || exporting != nil)
                }.padding(.horizontal, -22)
                if exporting != nil { ProgressView("Preparing dues snapshot…") }
                if let correctionNotice {
                    Text(correctionNotice)
                        .font(.callout)
                        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                        .background((correctionNeedsReview ? Color.orange : Color.green).opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
                }
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
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 14)], spacing: 14) {
                        duesTile("Collected", lodgeMoney(ledger.totals.collectedCents))
                        duesTile("Outstanding", lodgeMoney(ledger.totals.outstandingCents))
                        duesTile("Paid In Full", "\(ledger.totals.paidCount)")
                        duesTile("Not Yet Paid", "\(ledger.totals.unpaidCount)")
                    }

                    if let stale = ledger.staleCampaign {
                        Text("Last year's custom dues campaign is still open and has taken \(stale.count) payment(s) totalling \(lodgeMoney(stale.totalCents)). Those are NOT counted above. Close that campaign in Zeffy.")
                            .font(.callout)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(SignTheme.gold.opacity(0.14))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }

                    VStack(alignment: .leading, spacing: 5) {
                        Text("BY BROTHER")
                            .font(.system(size: 10, weight: .bold)).tracking(1.5)
                            .foregroundStyle(SignTheme.gold)
                        Text("Member Balances")
                            .font(.system(size: 23, weight: .medium, design: .serif))
                            .foregroundStyle(Color(red: 0.33, green: 0.44, blue: 0.53))
                        Text("Brothers needing attention appear first. Open a Brother's activity to review each payment and correct a manual entry.")
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                    if available.size.width >= 850 {
                        duesTable(ledger.rows)
                    } else {
                        duesCompactRows(ledger.rows)
                    }

                    if !ledger.unmatched.isEmpty {
                        Text("Could Not Be Matched").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
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
        .sheet(item: $activityRow) { row in
            DuesActivityView(row: row) { adjustmentID, amountCents in
                await model.loadDues()
                let updated = model.dues?.rows.first { $0.rosterId == row.rosterId }
                let reversalFound = updated?.payments.contains {
                    $0.reversesAdjustmentId == adjustmentID && $0.amountCents == -amountCents
                } == true
                let balanceVerified = updated?.paidCents == row.paidCents - amountCents
                    && updated?.remainingCents == max(0, row.assessedCents - row.paidCents + amountCents)
                correctionNeedsReview = model.duesError != nil || !reversalFound || !balanceVerified
                correctionNotice = correctionNeedsReview
                    ? "The reversal request succeeded, but the updated balance could not be verified. Select Refresh and review Payment Activity before trying again."
                    : "The reversal was recorded. Payment Activity and the updated balance have been verified."
                activityRow = nil
            }
            .environmentObject(model)
        }
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

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "paid": return "Paid In Full"
        case "partial": return "Partial"
        default: return "Unpaid"
        }
    }

    private func lastActivity(_ row: DuesRow) -> String {
        guard let date = row.lastPaymentISO, !date.isEmpty else { return "No activity" }
        return LodgeCalendarDates.displayDate(String(date.prefix(10)))
    }

    private func duesTable(_ rows: [DuesRow]) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("Brother").frame(maxWidth: .infinity, alignment: .leading)
                Text("Dues Assessed").frame(width: moneyColumnWidth, alignment: .trailing)
                Text("Paid To Date").frame(width: moneyColumnWidth, alignment: .trailing)
                Text("Balance Due").frame(width: moneyColumnWidth, alignment: .trailing)
                Text("Status").frame(width: statusColumnWidth, alignment: .leading)
                Text("Last Activity").frame(width: activityColumnWidth, alignment: .leading)
            }
            .font(.caption2.weight(.bold))
            .tracking(0.7)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(SignTheme.navy.opacity(0.06))

            ForEach(rows) { row in
                Button { activityRow = row } label: {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name).font(.callout.weight(.semibold)).lineLimit(2)
                        if row.creditCents > 0 {
                            Text("\(lodgeMoney(row.creditCents)) credit")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    amountCell(row.assessedCents).frame(width: moneyColumnWidth, alignment: .trailing)
                    amountCell(row.paidCents).frame(width: moneyColumnWidth, alignment: .trailing)
                    amountCell(row.remainingCents).frame(width: moneyColumnWidth, alignment: .trailing)
                    Text(statusLabel(row.status))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(tint(row.status))
                        .frame(width: statusColumnWidth, alignment: .leading)
                    Text(lastActivity(row))
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .frame(width: activityColumnWidth, alignment: .leading)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 16)
                .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(duesAccessibility(row)). View Payment Activity")
                Divider()
            }
        }
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay { RoundedRectangle(cornerRadius: 10).stroke(.separator.opacity(0.5)) }
    }

    private func duesCompactRows(_ rows: [DuesRow]) -> some View {
        VStack(spacing: 8) {
            ForEach(rows) { row in
                Button { activityRow = row } label: {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(row.name).font(.callout.weight(.semibold))
                        Spacer(minLength: 4)
                        Text(statusLabel(row.status))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(tint(row.status))
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 10)], alignment: .leading, spacing: 8) {
                        compactAmount("Dues Assessed", row.assessedCents)
                        compactAmount("Paid To Date", row.paidCents)
                        compactAmount("Balance Due", row.remainingCents)
                    }
                    Text("Last activity: \(lastActivity(row))\(row.creditCents > 0 ? " · \(lodgeMoney(row.creditCents)) credit" : "")")
                        .font(.caption).foregroundStyle(.secondary)
                    Label("View Payment Activity", systemImage: "arrow.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func amountCell(_ cents: Int) -> some View {
        Text(lodgeMoney(cents))
            .font(.callout.monospacedDigit())
            .lineLimit(1).minimumScaleFactor(0.8)
    }

    private func duesAccessibility(_ row: DuesRow) -> String {
        let credit = row.creditCents > 0 ? ", credit \(lodgeMoney(row.creditCents))" : ""
        return "\(row.name), dues assessed \(lodgeMoney(row.assessedCents)), paid to date \(lodgeMoney(row.paidCents)), balance due \(lodgeMoney(row.remainingCents)), \(statusLabel(row.status)), last activity \(lastActivity(row))\(credit)"
    }

    private func compactAmount(_ label: String, _ cents: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            amountCell(cents)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func duesTile(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Text(value)
                .font(.system(size: 27, weight: .medium, design: .serif))
                .foregroundStyle(Color(red: 0.33, green: 0.44, blue: 0.53))
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 76)
        .background(SignTheme.surface, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
    }
}


private struct DuesReversalDraft: Encodable { let reason: String }

struct DuesActivityView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let row: DuesRow
    let reversed: (Int, Int) async -> Void
    @State private var selectedAdjustmentID: Int?
    @State private var reason = ""
    @State private var message = ""
    @State private var working = false

    private var reversalIDs: Set<Int> {
        Set(row.payments.compactMap(\.reversesAdjustmentId))
    }

    private var selectedPayment: DuesPayment? {
        row.payments.first { $0.adjustmentId == selectedAdjustmentID }
    }

    private func canReverse(_ payment: DuesPayment) -> Bool {
        guard let id = payment.adjustmentId else { return false }
        return model.user?.canManageDues == true
            && payment.campaign == "manual"
            && payment.reversesAdjustmentId == nil
            && !reversalIDs.contains(id)
    }

    private func activityTitle(_ payment: DuesPayment) -> String {
        if payment.reversesAdjustmentId != nil { return "Reversal" }
        if payment.campaign == "manual" { return "Manual \((payment.transactionType ?? "payment").capitalized)" }
        if payment.campaign == "annual" { return "Zeffy Annual Dues" }
        return payment.campaign == "custom" ? "Zeffy Custom Dues" : "Zeffy Payment"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Payment Activity").font(.title2.weight(.semibold))
                    Text(row.name).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }.disabled(working)
            }
            HStack(spacing: 18) {
                balanceSummary("Dues Assessed", row.assessedCents)
                balanceSummary("Paid To Date", row.paidCents)
                balanceSummary("Balance Due", row.remainingCents)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if row.payments.isEmpty {
                        Text("No payments have been recorded for this dues year.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(row.payments.enumerated()), id: \.offset) { _, payment in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(activityTitle(payment)).font(.headline)
                                Spacer()
                                Text(lodgeMoney(payment.amountCents))
                                    .font(.headline.monospacedDigit())
                            }
                            Text(LodgeCalendarDates.displayDate(String(payment.dateISO.prefix(10))))
                                .font(.callout).foregroundStyle(.secondary)
                            if payment.campaign == "manual" {
                                let details = [payment.paymentMethod, payment.sourceReference, payment.enteredBy]
                                    .compactMap { $0?.isEmpty == false ? $0 : nil }
                                if !details.isEmpty {
                                    Text(details.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                if let note = payment.note, !note.isEmpty {
                                    Text(note).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            if let adjustmentID = payment.adjustmentId, reversalIDs.contains(adjustmentID) {
                                Label("Reversed", systemImage: "arrow.uturn.backward.circle")
                                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            }
                            if canReverse(payment), let adjustmentID = payment.adjustmentId {
                                Button("Review Reversal") {
                                    selectedAdjustmentID = adjustmentID
                                    reason = ""
                                    message = ""
                                }
                                .font(.callout.weight(.semibold))
                            }
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            if let payment = selectedPayment, canReverse(payment) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Review Dues Reversal").font(.headline)
                    Text(payment.amountCents >= 0
                         ? "The original entry will remain in the record. A reversal will remove \(lodgeMoney(payment.amountCents)) from this Brother's paid total."
                         : "The original entry will remain in the record. A reversal will restore \(lodgeMoney(-payment.amountCents)) to this Brother's paid total.")
                        .font(.callout)
                    HStack {
                        Text("Current Balance Due")
                        Spacer()
                        Text(lodgeMoney(row.remainingCents))
                    }
                    HStack {
                        Text("Projected Balance Due").fontWeight(.semibold)
                        Spacer()
                        Text(lodgeMoney(max(0, row.assessedCents - row.paidCents + payment.amountCents)))
                            .fontWeight(.semibold)
                    }
                    TextField("Reason For Reversal", text: $reason, axis: .vertical)
                        .lineLimit(2...4)
                    if !message.isEmpty { Text(message).font(.caption).foregroundStyle(.red) }
                    HStack {
                        Button("Cancel") { selectedAdjustmentID = nil; reason = "" }
                        Spacer()
                        Button("Confirm Reversal") { Task { await reverse(payment) } }
                            .buttonStyle(.borderedProminent)
                            .disabled(working || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(18)
                .background(SignTheme.gold.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .padding(24)
        .frame(minWidth: 520, idealWidth: 680, minHeight: 540, idealHeight: 700)
    }

    private func balanceSummary(_ title: String, _ cents: Int) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(lodgeMoney(cents)).font(.title3.weight(.semibold).monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }

    @MainActor private func reverse(_ payment: DuesPayment) async {
        guard let id = payment.adjustmentId, canReverse(payment) else { return }
        working = true
        defer { working = false }
        do {
            await model.loadDues()
            guard model.duesError == nil, let current = model.dues?.rows.first(where: { $0.rosterId == row.rosterId }) else {
                message = "The current ledger could not be checked. Refresh and try again."
                return
            }
            guard current == row else {
                message = "This Brother's ledger changed. Close Payment Activity and review the current entries before reversing."
                return
            }
            let body = try JSONEncoder().encode(DuesReversalDraft(reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)))
            let _: MessageResponse = try await model.request("/api/dues/adjustments/\(id)/reverse", method: "POST", body: body)
            await reversed(id, payment.amountCents)
            dismiss()
        } catch {
            message = error.localizedDescription
        }
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
    let rosterId:Int; let transactionType:String; let amount:String; let effectiveDate:String; let paymentMethod:String; let sourceReference:String; let note:String; let clientSubmissionId:String
}
private struct DuesAdjustmentResult: Decodable { let id: Int; let message: String; let replayed: Bool? }
private struct DuesPendingAttempt {
    let submissionId:String
    let rosterId:Int
    let transactionType:String
    let amount:String
    let effectiveDate:String
    let paymentMethod:String
    let sourceReference:String
    let note:String
    let baselineAdjustmentIds:Set<Int>
    var resultId:Int?
}
@MainActor private enum DuesPendingAttemptStore {
    static var byAccount:[Int:DuesPendingAttempt]=[:]
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
    @State private var clientSubmissionId=UUID().uuidString
    @State private var attemptedFingerprint:String?
    @State private var pendingResultId:Int?
    @State private var baselineAdjustmentIds:Set<Int>=[]
    @State private var uncertain=false
    @State private var checkingLedger=false
    @State private var showCloseWarning=false
    @State private var messageIsError=false
    private var selectedRow:DuesRow? { model.dues?.rows.first { $0.rosterId == rosterId } ?? rows.first { $0.rosterId == rosterId } }
    private var projectedBalance:Int? {
        guard let row=selectedRow, let dollars=Double(amount), dollars > 0 else { return nil }
        let direction = ["refund","chargeback"].contains(type) ? -1 : 1
        return max(0,row.assessedCents-row.paidCents-direction*Int((dollars*100).rounded()))
    }
    var body: some View { VStack(alignment:.leading,spacing:12){
        HStack{VStack(alignment:.leading){Text("Record Non-Zeffy Dues Activity").font(.title2.weight(.semibold));Text("Review the details before recording a payment.").foregroundStyle(.secondary)};Spacer();Button("Cancel"){if uncertain{showCloseWarning=true}else{dismiss()}}}
        ScrollView { VStack(alignment:.leading,spacing:14){
            VStack(alignment:.leading,spacing:8){
                Text("Describe One Manual Payment").font(.headline)
                Text("For example: Bro. James Smith paid $175 by check 1042 today.").font(.caption).foregroundStyle(.secondary)
                TextEditor(text:$assistText).frame(minHeight:76).padding(5).background(Color.primary.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius:8))
                HStack{Button("Prepare Payment Details"){Task{await prepare()}}.disabled(model.user?.canManageDues != true || uncertain || assisting || assistText.trimmingCharacters(in:.whitespacesAndNewlines).count < 12);if assisting{ProgressView()};Text(assistMessage).font(.caption).foregroundStyle(.secondary)}
            }.padding(14).background(SignTheme.gold.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius:12))
            if assistReady {
                VStack(alignment:.leading,spacing:6){
                    Text("Review Before Recording").font(.headline)
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
                if !dateConfirmed { Button("Confirm The Displayed Date") { dateConfirmed=true } }
                Picker("Method",selection:$method){Text("Choose a method").tag("");ForEach(["Cash","Check","Money order","Bank transfer","Other"],id:\.self){Text($0)}}
                TextField("Reference",text:$reference)
                TextField("Note",text:$note,axis:.vertical).lineLimit(2...5)
            }.frame(minHeight:300).disabled(uncertain || working)
        }}
        if !message.isEmpty { Text(message).font(.caption).foregroundStyle(messageIsError ? .red : .secondary) }
        HStack{if uncertain{Button("Check Ledger"){Task{await checkLedger()}}.disabled(checkingLedger);if checkingLedger{ProgressView()}};Spacer();Button("Confirm And Record Activity"){Task{await save()}}.buttonStyle(.borderedProminent).disabled(model.user?.canManageDues != true || uncertain || working || rosterId == nil || Double(amount) == nil || method.isEmpty || !dateConfirmed)}
    }.padding(24).frame(minWidth:520,idealWidth:650,minHeight:580,idealHeight:680)
        .alert("Submission Status Unverified", isPresented: $showCloseWarning) {
            Button("Keep Checking", role: .cancel) {}
            Button("Close Form", role: .destructive) { dismiss() }
        } message: {
            Text("The payment may already be recorded. Check this Brother's Payment Activity before creating another entry.")
        }
        .onAppear { restoreUnresolvedAttempt() }
    }
    @MainActor private func prepare() async {
        guard model.user?.canManageDues == true else { return }
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
    private var effectiveDate:String {
        let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.dateFormat="yyyy-MM-dd"
        return formatter.string(from:date)
    }
    private var signedAmountCents:Int? {
        guard let dollars=Double(amount),dollars>0 else{return nil}
        let cents=Int((dollars*100).rounded())
        return ["refund","chargeback"].contains(type) ? -cents : cents
    }
    private var intentFingerprint:String {
        [String(rosterId ?? 0),type,String(signedAmountCents ?? 0),effectiveDate,method.trimmingCharacters(in:.whitespacesAndNewlines),reference.trimmingCharacters(in:.whitespacesAndNewlines),note.trimmingCharacters(in:.whitespacesAndNewlines)].joined(separator:"\u{1F}")
    }
    private func paymentMatchesIntent(_ payment:DuesPayment)->Bool {
        payment.campaign == "manual" && payment.reversesAdjustmentId == nil
            && payment.transactionType == type && payment.amountCents == signedAmountCents
            && payment.dateISO == effectiveDate && payment.paymentMethod == method.trimmingCharacters(in:.whitespacesAndNewlines)
            && (payment.sourceReference ?? "") == reference.trimmingCharacters(in:.whitespacesAndNewlines)
    }
    @MainActor private func verifiedResult(_ id:Int)->Bool {
        guard model.duesError == nil,let current=model.dues?.rows.first(where:{$0.rosterId==rosterId}) else{return false}
        return current.payments.contains{$0.adjustmentId==id && paymentMatchesIntent($0)}
    }
    @MainActor private func rememberAttempt() {
        guard let accountId=model.user?.id,let rosterId else{return}
        DuesPendingAttemptStore.byAccount[accountId]=DuesPendingAttempt(
            submissionId:clientSubmissionId,rosterId:rosterId,transactionType:type,amount:amount,
            effectiveDate:effectiveDate,paymentMethod:method,sourceReference:reference,note:note,
            baselineAdjustmentIds:baselineAdjustmentIds,resultId:pendingResultId)
    }
    @MainActor private func clearAttempt() {
        guard let accountId=model.user?.id else{return}
        DuesPendingAttemptStore.byAccount[accountId]=nil
    }
    @MainActor private func restoreUnresolvedAttempt() {
        guard let accountId=model.user?.id,let pending=DuesPendingAttemptStore.byAccount[accountId] else{return}
        clientSubmissionId=pending.submissionId
        rosterId=pending.rosterId;type=pending.transactionType;amount=pending.amount
        method=pending.paymentMethod;reference=pending.sourceReference;note=pending.note
        let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.dateFormat="yyyy-MM-dd"
        if let restoredDate=formatter.date(from:pending.effectiveDate){date=restoredDate}
        baselineAdjustmentIds=pending.baselineAdjustmentIds
        pendingResultId=pending.resultId
        attemptedFingerprint=intentFingerprint
        uncertain=true;messageIsError=true
        message="This entry was not verified before the form closed. Select Check Ledger before any retry."
    }
    @MainActor private func save() async {
        guard model.user?.canManageDues == true,let rosterId,!uncertain else{return}
        let fingerprint=intentFingerprint
        if let previous=attemptedFingerprint,previous != fingerprint {
            clientSubmissionId=UUID().uuidString
            pendingResultId=nil
        }
        if attemptedFingerprint != fingerprint {
            baselineAdjustmentIds=Set(model.dues?.rows.first(where:{$0.rosterId==rosterId})?.payments.compactMap(\.adjustmentId) ?? [])
        }
        attemptedFingerprint=fingerprint
        rememberAttempt()
        working=true;defer{working=false}
        do {
            let draft=DuesAdjustmentDraft(rosterId:rosterId,transactionType:type,amount:amount,effectiveDate:effectiveDate,paymentMethod:method,sourceReference:reference,note:note,clientSubmissionId:clientSubmissionId)
            let result:DuesAdjustmentResult=try await model.request("/api/dues/adjustments",method:"POST",body:JSONEncoder().encode(draft))
            pendingResultId=result.id
            rememberAttempt()
            await saved()
            if verifiedResult(result.id) {
                clearAttempt()
                clientSubmissionId=UUID().uuidString
                dismiss()
            } else {
                uncertain=true
                messageIsError=true
                message="The service accepted this entry, but the ledger readback is incomplete. Select Check Ledger before any retry."
            }
        } catch ClientError.rejected(let detail) {
            clearAttempt()
            attemptedFingerprint=nil
            uncertain=false
            messageIsError=true
            message="The entry was not accepted: \(detail) Correct the details and try again."
        } catch {
            uncertain=true
            messageIsError=true
            message="The submission status is uncertain: \(error.localizedDescription) Select Check Ledger before any retry."
        }
    }
    @MainActor private func checkLedger() async {
        guard uncertain,!checkingLedger else{return}
        checkingLedger=true;defer{checkingLedger=false}
        await model.loadDues()
        guard model.duesError == nil,let current=model.dues?.rows.first(where:{$0.rosterId==rosterId}) else {
            messageIsError=true
            message="The ledger could not be checked. Do not submit another entry yet."
            return
        }
        if let id=pendingResultId,verifiedResult(id) {
            clearAttempt()
            clientSubmissionId=UUID().uuidString
            dismiss()
            return
        }
        if current.payments.contains(where:{$0.adjustmentId.map{!baselineAdjustmentIds.contains($0)} == true && paymentMatchesIntent($0)}) {
            messageIsError=true
            message="A matching entry now appears in Payment Activity. Close this form and review that entry before creating anything else."
            return
        }
        uncertain=false
        messageIsError=false
        message="No matching entry appears in the refreshed ledger. A retry will use the same submission ID so the service cannot record this attempt twice."
    }
}

private struct MemberInviteDraft:Encodable{let email:String;let sendEmail:Bool}
struct MemberAccessView: View {
    @EnvironmentObject var model: AppModel
    @State private var members: [MemberAccessRecord] = []
    @State private var message = ""
    @State private var loading = true
    @State private var invitingMemberID: Int?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                NativeWorkspaceHeader(title: "Member Access", subtitle: "Roster-linked Brother accounts", symbol: "person.3.fill") {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                        .disabled(loading)
                }
                .padding(.horizontal, -22)
                if loading { ProgressView("Checking roster links and account status…") }
                if !message.isEmpty { Text(message).font(.caption).foregroundStyle(.secondary) }
                if !loading && members.isEmpty && message.isEmpty {
                    Text("No roster records are available.").foregroundStyle(.secondary)
                }
                ForEach(members) { member in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(member.displayName).fontWeight(.semibold)
                            Text(member.userId != nil
                                 ? "Active account · \(member.accountEmail ?? "")"
                                 : member.invitationId != nil
                                    ? "Invitation pending · \(member.invitationEmail ?? "")"
                                    : member.emails.isEmpty
                                        ? "Email review needed"
                                        : member.emails.joined(separator: ", "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if member.userId == nil && member.invitationId == nil && !member.emails.isEmpty {
                            Button("Create invitation") { Task { await invite(member) } }
                                .disabled(loading || invitingMemberID != nil)
                        }
                    }
                    .padding(14)
                    .background(Color.primary.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(28)
        }
        .task { await load() }
    }

    @MainActor private func load() async {
        loading = true
        message = "Checking roster links and account status…"
        defer { loading = false }
        do {
            let result: MemberAccessResponse = try await model.request("/api/admin/member-access")
            members = result.members
            message = "\(members.count) roster records checked. Invitations are not emailed until you distribute them."
        } catch {
            members = []
            message = "Member access could not load: \(error.localizedDescription)"
        }
    }

    @MainActor private func invite(_ member: MemberAccessRecord) async {
        guard invitingMemberID == nil, let email = member.emails.first else { return }
        invitingMemberID = member.id
        defer { invitingMemberID = nil }
        do {
            let data = try JSONEncoder().encode(MemberInviteDraft(email: email, sendEmail: false))
            let result: InviteResponse = try await model.request("/api/admin/member-access/\(member.id)/invite", method: "POST", body: data)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(result.inviteUrl, forType: .string)
            await load()
            message = "Invitation created for \(member.displayName). The private link was copied."
        } catch {
            message = "Invitation could not be created: \(error.localizedDescription)"
        }
    }
}
