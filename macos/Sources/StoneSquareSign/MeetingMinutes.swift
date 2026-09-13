import AppKit
import SwiftUI
import PDFKit
import UniformTypeIdentifiers

struct MinutesSection: Codable, Equatable { var heading: String; var body: String }
struct MinutesAttendance: Codable, Equatable { var name: String; var title: String; var status: String }
struct MinutesFinance: Codable, Equatable {
    var date: String?; var reference: String?; var party: String?; var description: String?; var amount: String?
}
struct MinutesDraft: Codable, Equatable {
    var organizerVersion: Int?
    var sourceType: String?
    var meetingDate: String?; var meetingType: String; var degree: String?
    var openingTime: String?; var closingTime: String?; var presiding: String?; var quorum: String?; var nextMeeting: String?
    var prayerRequested: Bool?; var closingPrayerGiven: Bool?
    var present: [String]; var excused: [String]; var visitors: [String]
    var officerAttendance: [MinutesAttendance]
    var income: [MinutesFinance]; var expenses: [MinutesFinance]
    var sections: [MinutesSection]; var warnings: [String]; var sensitiveReview: [String]; var actionItems: [String]
}
struct MinutesChange: Codable, Hashable { let field: String; let before: String; let after: String }
struct MinutesRecord: Codable, Identifiable {
    var masterChanges: [MinutesChange]?; var submittedDraft: MinutesDraft?
    var id: String; var draft: MinutesDraft; var status: String; var createdBy: String; var updatedAt: String
    var createdByUserId: Int?; var preparerRole: String?; var preparerAttestedAt: String?; var masterAttestedAt: String?
    var approvedByLodgeOn: String?; var approvalNote: String?
}
struct MinutesListPayload: Decodable { let minutes: [MinutesRecord] }
struct MinutesPayload: Decodable { let minutes: MinutesRecord; let notificationWarnings: [String]? }
struct ReorganizedPayload: Decodable { let draft: MinutesDraft }
struct MinutesSavePayload: Encodable { let draft: MinutesDraft; let expectedUpdatedAt: String }

@MainActor
final class MinutesWorkspace: ObservableObject {
    @Published var records: [MinutesRecord] = []
    @Published var selected: MinutesRecord?
    @Published var draft: MinutesDraft?
    @Published var source = ""
    @Published var sourceType = "auto"
    @Published var fileURL: URL?
    @Published var pdf: Data?
    @Published var messageIsWarning = false
    @Published var message = "" { didSet { messageIsWarning = false } }
    @Published var previewMessage = ""
    @Published var busy = false
    @Published var dirty = false
    @Published var generationStatus: GenerationStatus?
    var baseURL: URL?
    var token = ""
    private var previewTask: Task<Void, Never>?
    private var revision = 0
    private let session: URLSession

    init(session: URLSession = .shared) { self.session = session }

    func configure(_ model: AppModel) {
        baseURL = URL(string: model.serverAddress.trimmingCharacters(in: .whitespacesAndNewlines))
        token = model.webSessionToken ?? ""
    }
    func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json") async throws -> Data {
        guard let baseURL, let url = URL(string: path, relativeTo: baseURL), !token.isEmpty else { throw ClientError.invalidServer }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body; request.timeoutInterval = 90
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("mac",forHTTPHeaderField:"X-Stone-Square-Client")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 404 && path == "/api/treasury" {
                throw ClientError.serviceUpdateRequired("Treasurer Reports is installed on this Mac. The shared Lodge service must be updated before banking records and reports can be opened here.")
            }
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw ClientError.server(object?["error"] as? String ?? "The request could not be completed. Try again.")
        }
        return data
    }
    func refresh() async {
        await refreshGenerationStatus()
        do { records = try JSONDecoder().decode(MinutesListPayload.self, from: await request("/api/minutes")).minutes }
        catch { message = error.localizedDescription }
    }
    func refreshGenerationStatus() async { generationStatus = await GenerationStatus.load(using: self) }
    func open(_ record: MinutesRecord) {
        previewTask?.cancel(); revision += 1
        selected = record; draft = record.draft; pdf = nil; message = ""; messageIsWarning = false; dirty = false
        Task { await refreshGenerationStatus() }
        updatePreview()
    }
    func close() { previewTask?.cancel(); revision += 1; selected = nil; draft = nil; pdf = nil; dirty = false }
    func generate() async {
        busy = true; defer { busy = false }
        do {
            let boundary = "Minutes-\(UUID().uuidString)"
            var body = Data()
            func append(_ text: String) { body.append(Data(text.utf8)) }
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"sourceType\"\r\n\r\n\(sourceType)\r\n")
            if let fileURL {
                let bytes = try Data(contentsOf: fileURL)
                if bytes.count > 12 * 1024 * 1024 { throw ClientError.server("Choose a file smaller than 12 MB.") }
                let filename = fileURL.lastPathComponent.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
                append("--\(boundary)\r\nContent-Disposition: form-data; name=\"transcriptFile\"; filename=\"\(filename)\"\r\nContent-Type: application/octet-stream\r\n\r\n")
                body.append(bytes); append("\r\n")
            } else {
                append("--\(boundary)\r\nContent-Disposition: form-data; name=\"transcriptText\"\r\n\r\n\(source)\r\n")
            }
            append("--\(boundary)--\r\n")
            let result = try await request("/api/minutes/generate", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
            let record = try JSONDecoder().decode(MinutesPayload.self, from: result).minutes
            await refresh(); source = ""; self.fileURL = nil; open(record)
        } catch { message = error.localizedDescription }
        await refreshGenerationStatus()
    }
    func save() async {
        guard let record = selected, let draft else { return }
        busy = true; defer { busy = false }
        do {
            let body = try JSONEncoder().encode(MinutesSavePayload(draft: draft, expectedUpdatedAt: record.updatedAt))
            let result = try await request("/api/minutes/\(record.id)", method: "PUT", body: body)
            selected = try JSONDecoder().decode(MinutesPayload.self, from: result).minutes
            self.draft = selected?.draft; dirty = false; await refresh(); message = "Corrections saved."
        } catch { message = error.localizedDescription }
    }
    func remove(_ record: MinutesRecord) async {
        busy = true; defer { busy = false }
        do { _ = try await request("/api/minutes/\(record.id)", method: "DELETE"); if selected?.id == record.id { close() }; await refresh(); message = "Draft deleted." }
        catch { message = error.localizedDescription }
    }
    func reorganize() async {
        guard let record = selected else { return }
        busy = true; defer { busy = false }
        do {
            let data = try await request("/api/minutes/\(record.id)/reorganize", method: "POST", body: JSONEncoder().encode(["expectedUpdatedAt": record.updatedAt]))
            let replacement = try JSONDecoder().decode(ReorganizedPayload.self, from: data).draft
            guard selected?.id == record.id, selected?.updatedAt == record.updatedAt else { await refreshGenerationStatus(); return }
            draft = replacement
            dirty = true; updatePreview(); message = "Reorganized from the original source. Review before saving."
        } catch { message = error.localizedDescription }
        await refreshGenerationStatus()
    }
    func action(_ action: String, body: [String: String] = [:]) async {
        guard let record = selected else { return }
        busy = true; defer { busy = false }
        do {
            let data = try await request("/api/minutes/\(record.id)/\(action)", method: "POST", body: JSONEncoder().encode(body))
            let payload = try JSONDecoder().decode(MinutesPayload.self, from: data)
            await refresh(); open(payload.minutes); message = (["Record updated."] + (payload.notificationWarnings ?? [])).joined(separator: " ")
            messageIsWarning = payload.notificationWarnings?.isEmpty == false
        } catch { message = error.localizedDescription; messageIsWarning = false }
    }
    func updatePreview() {
        previewTask?.cancel(); revision += 1
        let expected = revision
        guard let draft, let id = selected?.id else { return }
        previewMessage = "Updating preview…"
        previewTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(700))
                let bytes = try await request("/api/minutes/\(id)/preview", method: "POST", body: JSONEncoder().encode(["draft": draft]))
                guard !Task.isCancelled, expected == revision, selected?.id == id else { return }
                pdf = bytes; previewMessage = "Preview matches the current fields."
            } catch { if !Task.isCancelled && expected == revision { previewMessage = error.localizedDescription } }
        }
    }
    func downloadWord() async {
        guard let record = selected else { return }
        do { let data = try await request("/api/minutes/\(record.id)/docx"); saveDocument(data, name: "Meeting Minutes.docx", type: UTType(filenameExtension: "docx") ?? .data) }
        catch { message = error.localizedDescription }
    }
}

@MainActor
func saveDocument(_ data: Data, name: String, type: UTType) {
    let panel = NSSavePanel(); panel.allowedContentTypes = [type]; panel.nameFieldStringValue = name
    if panel.runModal() == .OK, let url = panel.url {
        do { try data.write(to: url, options: .atomic) }
        catch { let alert = NSAlert(); alert.messageText = "The document could not be saved."; alert.informativeText = error.localizedDescription; alert.runModal() }
    }
}
struct LodgeDocumentPreview: NSViewRepresentable {
    let data: Data?
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView(); view.autoScales = true; view.displayMode = .singlePageContinuous
        view.backgroundColor = .windowBackgroundColor; return view
    }
    func updateNSView(_ view: PDFView, context: Context) {
        guard context.coordinator.data != data else { return }
        let page = view.currentPage.flatMap { view.document?.index(for: $0) } ?? 0
        context.coordinator.data = data
        view.document = data.flatMap(PDFDocument.init(data:))
        if let document = view.document, let target = document.page(at: min(page, max(document.pageCount - 1, 0))) { view.go(to: target) }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var data: Data? }
}

struct MeetingMinutesView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @ObservedObject var workspace: MinutesWorkspace
    @State private var deleting: MinutesRecord?
    @State private var confirmReorganize = false
    @State private var confirmClose = false
    @State private var pendingAction: String?
    @State private var approvalDate = ""
    @State private var approvalNote = ""
    private var editable: Bool { model.user?.can("minutes.prepare") == true && (workspace.selected?.status == "draft" || (workspace.selected?.status == "awaiting_master_attestation" && model.user?.role == "owner")) }
    private func text(_ key: WritableKeyPath<MinutesDraft, String?>) -> Binding<String> {
        Binding(get: { workspace.draft?[keyPath: key] ?? "" }, set: { workspace.draft?[keyPath: key] = $0.isEmpty ? nil : $0 })
    }
    private func names(_ key: WritableKeyPath<MinutesDraft, [String]>) -> Binding<String> {
        Binding(get: { workspace.draft?[keyPath: key].joined(separator: "\n") ?? "" }, set: { workspace.draft?[keyPath: key] = $0.components(separatedBy: "\n").filter { !$0.isEmpty } })
    }
    private var status: String { (workspace.selected?.status ?? "draft").replacingOccurrences(of: "_", with: " ").capitalized }
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Meeting Minutes", subtitle: workspace.selected == nil ? "Prepare and manage the Lodge meeting record" : status, symbol: "text.document.fill") {
                if workspace.selected != nil {
                    if workspace.dirty { Text("Unsaved changes").font(.caption).foregroundStyle(.secondary) }
                    Button("Back to records") { if workspace.dirty { confirmClose = true } else { workspace.close() } }
                    if editable { Button("Save corrections") { Task { await workspace.save() } }.buttonStyle(.borderedProminent) }
                } else { Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.refresh() } } }
            }
            if workspace.selected != nil, workspace.draft != nil { editor } else { recordList }
            if !workspace.message.isEmpty {
                Group {
                    if workspace.messageIsWarning { Label(workspace.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    else { Text(workspace.message) }
                }.font(.callout).textSelection(.enabled).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.bar)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .opacity(appeared ? 1 : 0)
        .onAppear { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.24)) { appeared = true } }
        .disabled(workspace.busy)
        .task { workspace.configure(model); await workspace.refresh() }
        .onChange(of: workspace.draft) { old, new in
            guard old != nil, old != new else { return }
            workspace.dirty = new != workspace.selected?.draft; workspace.updatePreview()
        }
        .alert("Delete this unsigned draft?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete draft", role: .destructive) { if let record = deleting { Task { await workspace.remove(record) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("It will be removed from the active records. Signed and approved records cannot be deleted.") }
        .alert("Reorganize the original source?", isPresented: $confirmReorganize) {
            Button("Reorganize") { Task { await workspace.reorganize() } }; Button("Cancel", role: .cancel) {}
        } message: { Text("This replaces the editor contents with a fresh draft. Review it before saving.") }
        .alert("Leave unsaved corrections?", isPresented: $confirmClose) {
            Button("Discard corrections", role: .destructive) { workspace.close() }; Button("Keep editing", role: .cancel) {}
        }
        .alert("Confirm record action", isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } })) {
            Button("Continue") { if let action = pendingAction { Task { await workspace.action(action, body: action == "lodge-approval" ? ["approvalDate": approvalDate, "approvalNote": approvalNote] : [:]) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("\(actionLabel(pendingAction ?? ""))? Review the saved document before continuing.") }
    }
    private var recordList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("New draft").font(.headline)
                        Text("Use compiled meeting notes or a corrected transcript. Attendance and agenda sections are organized for your review.").foregroundStyle(.secondary)
                        GenerationStatusView(status: workspace.generationStatus)
                        Picker("Source format", selection: $workspace.sourceType) {
                            Text("Detect automatically").tag("auto"); Text("Compiled meeting notes").tag("compiled_notes"); Text("Meeting transcript").tag("transcript")
                        }.frame(maxWidth: 380)
                        TextEditor(text: $workspace.source).font(.body).frame(minHeight: 150).padding(5).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                        HStack {
                            Button("Choose file…", systemImage: "doc.badge.plus") {
                                let panel = NSOpenPanel(); panel.allowedContentTypes = [.plainText, .pdf, UTType(filenameExtension: "docx") ?? .data]; panel.allowsMultipleSelection = false
                                if panel.runModal() == .OK { workspace.fileURL = panel.url }
                            }
                            if let file = workspace.fileURL { Text(file.lastPathComponent).lineLimit(1); Button("Remove file") { workspace.fileURL = nil } }
                            Spacer()
                            Button("Create draft minutes") { Task { await workspace.generate() } }.buttonStyle(.borderedProminent).disabled(workspace.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && workspace.fileURL == nil)
                        }
                    }.padding(14)
                }
                Text("Drafts and approved minutes").font(.title3.weight(.semibold))
                if workspace.records.isEmpty { ContentUnavailableView("No minutes yet", systemImage: "doc.text", description: Text("Add meeting notes above to begin.")) }
                ForEach(workspace.records) { record in
                    HStack(spacing: 14) {
                        Image(systemName: "doc.text").font(.title2).foregroundStyle(SignTheme.navy)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(record.draft.meetingDate ?? "Meeting date needs review").font(.headline)
                            Text("Prepared by \(record.createdBy)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(record.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(.secondary)
                        Button("Review") { workspace.open(record) }
                        if record.status == "draft" && (model.user?.role == "owner" || record.createdByUserId == model.user?.id) {
                            Button("Delete", role: .destructive) { deleting = record }
                        }
                    }.padding(16).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
                }
            }.padding(22)
        }
    }
    private var editor: some View {
        HSplitView {
            Form {
                Section {
                    GenerationStatusView(status: workspace.generationStatus)
                    HStack {
                        Text(workspace.draft?.sourceType == "compiled_notes" ? "Compiled meeting notes" : "Meeting transcript").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Spacer()
                        if workspace.selected?.status == "draft" { Button("Reorganize source") { confirmReorganize = true } }
                    }
                    if !(workspace.draft?.warnings.isEmpty ?? true) {
                        DisclosureGroup("Review reminders") { ForEach(workspace.draft?.warnings ?? [], id: \.self) { Text($0).font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 3) } }
                    }
                    if let changes = workspace.selected?.masterChanges, !changes.isEmpty {
                        GroupBox("Worshipful Master's corrections") {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(changes, id: \.self) { change in
                                    DisclosureGroup(change.field) {
                                        VStack(alignment: .leading, spacing: 8) {
                                            Text("Submitted").font(.caption.weight(.semibold))
                                            Text(change.before.isEmpty ? "(blank)" : change.before).textSelection(.enabled)
                                            Divider()
                                            Text("Reviewed").font(.caption.weight(.semibold))
                                            Text(change.after.isEmpty ? "(removed)" : change.after).textSelection(.enabled)
                                        }.font(.callout).padding(8)
                                    }
                                }
                            }.padding(10)
                        }
                    }
                    metadata.disabled(!editable)
                    GroupBox("Attendance") {
                        VStack(alignment: .leading, spacing: 12) {
                            namesEditor("Brothers present", binding: names(\.present))
                            namesEditor("Brothers excused", binding: names(\.excused))
                            namesEditor("Visitors", binding: names(\.visitors))
                            ForEach(workspace.draft?.officerAttendance.indices ?? 0..<0, id: \.self) { i in
                                HStack {
                                    VStack(alignment: .leading) { TextField("Officer name", text: Binding(get: { workspace.draft?.officerAttendance[i].name ?? "" }, set: { workspace.draft?.officerAttendance[i].name = $0 })); TextField("Office or pro tem role", text: Binding(get: { workspace.draft?.officerAttendance[i].title ?? "" }, set: { workspace.draft?.officerAttendance[i].title = $0 })).font(.caption).foregroundStyle(.secondary) }
                                    Spacer()
                                    Picker("Attendance", selection: Binding(get: { workspace.draft?.officerAttendance[i].status ?? "not_recorded" }, set: { workspace.draft?.officerAttendance[i].status = $0 })) {
                                        Text("Not recorded").tag("not_recorded"); Text("Present").tag("present"); Text("Excused").tag("excused"); Text("Absent").tag("absent")
                                    }.labelsHidden().frame(width: 120)
                                }.padding(.vertical, 3)
                            }
                        }.padding(10)
                    }.disabled(!editable)
                    if editable { Button("Add officer or pro tem") { workspace.draft?.officerAttendance.append(MinutesAttendance(name: "", title: "", status: "not_recorded")) } }
                    ForEach(workspace.draft?.sections.indices ?? 0..<0, id: \.self) { i in
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Section heading", text: Binding(get: { workspace.draft?.sections[i].heading ?? "" }, set: { workspace.draft?.sections[i].heading = $0 })).font(.headline)
                            TextEditor(text: Binding(get: { workspace.draft?.sections[i].body ?? "" }, set: { workspace.draft?.sections[i].body = $0 })).font(.body).frame(minHeight: 160).padding(6)
                            if editable { Button("Remove section", role: .destructive) { workspace.draft?.sections.remove(at: i) }.font(.caption) }
                        }.padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8)).disabled(!editable)
                    }
                    if editable { Button("Add section") { workspace.draft?.sections.append(MinutesSection(heading: "Meeting Business", body: "")) } }
                    if !(workspace.draft?.sensitiveReview.isEmpty ?? true) {
                        DisclosureGroup("Private officer review") { ForEach(workspace.draft?.sensitiveReview ?? [], id: \.self) { Text($0).font(.caption) } }
                    }
                    workflow
                }
            }.formStyle(.grouped).frame(minWidth: 340, idealWidth: 480)
            VStack(alignment: .leading, spacing: 8) {
                HStack { Text("Document preview").font(.headline); Spacer(); Button("Save PDF") { if let pdf = workspace.pdf { saveDocument(pdf, name: "Meeting Minutes.pdf", type: .pdf) } }.disabled(workspace.pdf == nil || workspace.previewMessage != "Preview matches the current fields.") }
                Text(workspace.previewMessage).font(.caption).foregroundStyle(.secondary)
                LodgeDocumentPreview(data: workspace.pdf)
            }.padding(14).frame(minWidth: 280, idealWidth: 480)
        }
    }
    private var metadata: some View {
        GroupBox("Meeting details") {
            VStack(alignment: .leading, spacing: 12) {
                MinutesDateField(title: "Meeting date", value: text(\.meetingDate), preservingDetails: false)
                Picker("Meeting type", selection: Binding(get: { workspace.draft?.meetingType == "Stated Communication" ? "Stated Communication" : "Other" }, set: { workspace.draft?.meetingType = $0 == "Other" ? "" : $0 })) {
                    Text("Stated Communication").tag("Stated Communication"); Text("Other").tag("Other")
                }
                if workspace.draft?.meetingType != "Stated Communication" { TextField("Type the meeting name", text: Binding(get: { workspace.draft?.meetingType ?? "" }, set: { workspace.draft?.meetingType = $0 })) }
                Picker("Degree", selection: text(\.degree)) {
                    Text("Needs review").tag("")
                    ForEach(["First Degree", "Second Degree", "Third Degree", "Round Table"], id: \.self) { Text($0).tag($0) }
                }
                HStack { TextField("Opening time", text: text(\.openingTime)); TextField("Closing time", text: text(\.closingTime)) }
                TextField("Presiding officer", text: text(\.presiding))
                Picker("Quorum", selection: text(\.quorum)) { Text("Needs review").tag(""); Text("Yes").tag("Yes"); Text("No").tag("No") }
                MinutesDateField(title: "Next meeting date", value: text(\.nextMeeting), preservingDetails: true)
                Divider()
                Text("Prayer and closing").font(.headline).foregroundStyle(SignTheme.navy)
                Text("Confirm the prayer details for this meeting. The closing section uses the closing time above.").font(.caption).foregroundStyle(.secondary)
                prayerPicker("Worshipful Master requested prayer for the sick and distressed at closing", key: \.prayerRequested)
                prayerPicker("Chaplain gave the closing prayer and prayed for the sick and distressed", key: \.closingPrayerGiven)
            }.textFieldStyle(.roundedBorder).padding(10)
        }
    }
    private func prayerPicker(_ label: String, key: WritableKeyPath<MinutesDraft, Bool?>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption)
            Picker(label, selection: Binding(get: { workspace.draft?[keyPath: key].map { $0 ? "yes" : "no" } ?? "" }, set: { workspace.draft?[keyPath: key] = $0.isEmpty ? nil : $0 == "yes" })) {
                Text("Needs confirmation").tag(""); Text("Yes").tag("yes"); Text("No").tag("no")
            }.labelsHidden()
        }
    }
    private func namesEditor(_ label: String, binding: Binding<String>) -> some View {
        VStack(alignment: .leading) { Text(label).font(.subheadline.weight(.medium)); TextEditor(text: binding).font(.body).frame(height: 65).padding(4) }
    }
    private func actionLabel(_ action: String) -> String {
        ["preparer-attest": "Attest and send to the Worshipful Master", "master-attest": "Attest and authorize distribution", "mark-distributed": "Record distribution", "reopen": "Reopen for corrections", "lodge-approval": "Record formal Lodge approval"][action] ?? action
    }
    private var workflow: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Record actions").font(.headline)
            Button("Download saved Word record") { Task { await workspace.downloadWord() } }.disabled(workspace.dirty)
            if let record = workspace.selected {
                if record.status == "draft" && model.user?.can("minutes.prepare") == true && record.createdByUserId == model.user?.id {
                    Button(actionLabel("preparer-attest")) { pendingAction = "preparer-attest" }.disabled(workspace.dirty)
                }
                if model.user?.role == "owner" && record.status == "awaiting_master_attestation" {
                    Button(actionLabel("master-attest")) { pendingAction = "master-attest" }.disabled(workspace.dirty)
                }
                if ["owner", "secretary"].contains(model.user?.role ?? "") && record.status == "ready_for_distribution" {
                    Button(actionLabel("mark-distributed")) { pendingAction = "mark-distributed" }
                }
                if model.user?.role == "owner" && !["draft", "approved_by_lodge"].contains(record.status) { Button(actionLabel("reopen")) { pendingAction = "reopen" } }
                if ["owner", "secretary"].contains(model.user?.role ?? "") && ["ready_for_distribution", "distributed"].contains(record.status) {
                    TextField("Lodge approval date (YYYY-MM-DD)", text: $approvalDate)
                    TextField("Corrections adopted, if any", text: $approvalNote)
                    Button(actionLabel("lodge-approval")) { pendingAction = "lodge-approval" }.disabled(approvalDate.isEmpty)
                }
            }
        }.buttonStyle(.bordered)
    }
}

private struct MinutesDateField: View {
    let title: String
    @Binding var value: String
    let preservingDetails: Bool
    @State private var choosingDate = false
    @State private var pendingDate = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption)
            HStack {
                TextField("Weekday, Month day, year", text: Binding(
                    get: { MinutesDateText.display(value) },
                    set: { value = $0 }
                ))
                .labelsHidden()
                .accessibilityLabel(title)
                Button {
                    pendingDate = MinutesDateText.match(value)?.date ?? Date()
                    choosingDate = true
                } label: { Image(systemName: "calendar") }
                    .accessibilityLabel("Choose \(title.lowercased())")
                    .help("Choose \(title.lowercased())")
                    .popover(isPresented: $choosingDate) {
                        VStack(alignment: .leading, spacing: 14) {
                            Text(title).font(.headline)
                            DatePicker("Date", selection: $pendingDate, displayedComponents: .date)
                                .datePickerStyle(.graphical)
                                .environment(\.calendar, MinutesDateText.calendar)
                                .environment(\.timeZone, MinutesDateText.calendar.timeZone)
                            HStack {
                                Button("Cancel") { choosingDate = false }
                                Spacer()
                                Button("Use date") {
                                    value = MinutesDateText.replacingDate(in: value, with: pendingDate, preservingDetails: preservingDetails)
                                    choosingDate = false
                                }.buttonStyle(.borderedProminent)
                            }
                        }.padding(18).frame(width: 310)
                    }
            }
        }
    }
}
