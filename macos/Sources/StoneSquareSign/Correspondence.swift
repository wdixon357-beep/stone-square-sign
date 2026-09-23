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
        guard let user = currentUser else { return false }
        if user.role == "owner" { return true }
        if let preparerID = selected.preparedByUserId { return preparerID == user.id }
        return selected.preparedByName == user.name
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
                selected = updated
                fields = updated.fields
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
        message = canEdit ? "Saved draft. Review the letter and its source records." : "Read-only draft prepared by \(record.preparedByName)."
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
        guard let id = selected?.id else { return }
        do {
            let data = try await transport.request("/api/correspondence/\(id)/pdf")
            guard PDFDocument(data: data) != nil else { throw ClientError.invalidResponse }
            pdf = data
        } catch {
            pdf = nil
            message = "Could not load the letterhead preview. \(error.localizedDescription)"
        }
    }
}

struct CorrespondenceView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var workspace: CorrespondenceWorkspace
    @State private var compactPane = 0
    @State private var showingLeaveAlert = false
    @State private var openingRecord: CorrespondenceRecord?

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(
                title: "Lodge Correspondence",
                subtitle: workspace.editing ? "Prepare and preview a Lodge letter draft" : "Saved secretary correspondence drafts",
                symbol: "envelope.open.fill"
            ) {
                if workspace.editing {
                    Button("All Drafts") { leaveEditor() }
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
    }

    private var draftList: some View {
        List {
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
                ForEach(workspace.records) { record in
                    Button { Task { await workspace.open(record) } } label: {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: "doc.text").foregroundStyle(SignTheme.gold)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(record.subject).font(.headline)
                                Text("To \(record.recipientLodge)")
                                Text("Prepared by \(record.preparedByName), \(record.preparedByOffice) · \(record.status.capitalized)")
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
            }
        }
        .listStyle(.inset)
    }

    private var editor: some View {
        AdaptiveWorkspaceSplit(primaryTitle: "Letter", secondaryTitle: "Preview", compactPane: $compactPane) {
            Form {
                Section("Correspondence details") {
                    Picker("Matter", selection: field(\.matter)) {
                        Text("General Lodge correspondence").tag("general")
                        Text("Demit correspondence").tag("demit")
                    }
                    TextField("Receiving Lodge", text: field(\.recipientLodge))
                    TextField("Receiving officer and title", text: field(\.recipientName))
                    TextField("Subject", text: field(\.subject))
                }
                Section("Letter") {
                    Text("Use verified facts. A dues payment alone does not establish eligibility for a demit or authorize its issuance.")
                        .font(.callout).foregroundStyle(.secondary)
                    TextEditor(text: field(\.body))
                        .frame(minHeight: 310)
                        .padding(6)
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                }
                if let record = workspace.selected {
                    Section("Preparing officer") {
                        LabeledContent("Name", value: record.preparedByName)
                        LabeledContent("Office", value: record.preparedByOffice)
                    }
                }
            }
            .formStyle(.grouped)
            .disabled(!workspace.canEdit || workspace.busy)
        } secondary: {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Letterhead preview").font(.headline)
                        Text(workspace.hasChanges ? "Save changes to refresh the PDF." : "This preview reflects the saved draft.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if workspace.selected != nil {
                        Button("Refresh Preview") { Task { await workspace.loadPreview() } }
                            .disabled(workspace.hasChanges || workspace.busy)
                    }
                    Button("Save PDF") {
                        if let pdf = workspace.pdf {
                            saveDocument(pdf, name: "Stone Square Correspondence.pdf", type: .pdf)
                        }
                    }
                    .disabled(workspace.pdf == nil || workspace.hasChanges)
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
}
