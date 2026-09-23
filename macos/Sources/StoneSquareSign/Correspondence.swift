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
    let assignedToUserId: Int?
    let signedByName: String?
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

@MainActor final class CorrespondenceWorkspace: ObservableObject {
    @Published private(set) var records: [CorrespondenceRecord] = []
    @Published private(set) var selected: CorrespondenceRecord?
    @Published fileprivate var fields = CorrespondenceFields()
    @Published private(set) var pdf: Data?
    @Published var message = ""
    @Published private(set) var busy = false
    @Published private(set) var editing = false
    private let transport = MinutesWorkspace()

    var hasChanges: Bool { editing && (selected == nil || fields != selected?.fields) }
    var canEdit: Bool {
        guard let selected else { return true }
        guard selected.status == "draft" else { return false }
        guard let user = currentUser else { return false }
        if user.role == "owner" { return true }
        if let preparerID = selected.preparedByUserId { return preparerID == user.id }
        return selected.preparedByName == user.name
    }
    var canSubmit: Bool {
        currentUser?.role == "owner" && selected?.status == "draft" && !hasChanges && pdf != nil && !busy
    }
    var canSign: Bool {
        currentUser?.role == "secretary" && selected?.status == "awaiting_secretary"
            && selected?.assignedToUserId == currentUser?.id && pdf != nil && !busy
    }
    var canReturnForCorrection: Bool {
        guard let currentUser, selected?.status == "awaiting_secretary", !busy else { return false }
        return currentUser.role == "owner" ||
            (currentUser.role == "secretary" && selected?.assignedToUserId == currentUser.id)
    }
    var lettersForMySignature: [CorrespondenceRecord] {
        guard currentUser?.role == "secretary" else { return [] }
        return records.filter { $0.status == "awaiting_secretary" && $0.assignedToUserId == currentUser?.id }
    }
    var signedLettersForMe: [CorrespondenceRecord] {
        guard currentUser?.role == "secretary" else { return [] }
        return records.filter { $0.status == "signed" && $0.assignedToUserId == currentUser?.id }
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
            let data = try await transport.request("/api/correspondence")
            records = try JSONDecoder().decode(CorrespondenceListResponse.self, from: data).drafts
            if let id = selected?.id, let updated = records.first(where: { $0.id == id }), !hasChanges {
                let previewChanged = selected?.updatedAt != updated.updatedAt || selected?.status != updated.status
                if previewChanged { pdf = nil }
                selected = updated
                fields = updated.fields
                if previewChanged { await loadPreview() }
            }
        } catch { message = "Could not load correspondence drafts. \(error.localizedDescription)" }
    }

    func beginNew() {
        selected = nil
        fields = CorrespondenceFields()
        pdf = nil
        editing = true
        message = "Draft only. Verify the facts and Lodge authority before any correspondence is issued."
    }

    func open(_ record: CorrespondenceRecord) async {
        selected = record
        fields = record.fields
        pdf = nil
        editing = true
        message = record.status == "signed" ? "Signed by \(record.signedByName ?? "the Secretary"). Save the PDF for the Secretary to email." :
            record.returnNote != nil ? "Returned for correction. Review the reason below before resubmitting." :
            record.status == "awaiting_secretary" && currentUser?.role == "secretary" && record.assignedToUserId == currentUser?.id ?
                "Review the complete letterhead PDF before applying your saved signature." :
            canEdit ? "Saved draft. Review the letter and its source records." : "This letter is read-only at its current stage."
        await loadPreview()
    }

    func close() {
        editing = false
        selected = nil
        fields = CorrespondenceFields()
        pdf = nil
        message = ""
    }

    func changed() {
        pdf = nil
        if hasChanges { message = "Unsaved changes. Save the draft to update its letterhead preview." }
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
            let data = try await transport.request(path, method: selected == nil ? "POST" : "PUT", body: JSONEncoder().encode(trimmed))
            let record = try JSONDecoder().decode(CorrespondenceSaveResponse.self, from: data).draft
            selected = record
            fields = record.fields
            message = "Draft saved. The letter has not been sent."
            await refresh()
            await loadPreview()
        } catch { message = "Could not save this draft. \(error.localizedDescription)" }
    }

    func loadPreview() async {
        guard let record = selected else { return }
        do {
            let data = try await transport.request("/api/correspondence/\(record.id)/pdf")
            guard PDFDocument(data: data) != nil else { throw ClientError.invalidResponse }
            guard selected?.id == record.id, selected?.updatedAt == record.updatedAt,
                  selected?.status == record.status else { return }
            pdf = data
        } catch {
            guard selected?.id == record.id, selected?.updatedAt == record.updatedAt,
                  selected?.status == record.status else { return }
            pdf = nil
            message = "Could not load the letterhead preview. \(error.localizedDescription)"
        }
    }

    func submitToSecretary() async {
        guard canSubmit, let id = selected?.id else { return }
        busy = true
        defer { busy = false }
        do {
            let data = try await transport.request("/api/correspondence/\(id)/submit", method: "POST")
            let record = try JSONDecoder().decode(CorrespondenceSaveResponse.self, from: data).draft
            pdf = nil
            selected = record
            fields = record.fields
            message = "Submitted to Secretary McDuffie for review and signature. No email has been sent."
            await refresh()
            await loadPreview()
        } catch { message = "Could not submit this letter. \(error.localizedDescription)" }
    }

    func sign() async {
        guard canSign, let id = selected?.id else { return }
        busy = true
        defer { busy = false }
        do {
            let data = try await transport.request("/api/correspondence/\(id)/sign", method: "POST",
                                                   body: Data("{\"consent\":true}".utf8))
            let record = try JSONDecoder().decode(CorrespondenceSaveResponse.self, from: data).draft
            pdf = nil
            selected = record
            fields = record.fields
            message = "Signature applied. Save the signed PDF and email it to the receiving Secretary."
            await refresh()
            await loadPreview()
        } catch { message = "Could not sign this letter. \(error.localizedDescription)" }
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
                        Button("Send to McDuffie for Signature") { showingSubmitConfirmation = true }
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
        .confirmationDialog("Send this letter to Secretary McDuffie?", isPresented: $showingSubmitConfirmation) {
            Button("Send for Secretary Signature") { Task { await workspace.submitToSecretary() } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("He will review and sign the letter in the dashboard. This action does not email the recipient.")
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
                Text("Prepare official correspondence for review. Saving a draft does not sign or send it.")
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
                            Text("Secretary McDuffie reviews and signs this letter before emailing it.")
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
                Section("Letter") {
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
        case "awaiting_secretary": return "Awaiting McDuffie's signature"
        case "signed": return "Signed, ready for Secretary to email"
        default: return record.returnNote == nil ? "Draft" : "Draft, correction requested"
        }
    }

    private var signSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("SECRETARY SIGNATURE")
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
