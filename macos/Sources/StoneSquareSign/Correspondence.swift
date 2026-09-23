import SwiftUI
import PDFKit
import UniformTypeIdentifiers

struct CorrespondenceFields: Codable, Equatable {
    var recipientLodge = ""
    var recipientName = ""
    var subject = ""
    var body = ""
    var matter = "general"
}

struct CorrespondenceRecord: Decodable, Identifiable {
    let id: String
    let recipientLodge: String
    let recipientName: String
    let subject: String
    let body: String
    let matter: String
    let status: String
    let preparedByName: String
    let preparedByOffice: String
    let preparedByUserId: Int?
    let signingMode: String?
    let sharedSignerUserIds: [Int]?
    let assignedToUserId: Int?
    let assignedToName: String?
    let assignedToOffice: String?
    let signedByName: String?
    let signedByUserId: Int?
    let signedAt: String?
    let returnNote: String?
    let updatedAt: String

    var fields: CorrespondenceFields {
        CorrespondenceFields(recipientLodge: recipientLodge, recipientName: recipientName,
                             subject: subject, body: body, matter: matter)
    }
}

private struct CorrespondenceListResponse: Decodable { let drafts: [CorrespondenceRecord] }
private struct CorrespondenceSaveResponse: Decodable { let draft: CorrespondenceRecord }
private struct CorrespondenceSigner: Decodable, Identifiable {
    let id: Int
    let name: String
    let office: String
    let role: String
}
struct CorrespondenceSignerChoice: Identifiable {
    let id: Int
    let title: String
}
private struct CorrespondenceSignersResponse: Decodable { let signers: [CorrespondenceSigner] }
private struct CorrespondenceSavePayload: Encodable {
    let recipientLodge: String
    let recipientName: String
    let subject: String
    let body: String
    let matter: String
    let signingMode: String
    let signerUserId: Int?

    init(_ fields: CorrespondenceFields, signerUserId: Int?) {
        recipientLodge = fields.recipientLodge
        recipientName = fields.recipientName
        subject = fields.subject
        body = fields.body
        matter = fields.matter
        signingMode = signerUserId == nil ? "either" : "single"
        self.signerUserId = signerUserId
    }

    private enum CodingKeys: String, CodingKey {
        case recipientLodge, recipientName, subject, body, matter, signingMode, signerUserId
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(recipientLodge, forKey: .recipientLodge)
        try values.encode(recipientName, forKey: .recipientName)
        try values.encode(subject, forKey: .subject)
        try values.encode(body, forKey: .body)
        try values.encode(matter, forKey: .matter)
        try values.encode(signingMode, forKey: .signingMode)
        if let signerUserId { try values.encode(signerUserId, forKey: .signerUserId) }
        else { try values.encodeNil(forKey: .signerUserId) }
    }
}
private struct CorrespondenceSubmitPayload: Encodable {
    let signingMode: String
    let signerUserId: Int?
    let expectedUpdatedAt: String

    private enum CodingKeys: String, CodingKey { case signingMode, signerUserId, expectedUpdatedAt }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(signingMode, forKey: .signingMode)
        try values.encode(expectedUpdatedAt, forKey: .expectedUpdatedAt)
        if let signerUserId { try values.encode(signerUserId, forKey: .signerUserId) }
        else { try values.encodeNil(forKey: .signerUserId) }
    }
}
private struct CorrespondenceSignPayload: Encodable {
    let consent: Bool
    let expectedUpdatedAt: String
}

@MainActor final class CorrespondenceWorkspace: ObservableObject {
    @Published private(set) var records: [CorrespondenceRecord] = []
    @Published private(set) var selected: CorrespondenceRecord?
    @Published fileprivate var fields = CorrespondenceFields()
    @Published private(set) var pdf: Data?
    @Published private var signers: [CorrespondenceSigner] = []
    @Published private(set) var selectedSignerUserId: Int?
    @Published var message = ""
    @Published private(set) var busy = false
    @Published private(set) var editing = false
    private let transport = MinutesWorkspace()
    private var previewSignerUserId: Int?
    private var previewUpdatedAt: String?

    private var selectedSigner: CorrespondenceSigner? {
        signers.first { $0.id == selectedSignerUserId }
    }
    private var sharedSignerNames: String {
        let names = sharedSigners.map(\.name)
        return names.count == 2 ? names.joined(separator: " or ") : "William McDuffie or Adrian Reese"
    }
    private func normalizedName(_ name: String) -> String {
        name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }
    private var sharedSigners: [CorrespondenceSigner] {
        let secretary = signers.filter { $0.role == "secretary" &&
            normalizedName($0.name) == "william mcduffie" }
        let assistant = signers.filter { $0.role == "assistant_secretary" &&
            normalizedName($0.name) == "adrian reese" }
        guard secretary.count == 1, assistant.count == 1 else { return [] }
        return [secretary[0], assistant[0]]
    }
    private var isSharedSigning: Bool { selectedSignerUserId == nil }
    var selectedSignerName: String { isSharedSigning ? sharedSignerNames : (selectedSigner?.name ?? "a signing officer") }
    var selectedSignerOffice: String { selectedSigner?.office ?? "Secretary or Assistant Secretary" }
    var signerChoices: [CorrespondenceSignerChoice] {
        signers.map { CorrespondenceSignerChoice(id: $0.id, title: "\($0.name), \($0.office)") }
    }
    var canChooseSigner: Bool {
        currentUser?.role == "owner" && (selected == nil || selected?.status == "draft") && !busy
    }
    private var isAssignedSigner: Bool {
        guard let currentUser else { return false }
        return ["secretary", "assistant_secretary"].contains(currentUser.role) &&
            currentUser.can("reports.create") &&
            ((selected?.signingMode == "either" && selected?.sharedSignerUserIds?.contains(currentUser.id) == true) ||
             selected?.assignedToUserId == currentUser.id)
    }

    var hasChanges: Bool {
        editing && (selected == nil || fields != selected?.fields ||
                    (currentUser?.role == "owner" && selected?.status == "draft" &&
                     (selectedSignerUserId != selected?.assignedToUserId ||
                      selected?.signingMode != (isSharedSigning ? "either" : "single"))))
    }
    var canEdit: Bool {
        guard let selected else { return true }
        guard selected.status == "draft" else { return false }
        guard let user = currentUser else { return false }
        if user.role == "owner" { return true }
        if let preparerID = selected.preparedByUserId { return preparerID == user.id }
        return selected.preparedByName == user.name
    }
    var canSubmit: Bool {
        currentUser?.role == "owner" && selected?.status == "draft" && !hasChanges &&
            (isSharedSigning ? sharedSigners.count == 2 : selectedSigner != nil) &&
            pdf != nil && previewSignerUserId == selectedSignerUserId &&
            previewUpdatedAt == selected?.updatedAt &&
            selected?.assignedToUserId == selectedSignerUserId &&
            selected?.signingMode == (isSharedSigning ? "either" : "single") && !busy
    }
    var canSign: Bool {
        isAssignedSigner && selected?.status == "awaiting_secretary" && pdf != nil &&
            previewUpdatedAt == selected?.updatedAt && !busy
    }
    var canReturnForCorrection: Bool {
        guard let currentUser, selected?.status == "awaiting_secretary", !busy else { return false }
        return currentUser.role == "owner" || isAssignedSigner
    }
    var lettersForMySignature: [CorrespondenceRecord] {
        guard ["secretary", "assistant_secretary"].contains(currentUser?.role ?? "") else { return [] }
        return records.filter { $0.status == "awaiting_secretary" &&
            (($0.signingMode == "either" && $0.sharedSignerUserIds?.contains(currentUser?.id ?? -1) == true) ||
             $0.assignedToUserId == currentUser?.id) }
    }
    var signedLettersForMe: [CorrespondenceRecord] {
        guard ["secretary", "assistant_secretary"].contains(currentUser?.role ?? "") else { return [] }
        return records.filter { $0.status == "signed" && $0.signedByUserId == currentUser?.id }
    }
    var otherLetters: [CorrespondenceRecord] {
        let highlighted = Set((lettersForMySignature + signedLettersForMe).map(\.id))
        return records.filter { !highlighted.contains($0.id) }
    }
    private var currentUser: User?

    func configure(_ model: AppModel) {
        transport.configure(model)
        currentUser = model.user
    }

    func refresh() async {
        do {
            await loadSigners()
            let data = try await transport.request("/api/correspondence")
            records = try JSONDecoder().decode(CorrespondenceListResponse.self, from: data).drafts
            if let id = selected?.id, let updated = records.first(where: { $0.id == id }), !hasChanges {
                let previewChanged = selected?.updatedAt != updated.updatedAt || selected?.status != updated.status
                if previewChanged { pdf = nil; previewSignerUserId = nil; previewUpdatedAt = nil }
                selected = updated
                fields = updated.fields
                if currentUser?.role == "owner", updated.status == "draft" {
                    selectedSignerUserId = updated.signingMode == "either" ? nil : (updated.assignedToUserId ?? signers.first?.id)
                }
                if previewChanged { await loadPreview() }
            }
        } catch { message = "Could not load correspondence drafts. \(error.localizedDescription)" }
    }

    func beginNew() {
        selected = nil
        fields = CorrespondenceFields()
        pdf = nil
        previewSignerUserId = nil
        previewUpdatedAt = nil
        selectedSignerUserId = nil
        editing = true
        message = "Draft only. Verify the facts and Lodge authority before any correspondence is issued."
    }

    func startDemitInquiryReply() {
        guard selected == nil, canEdit, !busy else { return }
        fields.matter = "demit"
        fields.subject = "Demit inquiry concerning [Brother full name]"
        fields.body = """
            Dear Brother Secretary,

            In response to your correspondence concerning [Brother full name] and his demit request to [Receiving Lodge], Stone Square Lodge No. 22 confirms the following as of [record date]: [verified standing and charges statement].

            Please let us know if you need any further information as the request proceeds through the appropriate channels.
            """
        changed()
        message = "General demit reply started. Verify the incoming inquiry, financial standing, and complaint and charge records. Replace every bracketed prompt before saving."
    }

    func open(_ record: CorrespondenceRecord) async {
        selected = record
        fields = record.fields
        pdf = nil
        previewSignerUserId = nil
        previewUpdatedAt = nil
        if currentUser?.role == "owner", record.status == "draft", let assignedID = record.assignedToUserId,
           !signers.contains(where: { $0.id == assignedID }) {
            selectedSignerUserId = nil
        } else {
            selectedSignerUserId = record.signingMode == "either" ? nil : (record.assignedToUserId ?? signers.first?.id)
        }
        editing = true
        message = record.status == "signed" ? "Signed by \(record.signedByName ?? "the signing officer"). Save the PDF for that officer to email." :
            record.returnNote != nil ? "Returned for correction. Review the reason below before resubmitting." :
            record.status == "awaiting_secretary" && isAssignedSigner ?
                "Review the complete letterhead PDF before applying your saved signature." :
            canEdit ? "Saved draft. Review the letter and its source records." : "This letter is read-only at its current stage."
        await loadPreview()
    }

    func close() {
        editing = false
        selected = nil
        fields = CorrespondenceFields()
        pdf = nil
        previewSignerUserId = nil
        previewUpdatedAt = nil
        message = ""
    }

    func changed() {
        pdf = nil
        previewSignerUserId = nil
        previewUpdatedAt = nil
        if hasChanges { message = "Unsaved changes. Save the draft to update its letterhead preview." }
    }

    private func loadSigners() async {
        do {
            let data = try await transport.request("/api/correspondence/signers")
            let available = try JSONDecoder().decode(CorrespondenceSignersResponse.self, from: data).signers
            let previousID = selectedSignerUserId
            signers = available
            if let selected, selected.status != "draft" { return }
            guard let previousID else { return }
            if available.contains(where: { $0.id == previousID }) { return }
            selectedSignerUserId = nil
            pdf = nil
            previewSignerUserId = nil
            previewUpdatedAt = nil
            message = "The previously selected signing officer is unavailable. Choose either secretary or another available officer before submission."
        } catch {
            signers = []
            if selected == nil || selected?.status == "draft" {
                selectedSignerUserId = nil
                pdf = nil
                previewSignerUserId = nil
                previewUpdatedAt = nil
                message = "Could not load available signing officers. Refresh before sending this letter. \(error.localizedDescription)"
            }
        }
    }

    func chooseSigner(_ id: Int?) async {
        guard canChooseSigner, id == nil || signers.contains(where: { $0.id == id }),
              selectedSignerUserId != id || selected?.signingMode != (id == nil ? "either" : "single") else { return }
        selectedSignerUserId = id
        pdf = nil
        previewSignerUserId = nil
        previewUpdatedAt = nil
        message = isSharedSigning
            ? "Save the draft to offer it to both secretaries. The first to sign will appear on the signed letter."
            : "Save the draft to preview the letter with \(selectedSignerName) as the signing officer."
    }

    func save() async {
        guard canEdit, !busy else { return }
        let trimmed = CorrespondenceFields(
            recipientLodge: fields.recipientLodge.trimmingCharacters(in: .whitespacesAndNewlines),
            recipientName: fields.recipientName.trimmingCharacters(in: .whitespacesAndNewlines),
            subject: fields.subject.trimmingCharacters(in: .whitespacesAndNewlines),
            body: fields.body.trimmingCharacters(in: .whitespacesAndNewlines),
            matter: fields.matter
        )
        guard !trimmed.recipientLodge.isEmpty, !trimmed.recipientName.isEmpty,
              !trimmed.subject.isEmpty, !trimmed.body.isEmpty else {
            message = "Add the receiving Lodge, receiving officer, subject, and letter text before saving."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let path = selected.map { "/api/correspondence/\($0.id)" } ?? "/api/correspondence"
            let payload = CorrespondenceSavePayload(trimmed, signerUserId: currentUser?.role == "owner" ? selectedSignerUserId : nil)
            let data = try await transport.request(path, method: selected == nil ? "POST" : "PUT", body: JSONEncoder().encode(payload))
            let record = try JSONDecoder().decode(CorrespondenceSaveResponse.self, from: data).draft
            selected = record
            fields = record.fields
            if currentUser?.role == "owner" { selectedSignerUserId = record.assignedToUserId }
            previewSignerUserId = nil
            previewUpdatedAt = nil
            message = "Draft saved. The letter has not been sent."
            await refresh()
            await loadPreview()
        } catch { message = "Could not save this draft. \(error.localizedDescription)" }
    }

    func loadPreview() async {
        guard let record = selected else { return }
        let signerID = record.assignedToUserId
        if currentUser?.role == "owner" && record.status == "draft" && selectedSignerUserId != signerID {
            pdf = nil
            previewUpdatedAt = nil
            message = "Save the signing officer choice to update the letterhead preview."
            return
        }
        if currentUser?.role == "owner" && record.status == "draft" &&
            record.signingMode != "either" && signerID == nil {
            pdf = nil
            previewUpdatedAt = nil
            message = "Choose an available signing officer to preview this letter."
            return
        }
        do {
            let data = try await transport.request("/api/correspondence/\(record.id)/pdf")
            guard PDFDocument(data: data) != nil else { throw ClientError.invalidResponse }
            guard selected?.id == record.id, selected?.updatedAt == record.updatedAt,
                  selected?.status == record.status,
                  (currentUser?.role != "owner" || record.status != "draft" || selectedSignerUserId == signerID) else { return }
            pdf = data
            previewSignerUserId = signerID
            previewUpdatedAt = record.updatedAt
        } catch {
            guard selected?.id == record.id, selected?.updatedAt == record.updatedAt,
                  selected?.status == record.status else { return }
            pdf = nil
            previewSignerUserId = nil
            previewUpdatedAt = nil
            message = "Could not load the letterhead preview. \(error.localizedDescription)"
        }
    }

    func submitToSecretary() async {
        guard canSubmit, let record = selected else { return }
        busy = true
        defer { busy = false }
        do {
            let body = try JSONEncoder().encode(CorrespondenceSubmitPayload(
                signingMode: isSharedSigning ? "either" : "single", signerUserId: selectedSignerUserId,
                expectedUpdatedAt: record.updatedAt))
            let data = try await transport.request("/api/correspondence/\(record.id)/submit", method: "POST", body: body)
            let record = try JSONDecoder().decode(CorrespondenceSaveResponse.self, from: data).draft
            pdf = nil
            selected = record
            fields = record.fields
            message = isSharedSigning
                ? "Submitted to both secretaries. The first to sign will be named on the final letter. No email has been sent."
                : "Submitted to \(selectedSignerName), \(selectedSignerOffice), for review and signature. No email has been sent."
            await refresh()
            await loadPreview()
        } catch { message = "Could not submit this letter. \(error.localizedDescription)" }
    }

    func sign() async {
        guard canSign, let record = selected, previewUpdatedAt == record.updatedAt else { return }
        busy = true
        defer { busy = false }
        do {
            let body = try JSONEncoder().encode(CorrespondenceSignPayload(
                consent: true, expectedUpdatedAt: record.updatedAt))
            let data = try await transport.request("/api/correspondence/\(record.id)/sign", method: "POST", body: body)
            let record = try JSONDecoder().decode(CorrespondenceSaveResponse.self, from: data).draft
            pdf = nil
            selected = record
            fields = record.fields
            message = "Signature applied. Save the signed PDF and email it to the receiving Secretary."
            await refresh()
            await loadPreview()
        } catch {
            await refresh()
            if let selected, selected.status == "signed" {
                message = "This letter was already signed by \(selected.signedByName ?? "another officer"). The signed PDF is ready to review."
            } else {
                message = "Could not sign this letter. \(error.localizedDescription)"
            }
        }
    }

    func returnForCorrection(_ reason: String) async {
        guard canReturnForCorrection, let id = selected?.id else { return }
        let explanation = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !explanation.isEmpty else { message = "Enter a correction reason before returning the letter."; return }
        busy = true
        defer { busy = false }
        do {
            let body = try JSONEncoder().encode(["reason": explanation])
            let data = try await transport.request("/api/correspondence/\(id)/return", method: "POST", body: body)
            let record = try JSONDecoder().decode(CorrespondenceSaveResponse.self, from: data).draft
            pdf = nil
            selected = record
            fields = record.fields
            message = "Returned for correction with your reason. The letter remains unsigned and unsent."
            await refresh()
            await loadPreview()
        } catch { message = "Could not return this letter. \(error.localizedDescription)" }
    }
}

struct CorrespondenceView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var workspace: CorrespondenceWorkspace
    @State private var compactPane = 0
    @State private var showingLeaveAlert = false
    @State private var openingRecord: CorrespondenceRecord?
    @State private var showingSubmitConfirmation = false
    @State private var showingSignSheet = false
    @State private var signConsent = false
    @State private var signingImage: NSImage?
    @State private var showingReturnSheet = false
    @State private var returnReason = ""

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(
                title: "Lodge Correspondence",
                subtitle: workspace.editing ? "Prepare and preview a Lodge letter draft" : "Saved secretary correspondence drafts",
                symbol: "envelope.open.fill"
            ) {
                if workspace.editing {
                    Button("All Drafts") { leaveEditor() }
                    if workspace.canSubmit {
                        Button("Send for Secretary Signature") { showingSubmitConfirmation = true }
                    }
                    if workspace.canSign {
                        Button("Review and Sign") {
                            signConsent = false
                            Task {
                                signingImage = try? await model.signatureImage()
                                showingSignSheet = true
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    if workspace.canEdit {
                        Button("Save Draft") { Task { await workspace.save() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(workspace.busy || !workspace.hasChanges)
                    }
                } else {
                    Button("New Letter Draft") { workspace.beginNew() }
                        .buttonStyle(.borderedProminent)
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.refresh() } }
                }
            }
            if !workspace.lettersForMySignature.isEmpty {
                Label("\(workspace.lettersForMySignature.count) letter\(workspace.lettersForMySignature.count == 1 ? "" : "s") awaiting your review and signature", systemImage: "bell.badge.fill")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(SignTheme.navy)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 11)
                    .background(SignTheme.gold.opacity(0.14))
            }
            if workspace.editing { editor } else { draftList }
            if !workspace.message.isEmpty {
                Text(workspace.message)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(.bar)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { workspace.configure(model); await workspace.refresh() }
        .onChange(of: workspace.fields) { old, new in
            if old != new { workspace.changed() }
        }
        .alert("Leave unsaved letter changes?", isPresented: $showingLeaveAlert) {
            Button("Keep Editing", role: .cancel) { openingRecord = nil }
            Button("Discard Changes", role: .destructive) {
                if let record = openingRecord { Task { await workspace.open(record) } }
                else { workspace.close() }
                openingRecord = nil
            }
        } message: {
            Text("Your saved drafts remain available when you return.")
        }
        .confirmationDialog("Send this letter to \(workspace.selectedSignerName)?", isPresented: $showingSubmitConfirmation) {
            Button("Send for Signature") { Task { await workspace.submitToSecretary() } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("The assigned secretary will review and sign the letter in the dashboard, then email the signed PDF. When offered to both, the first to sign completes it. This action does not email the receiving Lodge.")
        }
        .sheet(isPresented: $showingSignSheet) { signSheet }
        .sheet(isPresented: $showingReturnSheet) { returnSheet }
    }

    private var draftList: some View {
        List {
            if !workspace.lettersForMySignature.isEmpty {
                Section {
                    ForEach(workspace.lettersForMySignature) { record in recordRow(record) }
                } header: {
                    Label("For Your Signature", systemImage: "signature")
                        .foregroundStyle(SignTheme.navy)
                } footer: {
                    Text("Review each letter and its PDF before applying your saved signature.")
                }
            }
            if !workspace.signedLettersForMe.isEmpty {
                Section {
                    ForEach(workspace.signedLettersForMe) { record in recordRow(record) }
                } header: {
                    Label("Signed Letters", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                } footer: {
                    Text("Open a signed letter to save its PDF for email. The dashboard does not track whether the email was sent.")
                }
            }
            Section("Secretary's office") {
                Text("Prepare official correspondence for either the Secretary or Assistant Secretary to review and sign. Saving a draft does not send it.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section("Saved drafts") {
                if workspace.records.isEmpty {
                    ContentUnavailableView("No correspondence drafts", systemImage: "envelope.open",
                                           description: Text("Start a letter to see its Lodge letterhead preview."))
                }
                ForEach(workspace.otherLetters) { record in recordRow(record) }
            }
        }
        .listStyle(.inset)
    }

    private func recordRow(_ record: CorrespondenceRecord) -> some View {
        Button { Task { await workspace.open(record) } } label: {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: record.status == "awaiting_secretary" ? "signature" :
                      record.status == "signed" ? "checkmark.seal.fill" : "doc.text")
                    .foregroundStyle(record.status == "signed" ? Color.green : SignTheme.gold)
                VStack(alignment: .leading, spacing: 4) {
                    Text(record.subject).font(.headline)
                    Text("To \(record.recipientLodge)")
                    Text("Prepared by \(record.preparedByName), \(record.preparedByOffice) · \(statusLabel(record))")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(LodgeDateTime.display(record.updatedAt))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var editor: some View {
        AdaptiveWorkspaceSplit(primaryTitle: "Letter", secondaryTitle: "Preview", compactPane: $compactPane) {
            Form {
                if let record = workspace.selected, record.status != "draft" || record.returnNote != nil {
                    Section("Status") {
                        LabeledContent("Stage", value: statusLabel(record))
                        if let returnNote = record.returnNote, !returnNote.isEmpty {
                            Text("Correction requested: \(returnNote)")
                                .font(.callout)
                                .foregroundStyle(SignTheme.navy)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if record.status == "awaiting_secretary" {
                            Text(record.signingMode == "either"
                                 ? "Either secretary may review and sign this letter. The first signature completes it and determines the signing name and office."
                                 : "\(record.assignedToName ?? "The assigned officer") reviews and signs this letter before emailing it.")
                                .font(.callout).foregroundStyle(.secondary)
                            if workspace.canReturnForCorrection {
                                Button("Return for Correction") {
                                    returnReason = ""
                                    showingReturnSheet = true
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                        if let signer = record.signedByName, let signedAt = record.signedAt {
                            LabeledContent("Signed by", value: signer)
                            LabeledContent("Signed", value: LodgeDateTime.display(signedAt))
                        }
                    }
                }
                Section("Correspondence details") {
                    Picker("Matter", selection: field(\.matter)) {
                        Text("General Lodge correspondence").tag("general")
                        Text("Demit correspondence").tag("demit")
                    }
                    TextField("Receiving Lodge", text: field(\.recipientLodge))
                    TextField("Receiving officer and title", text: field(\.recipientName))
                    TextField("Subject", text: field(\.subject))
                }
                .disabled(!workspace.canEdit || workspace.busy)
                if model.user?.role == "owner" {
                    Section("Signing officer") {
                        if workspace.canChooseSigner {
                            Picker("Choose who signs and sends", selection: Binding(
                                get: { workspace.selectedSignerUserId },
                                set: { newValue in Task { await workspace.chooseSigner(newValue) } }
                            )) {
                                Text("Either Secretary (first to sign)").tag(Optional<Int>.none)
                                ForEach(workspace.signerChoices) { choice in
                                    Text(choice.title).tag(Optional(choice.id))
                                }
                            }
                            .disabled(workspace.signerChoices.isEmpty)
                            if workspace.signerChoices.isEmpty {
                                Text("No signing officer is available. Refresh after access is restored; this letter cannot be submitted yet.")
                                    .font(.callout).foregroundStyle(.secondary)
                            } else {
                                Text(workspace.selectedSignerUserId == nil
                                     ? "Both secretaries may review this letter. The first to sign will appear on the signed PDF."
                                     : "The selected officer's name and office appear on the saved letter. Review the PDF before submission.")
                                    .font(.callout).foregroundStyle(.secondary)
                            }
                        } else if let record = workspace.selected {
                            LabeledContent("Assigned to", value: record.assignedToName ?? "Not assigned")
                            if let office = record.assignedToOffice { LabeledContent("Office", value: office) }
                        }
                    }
                }
                Section("Letter") {
                    if workspace.selected == nil && workspace.canEdit {
                        Button("Start demit inquiry reply") { workspace.startDemitInquiryReply() }
                    }
                    Text("Use verified facts. A dues payment alone does not establish eligibility for a demit or authorize its issuance.")
                        .font(.callout).foregroundStyle(.secondary)
                    TextEditor(text: field(\.body))
                        .frame(minHeight: 310)
                        .padding(6)
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                }
                .disabled(!workspace.canEdit || workspace.busy)
                if let record = workspace.selected {
                    Section("Preparing officer") {
                        LabeledContent("Name", value: record.preparedByName)
                        LabeledContent("Office", value: record.preparedByOffice)
                    }
                }
            }
            .formStyle(.grouped)
        } secondary: {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Letterhead preview").font(.headline)
                        Text(workspace.hasChanges ? "Save changes to refresh the PDF." :
                             workspace.selected?.status == "signed" ? "Signed letter. Export the PDF for email." :
                             "This preview reflects the saved letter.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if workspace.selected != nil {
                        Button("Refresh Preview") { Task { await workspace.loadPreview() } }
                            .disabled(workspace.hasChanges || workspace.busy)
                    }
                    Button(workspace.selected?.status == "signed" ? "Save Signed PDF" : "Save Draft PDF") {
                        if let pdf = workspace.pdf {
                            saveDocument(pdf, name: "Stone Square Correspondence.pdf", type: .pdf)
                        }
                    }
                    .disabled(workspace.pdf == nil || workspace.hasChanges || workspace.busy)
                }
                if workspace.pdf != nil {
                    LodgeDocumentPreview(data: workspace.pdf)
                } else {
                    ContentUnavailableView("Preview after saving", systemImage: "doc.richtext",
                                           description: Text("Save the draft to see the official letterhead PDF."))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding(14)
        }
    }

    private func field(_ key: WritableKeyPath<CorrespondenceFields, String>) -> Binding<String> {
        Binding(get: { workspace.fields[keyPath: key] }, set: { workspace.fields[keyPath: key] = $0 })
    }

    private func leaveEditor() {
        if workspace.hasChanges { showingLeaveAlert = true }
        else { workspace.close() }
    }

    private func statusLabel(_ record: CorrespondenceRecord) -> String {
        switch record.status {
        case "awaiting_secretary": return record.signingMode == "either"
            ? "Waiting for William McDuffie or Adrian Reese to sign"
            : "Waiting for \(record.assignedToName ?? "the assigned officer") to sign"
        case "signed": return "Signed by \(record.signedByName ?? "the signing officer"), ready to email"
        default: return record.returnNote == nil ? "Draft" : "Draft, correction requested"
        }
    }

    private var signSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("OFFICER SIGNATURE")
                .font(.caption2.weight(.bold)).tracking(2).foregroundStyle(SignTheme.gold)
            Text("Review and sign Lodge correspondence")
                .font(.title2.weight(.semibold))
            Text("Review the letter PDF before applying your saved signature. You will email the signed PDF after this step.")
                .foregroundStyle(.secondary)
            if let signingImage {
                Image(nsImage: signingImage)
                    .resizable().scaledToFit().frame(height: 130)
                    .frame(maxWidth: .infinity)
                    .padding(12)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 9))
            } else {
                ContentUnavailableView("No saved signature", systemImage: "signature",
                    description: Text("Add a signature in Signature Profile before signing."))
            }
            Toggle("I reviewed the letter and authorize my saved signature to appear on it.", isOn: $signConsent)
            HStack {
                Spacer()
                Button("Cancel") { showingSignSheet = false }
                Button("Apply My Signature") {
                    showingSignSheet = false
                    Task { await workspace.sign() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!signConsent || signingImage == nil || workspace.busy)
            }
        }
        .padding(30)
        .frame(minWidth: 480, idealWidth: 650)
    }

    private var returnSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Return letter for correction").font(.title2.weight(.semibold))
            Text("Explain what needs to change. The letter will return to draft status without a signature.")
                .foregroundStyle(.secondary)
            TextEditor(text: $returnReason)
                .frame(minHeight: 120)
                .padding(6)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                Spacer()
                Button("Cancel") { showingReturnSheet = false }
                Button("Return with Reason") {
                    let reason = returnReason
                    showingReturnSheet = false
                    Task { await workspace.returnForCorrection(reason) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(returnReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || workspace.busy)
            }
        }
        .padding(26)
        .frame(minWidth: 460, idealWidth: 600)
    }
}
