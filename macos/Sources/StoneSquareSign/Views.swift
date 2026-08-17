import AppKit
import SwiftUI
import PDFKit
import UniformTypeIdentifiers
import WebKit

enum SignTheme {
    static let navy = Color(red: 0.03, green: 0.11, blue: 0.19)
    static let blue = Color(red: 0.05, green: 0.24, blue: 0.39)
    static let gold = Color(red: 0.78, green: 0.60, blue: 0.26)
    static let ivory = Color(red: 0.96, green: 0.94, blue: 0.89)
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
            if model.user == nil { AuthenticationView() }
            else { WorkspaceView() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .bottom) {
            if !model.message.isEmpty {
                Label(
                    model.message,
                    systemImage: model.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
                )
                .font(.callout.weight(.semibold))
                .foregroundStyle(model.isError ? .red : .green)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .shadow(radius: 12)
                .padding(.bottom, 18)
            }
        }
        .overlay(alignment: .top) {
            if let version = model.availableUpdateVersion {
                HStack(spacing: 16) {
                    Image(systemName: "arrow.down.circle.fill").foregroundStyle(SignTheme.gold)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Stone Square Sign update available").font(.headline)
                        Text("Version \(version) is ready.").font(.caption).foregroundStyle(.secondary)
                    }
                    Button("Dismiss") { model.dismissAvailableUpdate() }
                        .buttonStyle(.bordered).tint(SignTheme.navy)
                }
                .padding(13)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .shadow(radius: 18)
                .padding(.top, 14)
            }
        }
        .task {
            await model.restoreSession()
            model.startUpdateChecks()
        }
        .onChange(of: model.user) { _, user in
            showRequiredSignature = user?.hasSignature == false && user?.role != "viewer"
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
              (user.hasSignature || user.role == "viewer"),
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
        GeometryReader { geometry in
            HStack(spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                LinearGradient(
                    colors: [SignTheme.navy, SignTheme.blue],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                Circle()
                    .fill(SignTheme.gold.opacity(0.16))
                    .frame(width: 420)
                    .offset(x: 240, y: -190)
                VStack(alignment: .leading, spacing: 24) {
                    Text("STONE SQUARE 22")
                        .font(.caption.weight(.bold))
                        .tracking(3)
                        .foregroundStyle(SignTheme.gold)
                    Text("Documents move.\nRecords remain.")
                        .font(.system(size: 54, weight: .medium, design: .serif))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                        .minimumScaleFactor(0.72)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("A private signing desk for Lodge officers and retained records.")
                        .font(.title3)
                        .foregroundStyle(.white.opacity(0.68))
                        .frame(maxWidth: 460, alignment: .leading)
                    HStack(spacing: 28) {
                        LoginStep(number: "01", text: "Upload")
                        LoginStep(number: "02", text: "Identify")
                        LoginStep(number: "03", text: "Sign")
                    }
                    .padding(.top, 32)
                }
                .padding(58)
            }
            .frame(minWidth: 560, maxHeight: .infinity)

            VStack(spacing: 26) {
                Picker("Access", selection: $mode) {
                    Text("Sign in").tag(0)
                    Text("Owner setup").tag(1)
                    Text("Reset").tag(2)
                }
                .pickerStyle(.segmented)

                VStack(alignment: .leading, spacing: 14) {
                    Text(mode == 0 ? "Sign in to continue" : mode == 1 ? "Create owner account" : "Reset by email")
                        .font(.system(size: 30, weight: .semibold, design: .serif))
                        .foregroundStyle(SignTheme.navy)
                    if mode == 0 && model.biometricLoginEnabled {
                        Button {
                            Task { await model.signInWithBiometrics() }
                        } label: {
                            Label("Sign in with Touch ID", systemImage: "touchid")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(SignTheme.navy)
                        .controlSize(.large)
                        .disabled(model.isBusy)
                        HStack { Rectangle().frame(height: 1); Text("or use password"); Rectangle().frame(height: 1) }
                            .foregroundStyle(.tertiary)
                            .font(.caption)
                    }
                    if mode == 1 { TextField("Full name", text: $name).textContentType(.name) }
                    TextField("Email address", text: $email).textContentType(.emailAddress)
                    if mode == 2 {
                        TextField("Six digit code", text: $code)
                        SecureField("New password", text: $password)
                    } else {
                        SecureField(mode == 1 ? "Create password" : "Password", text: $password)
                    }
                    Button(action: submit) {
                        HStack {
                            Spacer()
                            if model.isBusy { ProgressView().controlSize(.small) }
                            Text(buttonTitle)
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(SignTheme.navy)
                    .controlSize(.large)
                    .disabled(model.isBusy)
                    if mode == 2 {
                        Button("Send reset code") {
                            Task { await model.requestReset(email: email) }
                        }
                        .buttonStyle(.link)
                    }
                    Divider().padding(.vertical, 4)
                    TextField("Signing service address", text: $model.serverAddress)
                        .font(.caption)
                        .textFieldStyle(.roundedBorder)
                    Text("Defaults to the hosted Lodge service at \(defaultServerAddress). Only change this if you are running a server on this Mac for development.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 420)
            .padding(54)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
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

struct LoginStep: View {
    let number: String
    let text: String
    var body: some View {
        VStack(alignment: .leading) {
            Text(number).foregroundStyle(SignTheme.gold).font(.headline)
            Text(text).foregroundStyle(.white.opacity(0.65)).font(.caption)
        }
        .frame(width: 90, alignment: .leading)
        .padding(.top, 10)
        .overlay(alignment: .top) { Divider().overlay(.white.opacity(0.2)) }
    }
}

struct WorkspaceView: View {
    @EnvironmentObject var model: AppModel
    @State private var selection: AppSection? = .home

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("STONE SQUARE").font(.headline).tracking(1.5)
                    Text("LODGE DASHBOARD").font(.caption2).tracking(2).foregroundStyle(SignTheme.gold)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(22)
                List(selection: $selection) {
                Label("Home", systemImage: "square.grid.2x2.fill").tag(AppSection.home)
                Label("Live Queue", systemImage: "list.number").tag(AppSection.documents)
                Label("Candidate Tracker", systemImage: "person.text.rectangle.fill").tag(AppSection.candidateTracker)
                if model.user?.role == "owner" {
                        Label("Create Dispensation", systemImage: "doc.badge.plus").tag(AppSection.createDispensation)
                        Label("Officer Access", systemImage: "person.badge.key.fill").tag(AppSection.access)
                    }
                    Label("Approvals", systemImage: "checkmark.seal.fill").tag(AppSection.approvals)
                    if model.user?.role == "owner" {
                    }
                    if ["owner", "secretary", "assistant_secretary"].contains(model.user?.role ?? "") {
                        Label("Dues", systemImage: "dollarsign.circle.fill").tag(AppSection.dues)
                    }
                    Label("Signature Profile", systemImage: "signature").tag(AppSection.profile)
                    Label("Service Settings", systemImage: "network").tag(AppSection.settings)
                }
                .scrollContentBackground(.hidden)
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
                    Button("Sign out") { model.signOut() }.buttonStyle(.link).padding(.top, 5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .background(SignTheme.navy.opacity(0.055))
        } detail: {
            switch selection {
            case .home:
                LandingDashboardView(
                    openDispensations: { selection = .documents },
                    openCandidateTracker: { selection = .candidateTracker }
                )
            case .candidateTracker:
                NativeCandidateTrackerView()
            case .createDispensation: DispensationBuilderView()
            case .access: OfficerAccessView()
            case .dues: DuesView()
            case .approvals: ApprovalsView()
            case .profile: SignatureProfileView()
            case .settings: SettingsView()
            default: DocumentsView()
            }
        }
        .task { await model.refresh() }
        .onChange(of: model.requestedSection) { _, requested in
            guard let requested else { return }
            selection = requested
            model.requestedSection = nil
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

    private let trackerGreen = Color(red: 14 / 255, green: 75 / 255, blue: 53 / 255)
    private let trackerGreenLight = Color(red: 28 / 255, green: 102 / 255, blue: 76 / 255)
    private let trackerGold = Color(red: 196 / 255, green: 154 / 255, blue: 67 / 255)
    private let trackerPaper = Color(red: 247 / 255, green: 246 / 255, blue: 241 / 255)
    private let trackerLine = Color(red: 220 / 255, green: 226 / 255, blue: 221 / 255)

    private var canEdit: Bool {
        model.user?.role == "owner"
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

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 20) {
                trackerHeader
                welcomePanel
                overviewPanel
                categoryTabs
                workspacePanel
            }
            .frame(maxWidth: 1180)
            .padding(.horizontal, 24)
            .padding(.vertical, 22)
            .frame(maxWidth: .infinity)
        }
        .background(trackerPaper.ignoresSafeArea())
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

    private var trackerHeader: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 13).fill(trackerGreen)
                RoundedRectangle(cornerRadius: 13).stroke(trackerGold.opacity(0.7), lineWidth: 2)
                Text("22").font(.title3.weight(.heavy)).foregroundStyle(.white)
            }
            .frame(width: 48, height: 48)

            VStack(alignment: .leading, spacing: 3) {
                Text("STONE SQUARE LODGE NO. 22")
                    .font(.caption2.weight(.bold)).tracking(1.6).foregroundStyle(trackerGreenLight)
                Text("Candidate & Membership Tracker")
                    .font(.title3.weight(.bold)).foregroundStyle(SignTheme.navy)
            }
            Spacer()
            Label("Restricted", systemImage: "lock.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(trackerGreen)
                .padding(.horizontal, 11).padding(.vertical, 8)
                .background(Color(red: 233 / 255, green: 244 / 255, blue: 238 / 255), in: Capsule())
            VStack(alignment: .trailing, spacing: 2) {
                Text(model.user?.name ?? "Lodge Officer").font(.caption.weight(.bold))
                Text(model.user?.email ?? "").font(.caption2).foregroundStyle(.secondary)
            }
            Button {
                Task { await model.loadCandidateRecords() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .help("Refresh Candidate Tracker")
        }
        .padding(18)
        .background(.white, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(trackerLine))
    }

    private var welcomePanel: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 28) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("WELCOME")
                        .font(.caption2.weight(.bold)).tracking(1.8).foregroundStyle(trackerGreenLight)
                    Text("\(greeting(for: context.date)), \(model.user?.name ?? "Lodge Officer").")
                        .font(.system(size: 31, weight: .medium, design: .serif))
                        .foregroundStyle(SignTheme.navy)
                }
                Spacer()
                VStack(alignment: .leading, spacing: 5) {
                    Text("CURRENT DATE AND TIME")
                        .font(.caption2.weight(.bold)).tracking(1.2).foregroundStyle(.secondary)
                    Text(Self.longDateFormatter.string(from: context.date))
                        .font(.callout.weight(.semibold))
                    Text(Self.timeFormatter.string(from: context.date))
                        .font(.title3.weight(.bold)).foregroundStyle(trackerGreenLight)
                        .monospacedDigit()
                }
                .padding(.horizontal, 20).padding(.vertical, 14)
                .background(.white.opacity(0.74), in: RoundedRectangle(cornerRadius: 15))
                .overlay(RoundedRectangle(cornerRadius: 15).stroke(trackerGreen.opacity(0.12)))
            }
            .padding(26)
            .background(
                LinearGradient(
                    colors: [Color(red: 1, green: 253 / 255, blue: 247 / 255), Color(red: 248 / 255, green: 241 / 255, blue: 223 / 255)],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: RoundedRectangle(cornerRadius: 22)
            )
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(trackerGold.opacity(0.35)))
        }
    }

    private var overviewPanel: some View {
        HStack(spacing: 34) {
            VStack(alignment: .leading, spacing: 10) {
                Text("WORKING ROSTER · 2026 TO 2027")
                    .font(.caption2.weight(.bold)).tracking(1.7).foregroundStyle(trackerGold)
                Text("Keep every man moving forward.")
                    .font(.system(size: 38, weight: .medium, design: .serif))
                    .foregroundStyle(.white)
                Text("One secure place for apprentices, prospects, demits, reclamations, and healing requests.")
                    .font(.callout).foregroundStyle(.white.opacity(0.82)).lineSpacing(4)
            }
            Spacer(minLength: 24)
            HStack(spacing: 10) {
                trackerStat(title: "TOTAL RECORDS", value: model.candidateRecords.count, attention: false)
                trackerStat(title: "NEEDS ATTENTION", value: attentionCount, attention: true)
                trackerStat(title: "ASSIGNED", value: assignedCount, attention: false)
            }
        }
        .padding(32)
        .background(
            LinearGradient(colors: [trackerGreen, Color(red: 23 / 255, green: 61 / 255, blue: 48 / 255)], startPoint: .leading, endPoint: .trailing),
            in: RoundedRectangle(cornerRadius: 24)
        )
        .overlay(alignment: .bottomTrailing) {
            Text("22").font(.system(size: 150, weight: .black)).foregroundStyle(.white.opacity(0.035)).offset(x: 4, y: 42)
        }
    }

    private var categoryTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(categories, id: \.self) { item in
                    Button {
                        category = item
                        statusFilter = "All statuses"
                    } label: {
                        HStack(spacing: 9) {
                            Text(shortCategory(item)).font(.caption.weight(.bold))
                            Text("\(model.candidateRecords.filter { $0.category == item }.count)")
                                .font(.caption2.weight(.bold))
                                .frame(minWidth: 21, minHeight: 21)
                                .background(category == item ? .white.opacity(0.18) : trackerPaper, in: Capsule())
                        }
                        .foregroundStyle(category == item ? .white : .secondary)
                        .padding(.horizontal, 13).padding(.vertical, 11)
                        .background(category == item ? trackerGreen : .white, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(category == item ? trackerGreen : trackerLine))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var workspacePanel: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(category)
                        .font(.system(size: 30, weight: .medium, design: .serif)).foregroundStyle(SignTheme.navy)
                    Text(categoryDescriptions[category] ?? "Candidate and membership records")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if canEdit {
                    Button {
                        editingRecord = .blank(category: category)
                        creatingRecord = true
                    } label: {
                        Label("Add record", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent).tint(trackerGreen)
                }
            }
            Divider()

            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search names, contact details, status, or notes", text: $query)
                        .textFieldStyle(.plain)
                }
                .padding(.horizontal, 12).frame(height: 42)
                .background(.white, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(trackerLine))

                Picker("Owner", selection: $ownerFilter) {
                    ForEach(ownerOptions, id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden().frame(width: 185)

                Picker("Status", selection: $statusFilter) {
                    ForEach(statusOptions, id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden().frame(width: 210)

                Button("Clear") {
                    query = ""
                    ownerFilter = "All owners"
                    statusFilter = "All statuses"
                }
                .buttonStyle(.bordered)
            }

            if model.candidateTrackerLoading && model.candidateRecords.isEmpty {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading Candidate Tracker...").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 180)
            } else if filteredRecords.isEmpty {
                ContentUnavailableView(
                    query.isEmpty ? "No records in this section" : "No matching records",
                    systemImage: "person.text.rectangle",
                    description: Text(query.isEmpty ? "Choose another section or add a record." : "Try a different name, status, owner, or next step.")
                )
                .frame(maxWidth: .infinity, minHeight: 180)
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(filteredRecords) { record in
                        recordCard(record)
                    }
                }
            }
        }
        .padding(28)
        .background(.white, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(trackerLine))
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
                .background(Color(red: 252 / 255, green: 250 / 255, blue: 244 / 255))
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
        .background(.white, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(trackerLine))
    }

    private func trackerStat(title: String, value: Int, attention: Bool) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.caption2.weight(.bold)).foregroundStyle(.white.opacity(0.78))
            Text("\(value)").font(.system(size: 28, weight: .bold)).foregroundStyle(.white)
        }
        .padding(16).frame(width: 116, height: 106, alignment: .leading)
        .background(attention ? trackerGold.opacity(0.23) : .white.opacity(0.08), in: RoundedRectangle(cornerRadius: 15))
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(attention ? trackerGold.opacity(0.55) : .white.opacity(0.14)))
    }

    private func trackerDetail(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption2.weight(.bold)).tracking(0.9).foregroundStyle(.secondary)
            Text(value).font(.caption.weight(.semibold)).lineLimit(2)
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

    private func shortCategory(_ value: String) -> String {
        switch value {
        case "Entered Apprentices": return "EAs"
        case "Degree History": return "History"
        case "Website & Social Media Contacts": return "Web / Social"
        case "Demits In": return "Demits"
        default: return value
        }
    }

    private func greeting(for date: Date) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case 0..<12: return "Good morning"
        case 12..<18: return "Good afternoon"
        default: return "Good evening"
        }
    }

    private static let longDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE, MMMM d, yyyy"
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .medium
        return formatter
    }()
}

struct CandidateRecordEditorView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State var record: CandidateRecord
    let isNew: Bool
    let categories: [String]

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
                        .font(.system(size: 30, weight: .semibold, design: .serif))
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
                Button("Cancel", role: .cancel) { dismiss() }
                Spacer()
                Button(isNew ? "Add record" : "Save changes") {
                    Task {
                        if await model.saveCandidateRecord(record, isNew: isNew) { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                .disabled(record.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.candidateTrackerLoading)
            }
            .padding(20)
        }
        .frame(minWidth: 720, minHeight: 720)
    }
}

struct CandidateTrackerView: View {
    @EnvironmentObject var model: AppModel
    @State private var signInURL: URL?
    @State private var isLoading = true

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("CANDIDATE MANAGEMENT")
                        .font(.caption2.weight(.bold))
                        .tracking(2)
                        .foregroundStyle(SignTheme.gold)
                    Text("Candidate Tracker")
                        .font(.system(size: 32, weight: .semibold, design: .serif))
                        .foregroundStyle(SignTheme.navy)
                    Text("Secure tracker access remains inside Stone Square Sign.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Label("Secure connection", systemImage: "lock.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.green)
            }
            .padding(24)
            .background(SignTheme.ivory.opacity(0.5))
            Divider()
            if let signInURL {
                EmbeddedCandidateTracker(url: signInURL)
            } else if isLoading {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Opening Candidate Tracker securely...")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "exclamationmark.lock.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(SignTheme.gold)
                    Text("Candidate Tracker could not be opened.")
                        .font(.headline)
                    Text(model.message.isEmpty ? "Check the signing service connection and try again." : model.message)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Try again") {
                        Task { await openTracker() }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(30)
            }
        }
        .task {
            if signInURL == nil {
                await openTracker()
            }
        }
    }

    private func openTracker() async {
        isLoading = true
        signInURL = await model.candidateTrackerSignInURL()
        isLoading = false
    }
}

struct EmbeddedCandidateTracker: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = context.coordinator
        webView.navigationDelegate = context.coordinator
        webView.allowsMagnification = true
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        if webView.url == nil && !webView.isLoading {
            webView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                webView.load(URLRequest(url: url))
            }
            return nil
        }
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
                VStack(alignment: .leading, spacing: 6) {
                    Text("OFFICIAL GRAND LODGE TEMPLATE")
                        .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
                    Text("Create a dispensation")
                        .font(.system(size: 40, weight: .semibold, design: .serif))
                        .foregroundStyle(SignTheme.navy)
                    Text(step == 0 ? "Paste the event information to begin." : step == 1 ? "Answer only the remaining Lodge questions." : "Review the summary and actual PDF before sending it for signature.")
                        .foregroundStyle(.secondary)
                }
                Text("STEP \(step + 1) OF 3")
                    .font(.caption2.weight(.bold)).tracking(1.5).foregroundStyle(SignTheme.gold)
                HStack(spacing: 30) {
                    Label("Stone Square Lodge No. 22", systemImage: "building.columns.fill")
                    Label(model.user?.name ?? "Worshipful Master", systemImage: "signature")
                }
                .font(.headline).foregroundStyle(SignTheme.navy)
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                .background(.white, in: RoundedRectangle(cornerRadius: 12))

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
                            .background(.white, in: RoundedRectangle(cornerRadius: 8))
                            .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator) }
                        Button("Read and review pasted details", systemImage: "text.magnifyingglass") { parsePastedDetails() }
                            .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                            .disabled(model.isBusy || pastedDetails.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .padding(20)
                    .background(SignTheme.gold.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                } else if step == 1 {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Remaining questions")
                            .font(.system(size: 28, weight: .semibold, design: .serif)).foregroundStyle(SignTheme.navy)
                        Text("The event information you approved is already saved. The officer will enter their own name and address when signing.")
                            .foregroundStyle(.secondary)
                        Form {
                            Section("Who should sign for the secretary's office?") {
                                Picker("Send to", selection: $signerChoice) {
                                    Text("Both Secretaries, whoever signs first").tag("both")
                                    Text("William McDuffie, Secretary").tag("secretary")
                                    Text("Adrian Reese, Assistant Secretary").tag("assistant_secretary")
                                }
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
                                .buttonStyle(.borderedProminent).tint(SignTheme.navy).controlSize(.large)
                                .disabled(model.isBusy || !personalInfoConfirmed || worshipfulMasterAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    .padding(22)
                    .background(.white, in: RoundedRectangle(cornerRadius: 12))
                } else {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Final review")
                            .font(.system(size: 28, weight: .semibold, design: .serif)).foregroundStyle(SignTheme.navy)
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
                                .background(.white, in: RoundedRectangle(cornerRadius: 10))
                                .overlay { RoundedRectangle(cornerRadius: 10).stroke(.separator) }
                        }
                        HStack {
                            Button("Back to remaining questions") { step = 1 }
                            Spacer()
                            Button("Send for officer signature", systemImage: "paperplane.fill") { create() }
                                .buttonStyle(.borderedProminent).tint(SignTheme.navy).controlSize(.large)
                                .disabled(model.isBusy || previewDocument == nil)
                        }
                    }
                    .padding(22)
                    .background(.white, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(38)
        }
        .background(SignTheme.ivory.opacity(0.45))
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
        signerChoice = fields.signerRole == "assistant_secretary" ? "assistant_secretary" : "both"
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
    @State private var pulse = false

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
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("STONE SQUARE DOCUMENT CENTER")
                        .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
                    Text("\(easternGreeting), \(model.user?.name ?? "")")
                        .font(.system(size: 44, weight: .semibold, design: .serif)).foregroundStyle(SignTheme.navy)
                    Text("Choose the Lodge document area you want to open.")
                        .font(.title3).foregroundStyle(.secondary)
                    Text(model.user?.roleLabel ?? "")
                        .font(.caption.weight(.bold)).foregroundStyle(SignTheme.blue)
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 18)], spacing: 18) {
                    Button(action: openDispensations) {
                        LandingDocumentCard(
                            title: "Dispensations",
                            description: awaitingCount > 0
                                ? "\(awaitingCount) document\(awaitingCount == 1 ? "" : "s") awaiting action"
                                : "Open the dispensation queue",
                            systemImage: "doc.text.fill",
                            comingSoon: false,
                            awaiting: awaitingCount > 0,
                            pulse: pulse
                        )
                    }
                    .buttonStyle(.plain)
                    LandingDocumentCard(
                        title: "Previous Lodge Meeting Minutes",
                        description: "Coming soon",
                        systemImage: "books.vertical.fill",
                        comingSoon: true,
                        awaiting: false,
                        pulse: false
                    )
                    LandingDocumentCard(
                        title: "Treasurer Reports",
                        description: "Coming soon",
                        systemImage: "chart.bar.doc.horizontal.fill",
                        comingSoon: true,
                        awaiting: false,
                        pulse: false
                    )
                Button(action: openCandidateTracker) {
                    LandingDocumentCard(
                        title: "Candidate Tracker",
                        description: "Open the Candidate Tracker",
                            systemImage: "person.text.rectangle.fill",
                            comingSoon: false,
                            awaiting: false,
                            pulse: false
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(42)
        }
        .background(
            ZStack {
                SignTheme.ivory.opacity(0.42)
                Circle().fill(SignTheme.gold.opacity(0.07)).frame(width: 520).offset(x: 390, y: -270)
            }
        )
        .onAppear {
            withAnimation(.easeInOut(duration: 1.15).repeatForever(autoreverses: true)) { pulse = true }
        }
    }
}

struct LandingDocumentCard: View {
    let title: String
    let description: String
    let systemImage: String
    let comingSoon: Bool
    let awaiting: Bool
    let pulse: Bool

    var body: some View {
        HStack(spacing: 20) {
            Image(systemName: systemImage)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(comingSoon ? Color.secondary : awaiting ? Color.white : SignTheme.gold)
                .frame(width: 62, height: 62)
                .background(comingSoon ? Color.gray.opacity(0.12) : awaiting ? SignTheme.blue : SignTheme.navy, in: RoundedRectangle(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 7) {
                Text(title).font(.title3.weight(.bold)).foregroundStyle(comingSoon ? Color.secondary : SignTheme.navy)
                Text(description).font(.callout).foregroundStyle(awaiting ? SignTheme.blue : Color.secondary)
            }
            Spacer()
            if comingSoon {
                Text("COMING SOON").font(.caption2.weight(.bold)).tracking(1).foregroundStyle(.secondary)
            } else {
                Image(systemName: "chevron.right").font(.headline).foregroundStyle(awaiting ? SignTheme.blue : Color.secondary)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: 132, alignment: .leading)
        .background(comingSoon ? Color.gray.opacity(0.07) : Color.white, in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(awaiting ? SignTheme.blue.opacity(pulse ? 1 : 0.35) : Color.gray.opacity(0.2), lineWidth: awaiting ? 3 : 1)
        }
        .shadow(color: awaiting ? SignTheme.blue.opacity(pulse ? 0.25 : 0.05) : .clear, radius: 18)
        .scaleEffect(awaiting && pulse ? 1.012 : 1)
        .opacity(comingSoon ? 0.68 : 1)
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
                .font(.system(size: 30, weight: .semibold, design: .serif)).foregroundStyle(SignTheme.navy)
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
                    .buttonStyle(.borderedProminent).tint(SignTheme.navy)
            }
        }
        .padding(30)
        .frame(width: 640)
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
                .font(.system(size: 30, weight: .semibold, design: .serif)).foregroundStyle(SignTheme.navy)
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
                    .buttonStyle(.borderedProminent).tint(SignTheme.navy)
            }
        }
        .padding(30)
        .frame(width: 680)
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
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("REAL TIME SIGNING QUEUE")
                            .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
                        Text("Dispensation desk")
                            .font(.system(size: 40, weight: .semibold, design: .serif))
                            .foregroundStyle(SignTheme.navy)
                        Text("New requests and signatures load automatically.").foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.user?.role == "owner" {
                        Button("Upload Dispensation", systemImage: "arrow.up.doc.fill") {
                            showImporter = true
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(SignTheme.navy)
                        .controlSize(.large)
                    }
                }
                HStack(spacing: 16) {
                    MetricBox(label: "All records", value: model.documents.count)
                    MetricBox(label: "Awaiting signatures", value: model.documents.filter { !$0.isTerminal }.count)
                    MetricBox(label: "Completed", value: model.documents.filter(\.isComplete).count)
                }
                VStack(spacing: 0) {
                    if model.documents.isEmpty {
                        ContentUnavailableView(
                            "The queue is clear",
                            systemImage: "checkmark.seal",
                            description: Text("New dispensations will appear here automatically.")
                        )
                        .frame(minHeight: 320)
                    } else {
                        ForEach(Array(model.documents.enumerated()), id: \.element.id) { index, document in
                            DocumentRow(
                                document: document,
                                queueNumber: document.isTerminal ? nil : index + 1,
                                open: { viewingDocument = document },
                                sign: { signingDocument = document }
                            )
                            if document.id != model.documents.last?.id { Divider() }
                        }
                    }
                }
                .padding(20)
                .background(.background, in: RoundedRectangle(cornerRadius: 14))
                .overlay { RoundedRectangle(cornerRadius: 14).stroke(.separator.opacity(0.5)) }
            }
            .padding(36)
        }
        .background(SignTheme.ivory.opacity(0.45))
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
            Text("\(value)").font(.system(size: 30, weight: .medium, design: .serif)).foregroundStyle(SignTheme.navy)
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(.separator.opacity(0.45)) }
    }
}

struct DocumentRow: View {
    @EnvironmentObject var model: AppModel
    let document: LodgeDocument
    let queueNumber: Int?
    let open: () -> Void
    let sign: () -> Void

    private var onlyOneSecretary: Bool {
        let roles = Set(document.signers.map(\.signerRole))
        return roles.contains("secretary") != roles.contains("assistant_secretary")
    }

    var body: some View {
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
                        Text("Sent to the District Deputy \(sentAt)")
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
                        Task { await model.offerToBothSecretaries(documentId: document.id) }
                    }
                    .buttonStyle(.borderless)
                }
                if document.needsSignature && !document.isTerminal {
                    Button("Review and sign", action: sign)
                        .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                }
                if model.user?.role == "owner" && document.isComplete && document.isDispensation {
                    Button("Draft in my mail app") {
                        Task { await model.draftToDistrictDeputy(document: document) }
                    }
                    .buttonStyle(.borderless)
                    if document.submittedAt == nil {
                        Button("Send to the District Deputy") {
                            Task { await model.submitToDistrictDeputy(documentId: document.id) }
                        }
                        .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                    } else {
                        Button("Send again") {
                            Task {
                                await model.submitToDistrictDeputy(documentId: document.id, resend: true)
                            }
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
        }
        .padding(.vertical, 13)
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
        .frame(minWidth: 920, minHeight: 720)
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Officer access")
                    .font(.system(size: 40, weight: .semibold, design: .serif))
                    .foregroundStyle(SignTheme.navy)
                Text("Create one private invitation for each officer. They choose their own password.")
                    .foregroundStyle(.secondary)
                HStack(spacing: 16) {
                    OfficerCard(
                        name: model.seatName(role: "secretary", fallback: "William McDuffie"),
                        office: "Secretary",
                        state: model.seatState(role: "secretary")
                    )
                    OfficerCard(
                        name: model.seatName(role: "assistant_secretary", fallback: "Adrian Reese"),
                        office: "Assistant Secretary",
                        state: model.seatState(role: "assistant_secretary")
                    )
                }
                Form {
                    Picker("Office", selection: $role) {
                        Text("Secretary").tag("secretary")
                        Text("Assistant Secretary").tag("assistant_secretary")
                        Text("Lodge Viewer").tag("viewer")
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
                    .buttonStyle(.borderedProminent).tint(SignTheme.navy)
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
                                    Text("\(officer.role == "viewer" ? "Lodge Viewer" : officer.role == "secretary" ? "Secretary" : "Assistant Secretary") · \(officer.email)")
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
                            .background(.background, in: RoundedRectangle(cornerRadius: 12))
                            .overlay { RoundedRectangle(cornerRadius: 12).stroke(.separator.opacity(0.4)) }
                        }
                    }
                    .frame(maxWidth: 760, alignment: .leading)
                }
            }
            .padding(38)
        }
        .background(SignTheme.ivory.opacity(0.45))
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
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(.separator.opacity(0.4)) }
    }
}

struct SignatureProfileView: View {
    @EnvironmentObject var model: AppModel
    @State private var showEditor = false
    @State private var image: NSImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Signature profile")
                .font(.system(size: 40, weight: .semibold, design: .serif))
                .foregroundStyle(SignTheme.navy)
            Text("This saved signature is applied only after you review a document and confirm consent.")
                .foregroundStyle(.secondary)
            Group {
                if let image { Image(nsImage: image).resizable().scaledToFit().padding(24) }
                else { ContentUnavailableView("No signature saved", systemImage: "signature") }
            }
            .frame(maxWidth: 680, minHeight: 210)
            .background(.white, in: RoundedRectangle(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).stroke(.separator.opacity(0.5)) }
            Button(model.user?.hasSignature == true ? "Change signature" : "Create signature") {
                showEditor = true
            }
            .buttonStyle(.borderedProminent).tint(SignTheme.navy)
            Spacer()
        }
        .padding(38)
        .background(SignTheme.ivory.opacity(0.45))
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
                TextField("Service address", text: $model.serverAddress)
                Text("Use an HTTPS address for officer access. The Mac app and web users must use the same service.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Test and refresh") { Task { await model.refresh() } }
            }
            Section("Touch ID and Keychain") {
                if model.biometricLoginEnabled {
                    Label("Touch ID login is enabled", systemImage: "touchid")
                        .foregroundStyle(.green)
                    Button("Disable Touch ID and Keychain login", role: .destructive) {
                        Task { await model.setBiometricLogin(enabled: false) }
                    }
                    .disabled(model.isBusy)
                } else {
                    Button {
                        Task { await model.setBiometricLogin(enabled: true) }
                    } label: {
                        Label("Enable Touch ID and Keychain login", systemImage: "touchid")
                    }
                    .disabled(model.isBusy || !model.biometricLoginAvailable)
                }
                Text(model.biometricLoginAvailable
                     ? "Your session is stored in your Mac Keychain and opens only after Touch ID. Keychain is accessed only when you choose biometric login."
                     : "Touch ID is not available or is not configured on this Mac.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
    @State private var officerAddress = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("ELECTRONIC SIGNATURE")
                .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
            Text("Sign \(document.displayTitle)")
                .font(.system(size: 30, weight: .semibold, design: .serif))
                .foregroundStyle(SignTheme.navy)
            Text("Review the PDF before applying your saved signature. The action is added to the document audit history.")
                .foregroundStyle(.secondary)
            Group {
                if let signatureImage {
                    Image(nsImage: signatureImage).resizable().scaledToFit().padding(18)
                } else { ProgressView() }
            }
            .frame(maxWidth: .infinity, minHeight: 170)
            .background(.white, in: RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(.gray.opacity(0.4)) }
            Toggle(
                "I agree that this electronic signature represents my signature on this document.",
                isOn: $consent
            )
            TextField("Your address as it should appear on the dispensation", text: $officerAddress)
            Text("Your name and address are added to the secretary section only when you sign.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("View PDF") { showingPDF = true }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Apply saved signature") {
                    Task { if await model.sign(document: document, officerAddress: officerAddress) { dismiss() } }
                }
                .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                .disabled(!consent || signatureImage == nil || officerAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isBusy)
            }
        }
        .padding(30)
        .frame(width: 760)
        .task {
            signatureImage = try? await model.signatureImage()
            officerAddress = model.submissionProfiles.first(where: { $0.role == model.user?.role })?.address ?? ""
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
                .font(.system(size: 30, weight: .semibold, design: .serif))
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
                    .background(.white, in: RoundedRectangle(cornerRadius: 9))
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
                                        .foregroundStyle(.secondary).padding(.horizontal, 9).padding(.bottom, 7)
                                }
                                    .background(.white, in: RoundedRectangle(cornerRadius: 8))
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
                    .buttonStyle(.borderedProminent).tint(SignTheme.navy)
                    .disabled(model.isBusy || (mode == 0 ? paths.isEmpty : signatureInput.trimmingCharacters(in: .whitespaces).isEmpty))
            }
        }
        .padding(30)
        .frame(width: 780)
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
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("RESTRICTED TO THE WORSHIPFUL MASTER AND THE SECRETARIES")
                            .font(.caption2).tracking(1.4).foregroundStyle(.secondary)
                        Text("Dues").font(.largeTitle.weight(.semibold))
                        if let ledger = model.dues {
                            Text("\(ledger.duesYear) dues, \(lodgeMoney(ledger.rateCents)) each, reconciled live against both Zeffy campaigns.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Refresh") { Task { await model.loadDues() } }
                        .disabled(model.duesLoading)
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
                    HStack(spacing: 14) {
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
                VStack(alignment: .leading, spacing: 6) {
                    Text("WHAT THE DISTRICT DEPUTY DECIDED")
                        .font(.caption.weight(.bold)).foregroundStyle(SignTheme.gold).tracking(1.4)
                    Text("Approvals")
                        .font(.system(size: 34, weight: .semibold, design: .serif))
                        .foregroundStyle(SignTheme.navy)
                    Text("Every dispensation ruled on, with who granted it, when, and how it was given.")
                        .foregroundStyle(.secondary)
                }
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
                    .background(.background, in: RoundedRectangle(cornerRadius: 14))
                    .overlay { RoundedRectangle(cornerRadius: 14).stroke(.separator.opacity(0.5)) }
                }
            }
            .padding(38)
        }
        .background(SignTheme.ivory.opacity(0.45))
        .task { await model.loadApprovals() }
    }
}
