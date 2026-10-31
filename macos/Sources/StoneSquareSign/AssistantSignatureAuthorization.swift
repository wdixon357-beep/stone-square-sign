import AppKit
import SwiftUI
import PDFKit
import CryptoKit

// The assistant can request this flow, but only an authenticated owner session
// can authorize it. The PDF and consent text are immutable request artifacts.
struct AssistantSignatureReceipt: Decodable, Equatable {
    struct Owner: Decodable, Equatable { let userId: Int; let name: String }
    struct Requester: Decodable, Equatable { let assistantId: String; let name: String }
    let authorizedBy: Owner?
    let requestedBy: Requester?
    let appliedBy: String?
    let recordId: String?
    let actionId: String?
    let completedAt: String?
    let notificationState: String?
    let notificationWarnings: [String]?
    let automaticRetryAllowed: Bool?
}
struct AssistantSignatureRequest: Decodable, Identifiable, Equatable {
    let id: String
    let actionId: String
    let recordId: String
    let title: String
    let kind: String
    let status: String
    let createdAt: String
    let expiresAt: String
    let artifactSHA256: String
    let fingerprint: String
    let statement: String
    let effects: [String]
    let signingRole: String
    let ready: Bool
    let reason: String?
    let authorizationUrl: String?
    let receipt: AssistantSignatureReceipt?

    var expires: Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
    }
    func isActionable(at now: Date = Date()) -> Bool {
        status == "pending" && ready && (expires.map { $0 > now } ?? false)
        && !fingerprint.isEmpty && !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !recordId.isEmpty && !actionId.isEmpty && !signingRole.isEmpty && !effects.isEmpty
        && artifactSHA256.count == 64 && artifactSHA256.allSatisfy { $0.isHexDigit }
    }
    func matchesReview(_ other: Self) -> Bool {
        id == other.id && actionId == other.actionId && recordId == other.recordId
        && title == other.title && kind == other.kind && status == other.status
        && createdAt == other.createdAt && expiresAt == other.expiresAt
        && artifactSHA256 == other.artifactSHA256 && fingerprint == other.fingerprint
        && statement == other.statement && effects == other.effects && signingRole == other.signingRole
        && ready == other.ready && reason == other.reason
    }
}
private struct AssistantSignatureList: Decodable { let requests: [AssistantSignatureRequest] }
private struct AssistantSignatureEnvelope: Decodable { let request: AssistantSignatureRequest }

@MainActor final class AssistantSignatureWorkspace: ObservableObject {
    @Published private(set) var requests: [AssistantSignatureRequest] = []
    @Published private(set) var selected: AssistantSignatureRequest?
    @Published private(set) var preview: Data?
    @Published private(set) var previewVerified = false
    @Published private(set) var busy = false
    @Published private(set) var loaded = false
    @Published private(set) var message = ""
    private var context = ""
    private var operation: UInt64 = 0
    private var attemptedRequestIDs: Set<String> = []
    // In-memory only, shared across navigation between the two owner queues.
    // Closing and reopening a sheet must not turn a lost response into a retry.
    private static var attemptedRequestsByContext: [String: Set<String>] = [:]

    func configure(_ model: AppModel) {
        if context != model.assistantAccountContext {
            context = model.assistantAccountContext; operation &+= 1
            requests = []; selected = nil; preview = nil; previewVerified = false
            busy = false; loaded = false; message = ""
            attemptedRequestIDs = Self.attemptedRequestsByContext[context] ?? []
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
    private func finish(_ stamp: (String, UInt64), _ model: AppModel) { if current(stamp, model) { busy = false } }
    private static func route(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? ""
    }
    private func replace(_ request: AssistantSignatureRequest) {
        selected = request
        if let index = requests.firstIndex(where: { $0.id == request.id }) { requests[index] = request }
    }
    private func recordAttempt(_ id: String) {
        attemptedRequestIDs.insert(id)
        Self.attemptedRequestsByContext[context, default: []].insert(id)
    }
    func close() { operation &+= 1; busy = false; selected = nil; preview = nil; previewVerified = false; message = "" }
    func leave() { close() }
    func load(_ model: AppModel) async {
        guard let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        do {
            let result: AssistantSignatureList = try await model.request("/api/assistant/signature-requests")
            guard current(stamp, model) else { return }
            requests = result.requests; loaded = true
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    func inspect(_ item: AssistantSignatureRequest, model: AppModel) async {
        configure(model)
        guard requests.contains(where: { $0.id == item.id }) else { return }
        guard let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        selected = nil; preview = nil; previewVerified = false
        do {
            let result: AssistantSignatureEnvelope = try await model.request("/api/assistant/signature-requests/\(Self.route(item.id))")
            guard current(stamp, model), result.request.id == item.id else { return }
            replace(result.request)
            guard result.request.isActionable() else { return }
            let bytes = try await model.signatureAuthorizationPreview(requestID: item.id)
            guard current(stamp, model), selected?.matchesReview(result.request) == true else { return }
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard digest == result.request.artifactSHA256.lowercased(),
                  let document = PDFDocument(data: bytes), document.pageCount > 0 else {
                message = "The frozen document could not be verified. Nothing can be authorized from this preview."; return
            }
            preview = bytes; previewVerified = true
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    var alreadySubmitted: Bool {
        selected.map { attemptedRequestIDs.contains($0.id) || Self.attemptedRequestsByContext[context]?.contains($0.id) == true } ?? false
    }
    func canConfirm(at now: Date = Date()) -> Bool {
        !busy && previewVerified && preview != nil && !alreadySubmitted && selected?.isActionable(at: now) == true
    }
    var canDecline: Bool { !busy && !alreadySubmitted && selected?.status == "pending" }
    func refreshOutcome(_ model: AppModel) async {
        configure(model)
        guard let selected, let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        do {
            let result: AssistantSignatureEnvelope = try await model.request("/api/assistant/signature-requests/\(Self.route(selected.id))")
            guard current(stamp, model), result.request.id == selected.id else { return }
            if !selected.matchesReview(result.request) { preview = nil; previewVerified = false }
            replace(result.request)
            if alreadySubmitted && result.request.status == "pending" {
                message = "The outcome is still unverified. This request will not be submitted again. Refresh its status before taking further action."
            }
        } catch { if current(stamp, model) { message = error.localizedDescription } }
    }
    // Called only by the owner's explicit confirmation button. A failed or lost
    // POST never becomes a second POST, even if a later read still says pending.
    func confirm(_ model: AppModel) async {
        configure(model)
        guard canConfirm(), let reviewed = selected, let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        var submitted = false
        do {
            let fresh: AssistantSignatureEnvelope = try await model.request("/api/assistant/signature-requests/\(Self.route(reviewed.id))")
            guard current(stamp, model) else { return }
            guard reviewed.matchesReview(fresh.request), fresh.request.isActionable(), previewVerified else {
                replace(fresh.request); preview = nil; previewVerified = false
                message = "This request changed or is no longer ready. Close it and open its current document before authorizing."; return
            }
            guard !alreadySubmitted else {
                message = "This request has already been submitted. Refresh status to verify its outcome."; return
            }
            let body = try JSONSerialization.data(withJSONObject: ["fingerprint": reviewed.fingerprint, "consent": true])
            recordAttempt(reviewed.id); submitted = true
            let result: AssistantSignatureEnvelope = try await model.request("/api/assistant/signature-requests/\(Self.route(reviewed.id))/confirm", method: "POST", body: body)
            guard current(stamp, model), result.request.id == reviewed.id else { return }
            replace(result.request)
            message = result.request.status == "completed" ? "Your authorization was recorded and the system applied your signature. Review the receipt below." : "The request was submitted. Refresh its status to verify the outcome. It will not be submitted again."
        } catch {
            if current(stamp, model) {
                message = submitted ? "The signature outcome is unverified. Do not repeat the signature. Refresh status to check the saved receipt. \(error.localizedDescription)" : error.localizedDescription
            }
        }
    }
    func decline(_ model: AppModel) async {
        configure(model)
        guard canDecline, let reviewed = selected, let stamp = begin(model) else { return }
        defer { finish(stamp, model) }
        var submitted = false
        do {
            let fresh: AssistantSignatureEnvelope = try await model.request("/api/assistant/signature-requests/\(Self.route(reviewed.id))")
            guard current(stamp, model) else { return }
            guard reviewed.matchesReview(fresh.request), fresh.request.status == "pending" else {
                replace(fresh.request); preview = nil; previewVerified = false
                message = "This request changed. Read its current status before deciding."; return
            }
            guard !alreadySubmitted else {
                message = "This request has already been submitted. Refresh status to verify its outcome."; return
            }
            recordAttempt(reviewed.id); submitted = true
            let result: AssistantSignatureEnvelope = try await model.request("/api/assistant/signature-requests/\(Self.route(reviewed.id))/decline", method: "POST", body: Data("{}".utf8))
            guard current(stamp, model), result.request.id == reviewed.id else { return }
            replace(result.request); message = result.request.status == "declined" ? "Request declined." : "Refresh status to verify this decision."
        } catch { if current(stamp, model) { message = submitted ? "The decision outcome is unverified. Refresh status before taking further action. \(error.localizedDescription)" : error.localizedDescription } }
    }
}

// MARK: - Native signature views

struct AssistantSignatureQueue: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var workspace = AssistantSignatureWorkspace()
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Signature authorizations").font(.title3.weight(.semibold))
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.load(model) } }.disabled(workspace.busy)
            }
            Text("After you review a document with Muse, open its request here for one secure confirmation. Opening or refreshing a request does not sign it.").font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if workspace.requests.isEmpty { Text(workspace.loaded ? "No signature requests are recorded." : "Loading signature requests…").foregroundStyle(.secondary) }
            ForEach(workspace.requests) { item in
                Button { Task { await workspace.inspect(item, model: model) } } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title).fontWeight(.medium)
                            Text(assistantStatusLabel(item.status)).font(.caption).foregroundStyle(.secondary)
                            if let reason = item.reason, !reason.isEmpty { Text(reason).font(.caption).foregroundStyle(.orange) }
                        }
                        Spacer(); Image(systemName: "chevron.right")
                    }.padding(.vertical, 6)
                }.buttonStyle(.plain).disabled(workspace.busy)
            }
            if workspace.selected == nil && !workspace.message.isEmpty { Text(workspace.message).font(.callout).foregroundStyle(.orange) }
        }.assistantCard()
        .task(id: model.assistantAccountContext) { await workspace.load(model) }
        .onDisappear { workspace.leave() }
        .sheet(isPresented: Binding(get: { workspace.selected != nil }, set: { if !$0 { workspace.close() } })) {
            AssistantSignatureConfirmation(workspace: workspace).environmentObject(model)
        }
    }
}

struct AssistantSignatureConfirmation: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var workspace: AssistantSignatureWorkspace
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Signature authorization").font(.title2.weight(.semibold))
                Spacer(); Button("Close") { workspace.close() }
            }.padding(20)
            Divider()
            if let request = workspace.selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(request.title).font(.title3.weight(.semibold)).textSelection(.enabled)
                        HStack { Text(assistantStatusLabel(request.status)).fontWeight(.semibold); Spacer(); Text(request.signingRole).foregroundStyle(.secondary) }
                        Text(request.statement).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        AssistantEffects(effects: request.effects)
                        if let reason = request.reason, !reason.isEmpty { Text(reason).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                        if workspace.previewVerified, let preview = workspace.preview {
                            Text("Frozen document").font(.headline)
                            AssistantSignaturePDF(data: preview).frame(minHeight: 350, idealHeight: 500).accessibilityLabel("Exact frozen document for this signature request")
                        } else if request.status == "pending" {
                            Label(workspace.busy ? "Verifying the frozen document…" : "A verified frozen document is required before authorization.", systemImage: "doc.text.magnifyingglass").foregroundStyle(.secondary)
                        }
                        Text("Expires \(LodgeDateTime.display(request.expiresAt)).").font(.caption).foregroundStyle(.secondary)
                        DisclosureGroup("Document verification") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Record: \(request.recordId)")
                                Text("PDF SHA256: \(request.artifactSHA256)")
                                Text("Request fingerprint: \(request.fingerprint)")
                            }.font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let receipt = request.receipt { AssistantSignatureReceiptView(receipt: receipt) }
                        if workspace.alreadySubmitted && request.status != "completed" && request.status != "declined" {
                            Text("This request has already been submitted. Only status checks are available while its outcome is verified.").font(.callout).foregroundStyle(.orange)
                        }
                        if !workspace.message.isEmpty { Text(workspace.message).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }
                Divider()
                ViewThatFits(in: .horizontal) {
                    HStack { controls(request) }
                    VStack(alignment: .leading, spacing: 10) { controls(request) }
                }.padding(20)
            }
        }.frame(minWidth: 540, idealWidth: 780, minHeight: 600, idealHeight: 850).background(SignTheme.page)
        .onChange(of: model.assistantAccountContext) { _, _ in workspace.configure(model) }
    }
    @ViewBuilder private func controls(_ request: AssistantSignatureRequest) -> some View {
        Button("Refresh status") { Task { await workspace.refreshOutcome(model) } }.disabled(workspace.busy)
        if request.status == "pending" {
            Button("Decline", role: .destructive) { Task { await workspace.decline(model) } }.disabled(!workspace.canDecline)
            Spacer(minLength: 0)
            TimelineView(.periodic(from: .now, by: 1)) { clock in
                Button("Authorize and apply signature") { Task { await workspace.confirm(model) } }
                    .buttonStyle(.borderedProminent).disabled(!workspace.canConfirm(at: clock.date))
            }
        }
    }
}
struct AssistantSignaturePDF: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView(); view.autoScales = true; view.displayMode = .singlePageContinuous
        view.backgroundColor = .windowBackgroundColor; return view
    }
    func updateNSView(_ view: PDFView, context: Context) {
        guard context.coordinator.data != data else { return }
        context.coordinator.data = data; view.document = PDFDocument(data: data)
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var data: Data? }
}
struct AssistantSignatureReceiptView: View {
    let receipt: AssistantSignatureReceipt
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Saved receipt").font(.headline)
            if let owner = receipt.authorizedBy { Text("Authorized by \(owner.name)") }
            if receipt.appliedBy == "system" { Text("Signature applied by the system") }
            if let requester = receipt.requestedBy { Text("Requested by \(requester.name)") }
            if let date = receipt.completedAt { Text("Completed \(LodgeDateTime.display(date))") }
            if let state = receipt.notificationState { Text("Notifications: \(assistantStatusLabel(state))") }
            ForEach(receipt.notificationWarnings ?? [], id: \.self) { warning in Text(warning).foregroundStyle(.orange) }
        }.font(.callout).frame(maxWidth: .infinity, alignment: .leading).padding(14).background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
    }
}
