import AppKit
import SwiftUI

// MARK: - Shared assistant contract

indirect enum AssistantJSON: Codable, Equatable {
    case object([String: AssistantJSON]), array([AssistantJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: AssistantJSON].self) { self = .object(v) }
        else { self = .array(try c.decode([AssistantJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    var formatted: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? String(decoding: encoder.encode(self), as: UTF8.self)) ?? "Unavailable"
    }
}

func assistantStatusLabel(_ status: String) -> String {
    switch status {
    case "awaiting_master_attestation": return "Awaiting your Master review"
    case "awaiting_preparer": return "Awaiting the preparing officer"
    case "personal": return "Your own review required"
    case "completed_personally": return "Completed by you"
    case "uncertain": return "Outcome needs verification"
    default: return status.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

struct AssistantIdentity: Decodable, Identifiable {
    let id: String
    let name: String
    let enabled: Bool
    let expiresAt: String?
    let permissions: [String]
    let createdAt: String?
    let updatedAt: String?
}
struct AssistantCapability: Decodable, Identifiable {
    let id: String
    let label: String
    let group: String
    let mode: String
    let description: String
    let effects: [String]
    var canGrant: Bool { mode == "standing" || mode == "approval" }
    var modeLabel: String {
        switch mode {
        case "standing": return "Granted preparation and reading"
        case "approval": return "Your approval for each change"
        case "personal": return "Your own tap required"
        default: return "Unavailable to Muse"
        }
    }
}
struct AssistantNavigation: Decodable { let section: String; let recordId: String? }
struct AssistantRequest: Decodable, Identifiable {
    let id: String
    let actionId: String
    let title: String
    let method: String
    let path: String
    let body: AssistantJSON?
    let files: [AssistantJSON]?
    let mode: String?
    let status: String
    let fingerprint: String
    let createdAt: String?
    let expiresAt: String?
    let decidedAt: String?
    let decisionNote: String?
    let effects: [String]
    let navigation: AssistantNavigation?
    let receipt: AssistantJSON?
}
struct AssistantAttestation: Decodable, Identifiable {
    let id: String
    let kind: String
    let recordId: String?
    let title: String
    let status: String
    let section: String
    let actionLabel: String
    let attestationText: String
    let consentTextSource: String?
    let reviewGuidance: String?
    let effects: [String]
    let revision: AssistantJSON?
    let requestId: String?
    let ready: Bool
    let reason: String?
}
struct AssistantWorkspacePayload: Decodable {
    let assistant: AssistantIdentity?
    let capabilities: [AssistantCapability]
    let requests: [AssistantRequest]
    let attestations: [AssistantAttestation]
    let activity: [AssistantJSON]
}
private struct AssistantAccessPayload: Decodable { let assistant: AssistantIdentity }
private struct AssistantTokenPayload: Decodable { let assistant: AssistantIdentity; let token: String }
private struct AssistantRequestPayload: Decodable { let request: AssistantRequest }
private struct AssistantAttestationsPayload: Decodable { let attestations: [AssistantAttestation] }
private struct AssistantOK: Decodable { let ok: Bool }
struct IssuedAssistantToken: Identifiable { let id = UUID(); let value: String }

// Every result belongs to one authenticated account, service and operation. In
// particular, a late token response cannot populate another account's sheet.
@MainActor final class AssistantWorkspace: ObservableObject {
    @Published private(set) var assistant: AssistantIdentity?
    @Published private(set) var capabilities: [AssistantCapability] = []
    @Published private(set) var requests: [AssistantRequest] = []
    @Published private(set) var attestations: [AssistantAttestation] = []
    @Published private(set) var activity: [AssistantJSON] = []
    @Published private(set) var busy = false
    @Published private(set) var loaded = false
    @Published private(set) var revision = 0
    @Published var message = ""
    @Published var issuedToken: IssuedAssistantToken?
    @Published var selectedRequest: AssistantRequest?
    @Published var accessName = "Muse"
    @Published var accessPermissions: Set<String> = []
    @Published var accessDays = 7
    @Published var accessEnabled = true
    private var savedAccessName = "Muse"
    private var savedAccessPermissions: Set<String> = []
    private var savedAccessDays = 7
    private var savedAccessEnabled = true
    var accessDirty: Bool {
        accessName != savedAccessName || accessPermissions != savedAccessPermissions
        || accessDays != savedAccessDays || accessEnabled != savedAccessEnabled
    }
    private weak var model: AppModel?
    private var context = ""
    private var operation: UInt64 = 0

    func configure(_ model: AppModel) {
        self.model = model
        if context != model.assistantAccountContext {
            context = model.assistantAccountContext; operation &+= 1
            assistant = nil; capabilities = []; requests = []; attestations = []; activity = []
            issuedToken = nil; selectedRequest = nil; message = ""; busy = false; loaded = false
            resetAccessForm(nil)
        }
    }
    private func begin(_ model: AppModel) -> (String, UInt64)? {
        configure(model)
        guard model.user?.role == "owner", !busy else { return nil }
        operation &+= 1; busy = true; message = ""
        return (context, operation)
    }
    private func current(_ stamp: (String, UInt64), _ model: AppModel) -> Bool {
        context == stamp.0 && operation == stamp.1 && model.assistantAccountContext == stamp.0 && model.user?.role == "owner"
    }
    private func finish(_ stamp: (String, UInt64), _ model: AppModel) {
        if current(stamp, model) { busy = false }
    }
    func leave() {
        // Ignore late presentation results. An already submitted mutation is
        // still verified from its saved state when this workspace is reopened.
        operation &+= 1; busy = false; issuedToken = nil; selectedRequest = nil
    }
    private func resetAccessForm(_ identity: AssistantIdentity?, days: Int = 7) {
        accessName = identity?.name ?? "Muse"; accessPermissions = Set(identity?.permissions ?? [])
        accessDays = days; accessEnabled = identity?.enabled ?? true
        savedAccessName = accessName; savedAccessPermissions = accessPermissions
        savedAccessDays = accessDays; savedAccessEnabled = accessEnabled
    }
    func load(_ model: AppModel, discardAccessDraft: Bool = false) async {
        guard let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        let preserveAccessDraft = accessDirty && !discardAccessDraft
        do {
            let response: AssistantWorkspacePayload = try await model.request("/api/assistant/workspace")
            guard current(stamp, model) else { return }
            assistant = response.assistant; capabilities = response.capabilities; requests = response.requests
            attestations = response.attestations; activity = response.activity; loaded = true; revision += 1
            if !preserveAccessDraft { resetAccessForm(response.assistant) }
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    func save(_ model: AppModel, name: String, permissions: Set<String>, days: Int, enabled: Bool) async {
        guard (1...30).contains(days), !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            message = "Enter a name and an expiry between 1 and 30 days."; return
        }
        guard let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        do {
            let allowed = Set(capabilities.filter(\.canGrant).map(\.id))
            let body = try JSONSerialization.data(withJSONObject: ["name": name, "permissions": Array(permissions.intersection(allowed)).sorted(), "expiresInDays": days, "enabled": enabled])
            let response: AssistantAccessPayload = try await model.request("/api/assistant/access", method: "PUT", body: body)
            guard current(stamp, model) else { return }
            assistant = response.assistant; revision += 1; message = "Muse access saved. Create a token only when you are ready to connect it."
            resetAccessForm(response.assistant, days: days)
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    func createToken(_ model: AppModel) async {
        guard !accessDirty else { message = "Save or reload your access changes before creating a token."; return }
        guard let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        issuedToken = nil
        do {
            let response: AssistantTokenPayload = try await model.request("/api/assistant/access/token", method: "POST", body: Data("{}".utf8))
            guard current(stamp, model) else { return }
            assistant = response.assistant; issuedToken = IssuedAssistantToken(value: response.token)
            message = "Token created. Connection has not been verified. Any earlier token is now invalid."
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    func revoke(_ model: AppModel) async {
        guard let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        issuedToken = nil
        do {
            let _: AssistantOK = try await model.request("/api/assistant/access", method: "DELETE")
            guard current(stamp, model) else { return }
            assistant = nil; revision += 1; message = "Muse access revoked."
            resetAccessForm(nil)
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    func inspect(_ request: AssistantRequest, model: AppModel) async {
        guard let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        do {
            let response: AssistantRequestPayload = try await model.request("/api/assistant/requests/\(Self.routeID(request.id))")
            guard current(stamp, model) else { return }
            selectedRequest = response.request
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    func canApprove(_ request: AssistantRequest) -> Bool {
        assistant?.enabled == true && request.status == "pending" && (request.mode ?? capabilities.first(where: { $0.id == request.actionId })?.mode) == "approval"
    }
    func isPersonal(_ request: AssistantRequest) -> Bool { (request.mode ?? capabilities.first(where: { $0.id == request.actionId })?.mode) == "personal" }
    private func sameReview(_ a: AssistantAttestation, _ b: AssistantAttestation) -> Bool {
        a.id == b.id && a.kind == b.kind && a.recordId == b.recordId && a.section == b.section
        && a.status == b.status && a.revision == b.revision && a.actionLabel == b.actionLabel
        && a.attestationText == b.attestationText && a.effects == b.effects && a.ready == b.ready
        && a.reason == b.reason && a.reviewGuidance == b.reviewGuidance && a.consentTextSource == b.consentTextSource
    }
    func review(_ item: AssistantAttestation, model: AppModel) async -> AssistantNavigation? {
        guard let stamp = begin(model) else { return nil }
        defer { finish(stamp, model) }
        do {
            let response: AssistantAttestationsPayload = try await model.request("/api/assistant/attestations")
            guard current(stamp, model) else { return nil }
            attestations = response.attestations
            guard let fresh = response.attestations.first(where: { $0.id == item.id }) else {
                message = "This item is no longer in your queue. Close this review to see the current work."; return nil
            }
            guard sameReview(item, fresh) else {
                message = "This record changed. Close this review and read its current wording and effects before opening it."; return nil
            }
            return AssistantNavigation(section: fresh.section, recordId: fresh.recordId)
        } catch { if current(stamp, model) { message = error.localizedDescription }; return nil }
    }
    func reviewPersonalRequest(_ request: AssistantRequest, model: AppModel) async -> AssistantNavigation? {
        guard isPersonal(request), let stamp = begin(model) else { return nil }
        defer { finish(stamp, model) }
        let reviewedItem = attestations.first(where: { $0.requestId == request.id })
        do {
            let response: AssistantRequestPayload = try await model.request("/api/assistant/requests/\(Self.routeID(request.id))")
            guard current(stamp, model) else { return nil }
            let fresh = response.request
            selectedRequest = fresh
            guard fresh.status == "personal", fresh.fingerprint == request.fingerprint, isPersonal(fresh) else {
                message = "This request changed or is no longer waiting for your personal action. Review its current receipt."; return nil
            }
            let queue: AssistantAttestationsPayload = try await model.request("/api/assistant/attestations")
            guard current(stamp, model) else { return nil }
            attestations = queue.attestations
            guard let item = queue.attestations.first(where: { $0.requestId == fresh.id }) else {
                message = "No current personal review is available for this request. Refresh My Attestations."; return nil
            }
            guard let reviewedItem, sameReview(reviewedItem, item) else {
                message = "This personal review changed. Open My Attestations and read its current wording and effects first."; return nil
            }
            return AssistantNavigation(section: item.section, recordId: item.recordId)
        } catch { if current(stamp, model) { message = error.localizedDescription }; return nil }
    }
    func decide(_ request: AssistantRequest, decision: String, note: String, model: AppModel) async {
        guard decision == "decline" || (decision == "approve" && canApprove(request)) else {
            message = "This action requires your review in its own workspace."; return
        }
        guard ["pending", "personal"].contains(request.status), let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["decision": decision, "fingerprint": request.fingerprint, "note": note])
            let response: AssistantRequestPayload = try await model.request("/api/assistant/requests/\(Self.routeID(request.id))/decision", method: "POST", body: body)
            guard current(stamp, model) else { return }
            selectedRequest = response.request
            if let index = requests.firstIndex(where: { $0.id == request.id }) { requests[index] = response.request }
            message = decision == "approve" ? "This exact change was approved. Check its execution receipt before treating it as complete." : "Request declined."
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    static func routeID(_ id: String) -> String { id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? "" }
}

// MARK: - Native views

struct AssistantCorrespondenceRecordsPayload: Decodable { let drafts: [CorrespondenceRecord] }

struct MuseAssistantView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var workspace: AssistantWorkspace
    let openReview: (AssistantNavigation) -> Void
    @State private var confirmingToken = false
    @State private var confirmingRevoke = false
    @State private var confirmingRefresh = false

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Muse Assistant", subtitle: "Choose Muse's access and review proposed changes", symbol: "person.badge.key.fill") {
                Button("Refresh", systemImage: "arrow.clockwise") {
                    if workspace.accessDirty { confirmingRefresh = true }
                    else { Task { await workspace.load(model) } }
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("Muse can prepare and read the work you grant. You review each proposed change that needs approval. Your signatures and personal attestations always remain in your own review screen.")
                        .fixedSize(horizontal: false, vertical: true)
                    accessForm
                    if let assistant = workspace.assistant {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Connection").font(.title3.weight(.semibold))
                            Text("Access \(assistant.enabled ? "enabled" : "disabled"). Expires \(LodgeDateTime.display(assistant.expiresAt)).")
                            Text("Creating a token configures access. It does not establish that Muse is connected.").font(.callout).foregroundStyle(.secondary)
                            ViewThatFits(in: .horizontal) {
                                HStack { tokenButton; revokeButton }
                                VStack(alignment: .leading) { tokenButton; revokeButton }
                            }
                        }.assistantCard()
                    }
                    actionCatalog
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Requests and receipts").font(.title3.weight(.semibold))
                        if workspace.requests.isEmpty { Text(workspace.loaded ? "No assistant requests are recorded." : "Load the workspace to see requests.").foregroundStyle(.secondary) }
                        ForEach(workspace.requests) { request in
                            Button { Task { await workspace.inspect(request, model: model) } } label: {
                                HStack { VStack(alignment: .leading, spacing: 4) { Text(request.title).fontWeight(.medium); Text(assistantStatusLabel(request.status)).font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName: "chevron.right") }
                            }.buttonStyle(.plain).padding(.vertical, 6)
                        }
                    }.assistantCard()
                    if !workspace.activity.isEmpty {
                        DisclosureGroup("Recent activity") {
                            ForEach(Array(workspace.activity.enumerated()), id: \.offset) { _, value in Text(value.formatted).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6) }
                        }.assistantCard()
                    }
                }.padding(24).frame(maxWidth: 1000, alignment: .leading).frame(maxWidth: .infinity)
            }
            AssistantStatus(message: workspace.message)
        }
        .background(SignTheme.page)
        .disabled(workspace.busy)
        .task(id: model.assistantAccountContext) { await workspace.load(model) }
        .onDisappear { workspace.leave() }
        .confirmationDialog("Create a new Muse token?", isPresented: $confirmingToken) {
            Button("Create token") { Task { await workspace.createToken(model) } }
        } message: { Text("Any earlier token stops working immediately. The new token will be shown once.") }
        .confirmationDialog("Revoke Muse access?", isPresented: $confirmingRevoke) {
            Button("Revoke access", role: .destructive) { Task { await workspace.revoke(model) } }
        } message: { Text("Muse will immediately lose access. This does not alter any Lodge record.") }
        .confirmationDialog("Discard unsaved access changes?", isPresented: $confirmingRefresh) {
            Button("Discard and refresh", role: .destructive) { Task { await workspace.load(model, discardAccessDraft: true) } }
        } message: { Text("The saved access settings will replace the edits in this form.") }
        .sheet(item: $workspace.issuedToken) { token in AssistantTokenSheet(token: token.value, close: { workspace.issuedToken = nil }) }
        .sheet(item: $workspace.selectedRequest) { request in
            AssistantRequestSheet(request: request, workspace: workspace, openReview: { navigation in workspace.selectedRequest = nil; openReview(navigation) })
                .environmentObject(model)
        }
    }
    private var tokenButton: some View { Button("Create or rotate token") { confirmingToken = true }.disabled(workspace.accessDirty || !workspace.accessEnabled || workspace.assistant?.enabled != true) }
    private var revokeButton: some View { Button("Revoke access", role: .destructive) { confirmingRevoke = true } }
    private var accessForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Access settings").font(.title3.weight(.semibold))
            TextField("Assistant name", text: $workspace.accessName).textFieldStyle(.roundedBorder)
            Toggle("Enable Muse access", isOn: $workspace.accessEnabled)
            Stepper("Access expires in \(workspace.accessDays) day\(workspace.accessDays == 1 ? "" : "s")", value: $workspace.accessDays, in: 1...30)
            Text("Saving renews access for this number of days. Personal actions cannot be granted.").font(.caption).foregroundStyle(.secondary)
            if workspace.accessDirty { Text("Access edits are not saved. Save or reload them before creating a token.").font(.callout).foregroundStyle(.secondary) }
            Button("Save access") { Task { await workspace.save(model, name: workspace.accessName, permissions: workspace.accessPermissions, days: workspace.accessDays, enabled: workspace.accessEnabled) } }
                .buttonStyle(.borderedProminent).disabled(!workspace.loaded)
        }.assistantCard()
    }
    private var actionCatalog: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Worshipful Master capabilities").font(.title3.weight(.semibold))
            ForEach(Array(Set(workspace.capabilities.map(\.group))).sorted(), id: \.self) { group in
                VStack(alignment: .leading, spacing: 12) {
                    Text(group).font(.headline)
                    ForEach(workspace.capabilities.filter { $0.group == group }) { capability in
                        VStack(alignment: .leading, spacing: 5) {
                            Toggle(capability.label, isOn: Binding(get: { workspace.accessPermissions.contains(capability.id) }, set: { if $0 { workspace.accessPermissions.insert(capability.id) } else { workspace.accessPermissions.remove(capability.id) } }))
                                .disabled(!capability.canGrant)
                            Text(capability.modeLabel).font(.caption.weight(.semibold)).foregroundStyle(capability.mode == "personal" ? SignTheme.navy : .secondary)
                            Text(capability.description).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            AssistantEffects(effects: capability.effects)
                        }.padding(.vertical, 5)
                    }
                }
                Divider()
            }
        }.assistantCard()
    }
}

struct MyAttestationsView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var workspace: AssistantWorkspace
    let openReview: (AssistantNavigation) -> Void
    @State private var selected: AssistantAttestation?
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "My Attestations", subtitle: "Your pending reviews, signatures and personal confirmations", symbol: "checkmark.seal") {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.load(model) } }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    Text("Open an item to review its exact statement and effects. Continue in the record's normal review screen. Nothing is signed or attested by opening this queue.").fixedSize(horizontal: false, vertical: true)
                    if workspace.loaded && workspace.attestations.isEmpty { ContentUnavailableView("No pending personal reviews", systemImage: "checkmark.seal", description: Text("New work will appear here when it requires your own action.")) }
                    ForEach(workspace.attestations) { item in
                        Button { selected = item } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack { Text(item.title).font(.headline); Spacer(); Image(systemName: "chevron.right") }
                                Text(item.actionLabel).font(.callout)
                                Text(assistantStatusLabel(item.status)).font(.caption).foregroundStyle(.secondary)
                                if let reason = item.reason, !reason.isEmpty { Text(reason).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                            }.frame(maxWidth: .infinity, alignment: .leading).assistantCard()
                        }.buttonStyle(.plain)
                    }
                }.padding(24).frame(maxWidth: 1000, alignment: .leading).frame(maxWidth: .infinity)
            }
            AssistantStatus(message: workspace.message)
        }.background(SignTheme.page)
        .disabled(workspace.busy)
        .task(id: model.assistantAccountContext) { selected = nil; await workspace.load(model) }
        .onDisappear { selected = nil; workspace.leave() }
        .sheet(item: $selected) { item in
            AssistantAttestationReview(item: item, close: { selected = nil }, openReview: { _ in
                Task { if let navigation = await workspace.review(item, model: model) { selected = nil; openReview(navigation) } }
            }, message: workspace.message, busy: workspace.busy)
        }
    }
}

struct AssistantAttestationReview: View {
    let item: AssistantAttestation
    let close: () -> Void
    let openReview: (AssistantNavigation) -> Void
    var message = ""
    var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text(item.title).font(.title2.weight(.semibold)); Spacer(); Button("Close", action: close) }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(item.actionLabel).font(.headline)
                    if let guidance = item.reviewGuidance { Text(guidance).font(.callout).foregroundStyle(.secondary) }
                    if item.consentTextSource == "existing_action_label" { Text("Action to review").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                    Text(item.attestationText.isEmpty ? "Review the current record and its required confirmation in the next screen." : item.attestationText).textSelection(.enabled)
                    AssistantEffects(effects: item.effects)
                    if let reason = item.reason { Text(reason).foregroundStyle(.orange) }
                    if let revision = item.revision { Text("Reviewed revision: \(revision.formatted)").font(.caption).foregroundStyle(.secondary) }
                    Text("The current document and preview load in its normal workspace. If anything has changed, review it again. Any signature or attestation still needs your own explicit confirmation there.").font(.callout).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            AssistantStatus(message: message)
            Button("Open review") { openReview(AssistantNavigation(section: item.section, recordId: item.recordId)) }.buttonStyle(.borderedProminent).disabled(busy)
        }.padding(24).frame(minWidth: 500, idealWidth: 650, minHeight: 390, idealHeight: 520)
    }
}

private struct AssistantRequestSheet: View {
    @EnvironmentObject private var model: AppModel
    let request: AssistantRequest
    private var currentRequest: AssistantRequest { workspace.selectedRequest ?? request }
    @ObservedObject var workspace: AssistantWorkspace
    let openReview: (AssistantNavigation) -> Void
    @State private var note = ""
    @State private var confirmingApproval = false
    @State private var showingExactChange = true
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text(currentRequest.title).font(.title2.weight(.semibold)); Spacer(); Button("Close") { workspace.selectedRequest = nil } }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Status: \(assistantStatusLabel(currentRequest.status))").font(.headline)
                    AssistantEffects(effects: currentRequest.effects)
                    if workspace.isPersonal(currentRequest) { Text("Muse cannot perform this personal action. Open the record and complete your own review.").fontWeight(.semibold) }
                    Text("Expires \(LodgeDateTime.display(currentRequest.expiresAt))").font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("Exact proposed change", isExpanded: $showingExactChange) {
                        Text("\(currentRequest.method) \(currentRequest.path)").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        if let files = currentRequest.files, !files.isEmpty { Text("Files and retained digests").font(.caption.weight(.semibold)); ForEach(Array(files.enumerated()), id: \.offset) { _, file in Text(file.formatted).font(.system(.caption, design: .monospaced)).textSelection(.enabled) } }
                        if let body = currentRequest.body { Text(body.formatted).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    }
                    if let receipt = currentRequest.receipt { Text("Execution receipt").font(.headline); Text(receipt.formatted).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    if let decisionNote = currentRequest.decisionNote, !decisionNote.isEmpty { Text(decisionNote) }
                    if ["pending", "personal"].contains(currentRequest.status) { TextField("Decision note (optional)", text: $note, axis: .vertical).textFieldStyle(.roundedBorder) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            ViewThatFits(in: .horizontal) {
                HStack { decisionButtons }
                VStack(alignment: .leading) { decisionButtons }
            }
            AssistantStatus(message: workspace.message)
        }.padding(24).frame(minWidth: 510, idealWidth: 690, minHeight: 440, idealHeight: 600).disabled(workspace.busy)
        .confirmationDialog("Approve this exact change?", isPresented: $confirmingApproval) {
            Button("Approve change") { Task { await workspace.decide(currentRequest, decision: "approve", note: note, model: model) } }
        } message: { Text("This permits one execution of the displayed change before it expires. Verify its receipt afterward. It does not grant a signature or personal attestation.") }
    }
    @ViewBuilder private var decisionButtons: some View {
        if workspace.canApprove(currentRequest) { Button("Approve change") { confirmingApproval = true }.buttonStyle(.borderedProminent) }
        if let navigation = currentRequest.navigation {
            Button("Open review") {
                if workspace.isPersonal(currentRequest) {
                    Task { if let currentNavigation = await workspace.reviewPersonalRequest(currentRequest, model: model) { openReview(currentNavigation) } }
                } else { openReview(navigation) }
            }
        }
        if ["pending", "personal"].contains(currentRequest.status) { Button("Decline", role: .destructive) { Task { await workspace.decide(currentRequest, decision: "decline", note: note, model: model) } } }
    }
}
private struct AssistantTokenSheet: View {
    let token: String
    let close: () -> Void
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Muse connection token").font(.title2.weight(.semibold))
            Text("This token is shown once. Confirm Muse supports remote MCP with Streamable HTTP and Bearer authentication, then enter it only in secure connection setup. Anyone holding it can use the access you granted until expiry or revocation.").fixedSize(horizontal: false, vertical: true)
            Text("MCP address: https://stone-square-sign.onrender.com/api/assistant/mcp").font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            SecureField("Token", text: .constant(token)).textFieldStyle(.roundedBorder)
            HStack {
                Button(copied ? "Copied" : "Copy token") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(token, forType: .string); copied = true }
                Spacer(); Button("Done", action: close).buttonStyle(.borderedProminent)
            }
        }.padding(24).frame(width: 540)
    }
}
private struct AssistantEffects: View {
    let effects: [String]
    var body: some View {
        if !effects.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(effects.enumerated()), id: \.offset) { _, effect in Label(effect, systemImage: "arrow.turn.down.right").font(.caption).fixedSize(horizontal: false, vertical: true) }
            }
        }
    }
}
private struct AssistantStatus: View {
    let message: String
    var body: some View {
        if !message.isEmpty { Text(message).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(14).background(.bar) }
    }
}
private extension View {
    func assistantCard() -> some View {
        padding(18).background(SignTheme.surface, in: RoundedRectangle(cornerRadius: 12)).overlay { RoundedRectangle(cornerRadius: 12).stroke(SignTheme.cardLine) }
    }
}
