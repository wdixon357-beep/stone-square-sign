import AppKit
import SwiftUI
import PDFKit
import UniformTypeIdentifiers

struct TreasuryAccount: Codable, Equatable, Identifiable {
    var id = UUID().uuidString; var name = "Account"; var activityComplete = false
    var openingBalance: String?; var statementBalance: String?; var bookBalance: String?
    var receipts: String?; var disbursements: String?; var transfersIn: String?; var transfersOut: String?
    var depositsInTransit: String?; var outstandingChecks: String?; var bankHold: String?
}
struct TreasuryTransaction: Codable, Equatable { var date = ""; var postedDateConfirmed: Bool?; var account = ""; var kind = "review"; var description = ""; var amount: String?; var reference = ""; var category = "" }
struct TreasuryFund: Codable, Equatable { var name = ""; var account = ""; var amount: String?; var restriction = "" }
struct TreasuryObligation: Codable, Equatable { var name = ""; var dueDate = ""; var amount: String?; var note = "" }
struct TreasuryDraft: Codable, Equatable {
    var version: Int; var previousMeetingDate: String?; var periodStart: String; var periodEnd: String; var presentedOn: String; var bankName: String
    var accounts: [TreasuryAccount]; var transactions: [TreasuryTransaction]; var funds: [TreasuryFund]; var obligations: [TreasuryObligation]
    var fundsReviewed: Bool; var obligationsReviewed: Bool; var sourceReviewed: Bool
    var remarks: String; var unmappedLines: [String]; var sourceNames: [String]; var extractionNotes: [String]
}
struct TreasuryRecord: Codable, Identifiable { var id: String; var status: String; var revision: Int; var createdByUserId: Int; var preparerUserId: Int?; var uploadedBy: String; var createdBy: String; var preparerRole: String; var draft: TreasuryDraft }
extension TreasuryRecord {
    func canOpen(for user: User?) -> Bool {
        user?.can("treasury.prepare") == true || (user?.can("treasury.view") == true && ["ready_for_distribution", "distributed"].contains(status))
    }
}
struct TreasuryPayload: Decodable { var report: TreasuryRecord; var notificationWarnings: [String]? }
struct TreasuryList: Decodable { var reports: [TreasuryRecord] }
struct ReorganizedTreasuryPayload: Decodable { var draft: TreasuryDraft }

struct TreasuryPreparer: Codable, Identifiable { var id: Int; var name: String; var role: String }
struct TreasuryPreparers: Codable { var preparers: [TreasuryPreparer] }
struct TreasurySourceFile: Codable, Identifiable { var id: String; var name: String; var mime: String; var accountLabel: String? }
struct TreasurySourcePayload: Codable { var text: String; var files: [TreasurySourceFile] }
struct TreasuryAccessUser: Codable, Identifiable { var id: Int; var name: String; var role: String; var canPrepare: Bool; var uploadEnabled: Bool }
struct TreasuryAccessPayload: Codable { var users: [TreasuryAccessUser] }

@MainActor final class TreasuryWorkspace: ObservableObject {
    @Published var records: [TreasuryRecord] = []; @Published var selected: TreasuryRecord?; @Published var draft: TreasuryDraft?
    @Published var uploadIntent = "save"
    @Published var checkingSource = ""; @Published var checkingFiles: [URL] = []; @Published var savingsSource = ""; @Published var savingsFiles: [URL] = []; @Published var messageIsWarning = false; @Published var message = "" { didSet { messageIsWarning = false } }; @Published var busy = false
    @Published var pdf: Data?; @Published var previewMessage = ""; @Published var dirty = false
    @Published var preparers: [TreasuryPreparer] = []; @Published var selectedPreparer = 0
    @Published var originalText = ""; @Published var sourceFiles: [TreasurySourceFile] = []; @Published var accessUsers: [TreasuryAccessUser] = []
    @Published var serviceUpdateRequired = false
    @Published var generationStatus: GenerationStatus?
    private var owner = false
    let transport: MinutesWorkspace
    private var previewTask: Task<Void,Never>?; private var generation = 0
    init(session: URLSession = .shared) { transport = MinutesWorkspace(session: session) }
    func configure(_ model: AppModel) { transport.configure(model); owner = model.user?.role == "owner" }
    func refresh() async {
        await refreshGenerationStatus()
        do {
            records = try JSONDecoder().decode(TreasuryList.self, from: await transport.request("/api/treasury")).reports
            serviceUpdateRequired = false
        } catch ClientError.serviceUpdateRequired(let detail) {
            serviceUpdateRequired = true; message = detail
        } catch { message = error.localizedDescription }
    }
    func refreshGenerationStatus() async { generationStatus = await GenerationStatus.load(using: transport) }
    func open(_ report: TreasuryRecord) { selectedPreparer=report.preparerUserId ?? 0; originalText="";sourceFiles=[]; Task { await loadSources(report.id); await refreshGenerationStatus() }; selected = report; draft = report.draft; dirty = false; pdf = nil; preview() }
    func loadSources(_ id: String) async {
        do {
            let source=try JSONDecoder().decode(TreasurySourcePayload.self,from:await transport.request("/api/treasury/\(id)/source"))
            let options=try JSONDecoder().decode(TreasuryPreparers.self,from:await transport.request("/api/treasury/preparers"))
            guard selected?.id == id else { return };originalText=source.text;sourceFiles=source.files;preparers=options.preparers
        } catch { if selected?.id == id { message=error.localizedDescription } }
    }
    func assign() async {
        guard !busy, let current=selected else { return };busy=true;defer {busy=false}
        if dirty { guard await save() else {return} }
        do {
            let data=try await transport.request("/api/treasury/\(current.id)/assign",method:"POST",body:JSONSerialization.data(withJSONObject:["revision":selected!.revision,"preparerUserId":selectedPreparer]))
            let report=try JSONDecoder().decode(TreasuryPayload.self,from:data).report;open(report);await refresh();message="Assigned to \(report.createdBy). The original records and prefilled draft are available in their Treasurer Reports."
        } catch {message=error.localizedDescription}
    }
    func downloadSource(_ file: TreasurySourceFile) async {
        guard let selected else {return}
        do {let data=try await transport.request("/api/treasury/\(selected.id)/sources/\(file.id)");saveDocument(data,name:file.name,type:UTType(filenameExtension:URL(fileURLWithPath:file.name).pathExtension) ?? .data)} catch {message=error.localizedDescription}
    }
    func loadAccess() async {
        guard owner, !serviceUpdateRequired else {return};do{accessUsers=try JSONDecoder().decode(TreasuryAccessPayload.self,from:await transport.request("/api/treasury/access")).users}catch{message=error.localizedDescription}
    }
    func setUploadAccess(_ user: TreasuryAccessUser) async {
        do {
            _ = try await transport.request("/api/treasury/access/\(user.id)", method: "PUT", body: JSONSerialization.data(withJSONObject: ["enabled": !user.uploadEnabled]))
            await loadAccess()
            message = user.uploadEnabled ? "Bank record upload access removed for \(user.name)." : "Bank record upload access enabled for \(user.name)."
        } catch { message = error.localizedDescription }
    }
    func close() { previewTask?.cancel(); generation += 1; selected = nil; draft = nil; pdf = nil; dirty = false }
    func createBlank() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let bytes = try await transport.request("/api/treasury/drafts", method: "POST")
            let report = try JSONDecoder().decode(TreasuryPayload.self, from: bytes).report
            open(report); await refresh(); message = "Blank report created. Enter the reporting details and amounts."
        } catch { message = error.localizedDescription }
    }
    func generate() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        message = "Reading banking information. Scanned pages may take a minute."
        do {
            let boundary = "Treasury-\(UUID().uuidString)"; var data = Data()
            func append(_ value: String) { data.append(Data(value.utf8)) }
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"intent\"\r\n\r\n\(uploadIntent)\r\n")
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"checkingSourceText\"\r\n\r\n\(checkingSource)\r\n")
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"savingsSourceText\"\r\n\r\n\(savingsSource)\r\n")
            if checkingFiles.count + savingsFiles.count > 5 { throw ClientError.server("Choose no more than five files total.") }
            var total = 0
            for (field,files) in [("checkingFiles",checkingFiles),("savingsFiles",savingsFiles)] { for file in files {
                let bytes = try Data(contentsOf: file); total += bytes.count
                if bytes.count > 12*1024*1024 || total > 20*1024*1024 { throw ClientError.server("Use files under 12 MB each and 20 MB combined.") }
                let name = file.lastPathComponent.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
                append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"; filename=\"\(name)\"\r\nContent-Type: application/octet-stream\r\n\r\n"); data.append(bytes); append("\r\n")
            } }
            append("--\(boundary)--\r\n")
            let result = try await transport.request("/api/treasury/generate", method: "POST", body: data, contentType: "multipart/form-data; boundary=\(boundary)")
            let report = try JSONDecoder().decode(TreasuryPayload.self, from: result).report
            await refresh(); checkingSource = ""; checkingFiles = []; savingsSource = ""; savingsFiles = []
            if report.status == "awaiting_preparer" {close();message="Banking information saved. Authorized preparers have a Dashboard alert until one of them claims the report."}
            else {open(report);message="Review the prefilled information and complete your report."}
        } catch { message = error.localizedDescription }
        await refreshGenerationStatus()
    }
    func reorganize() async {
        guard !busy, let record = selected, record.status == "draft" else { return }
        busy = true; defer { busy = false }
        do {
            let data = try await transport.request("/api/treasury/\(record.id)/organize", method: "POST", body: JSONEncoder().encode(["revision": record.revision]))
            let replacement = try JSONDecoder().decode(ReorganizedTreasuryPayload.self, from: data).draft
            guard selected?.id == record.id, selected?.revision == record.revision else { await refreshGenerationStatus(); return }
            draft = replacement; dirty = true; preview()
            message = "Reorganized from the original banking records. Review the draft before saving."
        } catch { message = error.localizedDescription }
        await refreshGenerationStatus()
    }
    func save() async -> Bool {
        guard let selected, let draft else { return false }
        struct Save: Encodable { let draft: TreasuryDraft; let revision: Int }
        do {
            let bytes = try await transport.request("/api/treasury/\(selected.id)", method: "PUT", body: JSONEncoder().encode(Save(draft:draft,revision:selected.revision)))
            self.selected = try JSONDecoder().decode(TreasuryPayload.self, from: bytes).report; self.draft = self.selected?.draft
            dirty = false; await refresh(); message = "Corrections saved."; return true
        } catch { message = error.localizedDescription; return false }
    }
    func action(_ action: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        if action != "mark-distributed" { let saved = await save(); if !saved { return } }
        guard let selected else { return }
        do {
            let data = try await transport.request("/api/treasury/\(selected.id)/\(action)", method:"POST", body:JSONSerialization.data(withJSONObject:["revision":selected.revision]))
            let payload = try JSONDecoder().decode(TreasuryPayload.self, from:data); open(payload.report); await refresh(); message = (["Report updated."] + (payload.notificationWarnings ?? [])).joined(separator:" "); messageIsWarning = payload.notificationWarnings?.isEmpty == false
        } catch { message = error.localizedDescription; messageIsWarning = false }
    }
    func remove(_ record: TreasuryRecord) async { do { _ = try await transport.request("/api/treasury/\(record.id)",method:"DELETE"); await refresh(); message = "Unsigned draft deleted." } catch { message = error.localizedDescription } }
    func preview() {
        previewTask?.cancel(); generation += 1; let expected = generation
        guard let selected, let draft else { return }; previewMessage = "Updating preview…"
        previewTask = Task {
            do {
                try await Task.sleep(for:.milliseconds(700))
                let bytes = try await transport.request("/api/treasury/\(selected.id)/preview",method:"POST",body:JSONEncoder().encode(["draft":draft]))
                guard !Task.isCancelled, expected == generation, self.selected?.id == selected.id else { return }
                guard PDFDocument(data:bytes) != nil else { throw ClientError.invalidResponse }
                pdf = bytes; previewMessage = "Preview matches the current fields."
            } catch { if !Task.isCancelled && expected == generation { previewMessage = error.localizedDescription } }
        }
    }
}

struct TreasuryView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var workspace: TreasuryWorkspace
    @State private var deleting: TreasuryRecord?; @State private var leave = false
    @State private var editorSection = 0
    @State private var confirmReorganize = false
    @State private var readonlyReport: TreasuryRecord?
    @State private var showingHistory = false
    @State private var pendingWorkflowAction: String?
    @State private var pendingAccessUser: TreasuryAccessUser?
    @State private var confirmingAssignment = false
    var editable: Bool { guard model.user?.can("treasury.prepare") == true, let r = workspace.selected else { return false }; return r.status == "draft" && r.preparerUserId == model.user?.id }
    var canFinalize: Bool {
        guard editable, let draft = workspace.draft else { return false }
        return draft.sourceReviewed && draft.fundsReviewed && draft.obligationsReviewed
            && draft.accounts.allSatisfy(\.activityComplete)
            && workspace.pdf != nil && workspace.previewMessage == "Preview matches the current fields."
    }
    func text(_ path: WritableKeyPath<TreasuryDraft,String>) -> Binding<String> { Binding(get:{workspace.draft?[keyPath:path] ?? ""},set:{workspace.draft?[keyPath:path]=$0}) }
    func flag(_ path: WritableKeyPath<TreasuryDraft,Bool>) -> Binding<Bool> { Binding(get:{workspace.draft?[keyPath:path] ?? false},set:{workspace.draft?[keyPath:path]=$0}) }
    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            NativeWorkspaceHeader(title: "Treasurer Reports", subtitle: workspace.selected == nil ? "Prepare a report from banking records" : "Review entries and the formatted report", symbol: "chart.bar.doc.horizontal.fill") {
                if workspace.selected != nil { Button("All reports") { if workspace.dirty { leave = true } else { workspace.close() } } }
                else { Button("Historical reports") { showingHistory = true } }
            }
            if workspace.serviceUpdateRequired {
                VStack(spacing: 16) {
                    ContentUnavailableView("Shared service update needed", systemImage: "arrow.triangle.2.circlepath", description: Text("The Mac workspace is ready. Banking records and reports will appear after the shared Lodge service is updated."))
                    Button("Check again") { Task { await workspace.refresh(); if !workspace.serviceUpdateRequired { workspace.message = ""; await workspace.loadAccess() } } }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if workspace.draft == nil { sourceView } else { editor }
            if !workspace.message.isEmpty {
                Group {
                    if workspace.messageIsWarning { Label(workspace.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    else { Text(workspace.message) }
                }.font(.callout).padding(14)
            }
        }.background(Color(nsColor:.windowBackgroundColor)).disabled(workspace.busy)
        .task { workspace.configure(model); await workspace.refresh(); await workspace.loadAccess() }
        .sheet(item: $readonlyReport) { report in FinalReportBrowserView(kind: .treasury, initialSelection: report.id, onClose: { readonlyReport = nil }).environmentObject(model).frame(minWidth: 800, minHeight: 650) }
        .sheet(isPresented: $showingHistory) { FinalReportBrowserView(kind: .treasury, onClose: { showingHistory = false }).environmentObject(model).frame(minWidth: 800, minHeight: 650) }
        .onChange(of:workspace.draft) { old,new in if old != nil && new != nil { workspace.dirty = new != workspace.selected?.draft; workspace.preview() } }
        .alert("Delete this unsigned report?",isPresented:Binding(get:{deleting != nil},set:{if !$0 { deleting = nil }})) { Button("Delete",role:.destructive) { if let record = deleting { Task { await workspace.remove(record) } } }; Button("Cancel",role:.cancel) {} }
        .alert("Leave unsaved changes?",isPresented:$leave) { Button("Leave changes",role:.destructive) { workspace.close() }; Button("Keep editing",role:.cancel) {} }
        .alert("Replace unsaved report entries?", isPresented: $confirmReorganize) {
            Button("Reorganize original source") { Task { await workspace.reorganize() } }
            Button("Keep editing", role: .cancel) {}
        } message: { Text("This replaces your unsaved entries with a new draft from the original banking records. Review the result before saving.") }
        .alert(pendingWorkflowAction == "preparer-attest" ? "Sign and finalize this Treasurer Report?" : "Record this report as distributed?", isPresented: Binding(
            get: { pendingWorkflowAction != nil },
            set: { if !$0 { pendingWorkflowAction = nil } }
        )) {
            Button(pendingWorkflowAction == "preparer-attest" ? "Sign and finalize" : "Record distribution") {
                let action = pendingWorkflowAction
                pendingWorkflowAction = nil
                if let action { Task { await workspace.action(action) } }
            }
            Button("Cancel", role: .cancel) { pendingWorkflowAction = nil }
        } message: {
            Text(pendingWorkflowAction == "preparer-attest"
                 ? "This saves the current entries and applies the preparing officer's attestation to the final report."
                 : "Use this only after the finalized report has been distributed to the Lodge.")
        }
        .alert(item: $pendingAccessUser) { user in
            Alert(
                title: Text(user.uploadEnabled ? "Remove bank record upload access?" : "Allow bank record uploads?"),
                message: Text(user.uploadEnabled
                    ? "\(user.name) will no longer be able to supply banking records for a Treasurer Report."
                    : "\(user.name) will be able to upload banking records for a Treasurer Report. This does not grant bank login or report editing access."),
                primaryButton: .default(Text(user.uploadEnabled ? "Remove access" : "Allow uploads")) { Task { await workspace.setUploadAccess(user) } },
                secondaryButton: .cancel()
            )
        }
        .alert("Assign this Treasurer Report?", isPresented: $confirmingAssignment) {
            Button("Assign report") { Task { await workspace.assign() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The selected officer will receive the source records and prefilled report for completion.")
        }
    }
    var sourceView: some View {
        Form {
            if model.user?.can("treasury.prepare") == true { Section { Button("Create blank report") { Task { await workspace.createBlank() } }.buttonStyle(.borderedProminent) } }
            if model.user?.can("treasury.upload") == true { Section {
            GroupBox("Checking account information") { VStack(alignment:.leading,spacing:12) {
                GenerationStatusView(status: workspace.generationStatus)
                Button("Choose checking files") { let panel=NSOpenPanel();panel.allowsMultipleSelection=true;panel.allowedContentTypes=[.pdf,.png,.jpeg,.plainText];if panel.runModal() == .OK { workspace.checkingFiles=panel.urls } }
                ForEach(workspace.checkingFiles,id:\.self) { Text($0.lastPathComponent).font(.caption) }
                if !workspace.checkingFiles.isEmpty { Button("Clear checking files") { workspace.checkingFiles=[] } }
                Text("Upload statements or screenshots, or paste checking transactions and balances below.").font(.callout).foregroundStyle(.secondary)
                TextEditor(text:$workspace.checkingSource).font(.body).frame(minHeight:130).border(Color.gray.opacity(0.25))
            }.padding(12) }
            GroupBox("Savings account information") { VStack(alignment:.leading,spacing:12) {
                Button("Choose savings files") { let panel=NSOpenPanel();panel.allowsMultipleSelection=true;panel.allowedContentTypes=[.pdf,.png,.jpeg,.plainText];if panel.runModal() == .OK { workspace.savingsFiles=panel.urls } }
                ForEach(workspace.savingsFiles,id:\.self) { Text($0.lastPathComponent).font(.caption) }
                if !workspace.savingsFiles.isEmpty { Button("Clear savings files") { workspace.savingsFiles=[] } }
                Text("Upload statements or screenshots, or paste savings transactions and balances below.").font(.callout).foregroundStyle(.secondary)
                TextEditor(text:$workspace.savingsSource).font(.body).frame(minHeight:130).border(Color.gray.opacity(0.25))
            }.padding(12) }
            GroupBox("Report handoff") { VStack(alignment:.leading,spacing:12) {
                Text("Report dates are set automatically. Add bank-posted dates for transactions. Use no more than five files total.").font(.callout).foregroundStyle(.secondary)
                Picker("What would you like to do?",selection:$workspace.uploadIntent) {
                    Text("Save banking information for a report").tag("save")
                    if model.user?.can("treasury.prepare") == true {Text("I’m completing the report").tag("complete")}
                }.pickerStyle(.radioGroup)
                Text(model.user?.role == "owner" ? "Save the information for later, or open the prefilled report and complete it yourself. Saving banking information for later does not use the generation allowance." : "Save the information for later, or open the prefilled report and complete it yourself.").font(.caption)
                Button("Continue") { Task { await workspace.generate() } }.buttonStyle(.borderedProminent).disabled(workspace.checkingSource.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && workspace.savingsSource.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && workspace.checkingFiles.isEmpty && workspace.savingsFiles.isEmpty)
            }.padding(12) } }
            if model.user?.role == "owner" { DisclosureGroup("Bank record upload access") { Text("Allow an account to supply records for another preparing officer. This does not grant bank login or other Lodge permissions.").font(.caption)
                ForEach(workspace.accessUsers.filter { !$0.canPrepare }) { user in HStack { Text(user.name); Spacer(); Button(user.uploadEnabled ? "Remove upload access" : "Allow bank record uploads") { pendingAccessUser = user } } }
            } }
            ForEach(workspace.records) { record in HStack { VStack(alignment:.leading) { Text(record.draft.periodEnd.isEmpty ? "Reporting date needs review" : LodgeCalendarDates.displayDate(record.draft.periodEnd)).font(.headline);Text("\(record.preparerUserId == model.user?.id ? "Assigned to you" : record.createdBy.isEmpty ? "Available for a preparer" : record.createdBy) · Uploaded by \(record.uploadedBy) · \((record.status == "awaiting_preparer" ? "Banking information saved for a report" : record.status.replacingOccurrences(of:"_",with:" ")))").font(.caption) }; Spacer();if record.canOpen(for: model.user) { Button("Review") { if model.user?.can("treasury.prepare") != true && ["ready_for_distribution", "distributed"].contains(record.status) { readonlyReport = record } else { workspace.open(record) } } }; if model.user?.can("treasury.prepare") == true && ["draft","awaiting_preparer"].contains(record.status) && (model.user?.role == "owner" || record.createdByUserId == model.user?.id || record.preparerUserId == model.user?.id) { Button("Delete",role:.destructive) { deleting=record } } }.padding(14).background(.background,in:RoundedRectangle(cornerRadius:12)) }
        } }.formStyle(.grouped)
    }
    var editor: some View {
        HSplitView {
            VStack(spacing: 0) {
                Picker("Report section", selection: $editorSection) {
                    Text("Details").tag(0); Text("Accounts").tag(1); Text("Activity").tag(2); Text("Review").tag(3)
                }.pickerStyle(.segmented).padding(16)
                Divider()
                Form {
                    Section {
                        GenerationStatusView(status: workspace.generationStatus)
                        if editable {
                            Button("Reorganize original source") {
                                if workspace.dirty { confirmReorganize = true }
                                else { Task { await workspace.reorganize() } }
                            }
                        }
                    }
                    if editorSection == 0 {
                        Section { handoff }
                        Section("Source records") {
                            DisclosureGroup("Original banking records and notes") {
                                Text(workspace.originalText).font(.caption).textSelection(.enabled)
                                ForEach(workspace.sourceFiles) { file in Button("Save \(file.accountLabel.map { $0 + ": " } ?? "")\(file.name)") { Task { await workspace.downloadSource(file) } } }
                            }
                            importReview
                        }
                        Section { metadata }.disabled(!editable)
                    } else if editorSection == 1 {
                        Section { accounts; funds }.disabled(!editable)
                    } else if editorSection == 2 {
                        Section { activity; obligations }.disabled(!editable)
                    } else {
                        Section("Treasurer’s remarks") { TextEditor(text: text(\.remarks)).font(.body).frame(minHeight: 130) }.disabled(!editable)
                        Section { Toggle("I checked the source, amounts, classifications and unmapped lines.", isOn: flag(\.sourceReviewed)) }.disabled(!editable)
                        Section("Complete the report") { workflow }
                    }
                }.formStyle(.grouped).textFieldStyle(.roundedBorder)
            }.frame(minWidth: 360, idealWidth: 500)
            VStack(alignment: .leading, spacing: 10) {
                HStack { Text("Document preview").font(.headline); Spacer(); Button("Save PDF") { if let pdf = workspace.pdf { saveDocument(pdf, name: "Treasurer Report.pdf", type: .pdf) } }.disabled(workspace.pdf == nil || workspace.previewMessage != "Preview matches the current fields.") }
                Text(workspace.previewMessage).font(.caption).foregroundStyle(.secondary)
                LodgeDocumentPreview(data: workspace.pdf)
            }.padding(16).frame(minWidth: 280, idealWidth: 480)
        }
    }
    var handoff: some View { VStack(alignment:.leading,spacing:12) {
        if let record=workspace.selected {
            Text("Uploaded by \(record.uploadedBy)").font(.caption)
            if record.status == "awaiting_preparer" {
                Text("Banking information saved").font(.headline)
                Text("These records are available for an authorized preparer. No one has been assigned automatically.").font(.callout)
                if model.user?.can("treasury.prepare") == true { Button("I’m completing this report") { workspace.selectedPreparer = model.user?.id ?? 0; confirmingAssignment = true }.buttonStyle(.borderedProminent) }
            } else {Text("Preparing officer: \(record.createdBy)").font(.headline)}
            if (record.status == "awaiting_preparer" && (record.createdByUserId == model.user?.id || model.user?.role == "owner")) || (record.status == "draft" && model.user?.role == "owner") {
                DisclosureGroup(record.status == "awaiting_preparer" ? "Assign a preparing officer (optional)" : "Change preparing officer") { assignmentPicker }
            }
        }
    } }
    var assignmentPicker: some View { VStack(alignment:.leading,spacing:12) {
        Text("Select yourself to continue, or hand the records and prefilled draft to another officer.").font(.callout)
        Picker("Preparing officer",selection:$workspace.selectedPreparer) { Text("Choose an officer").tag(0);ForEach(workspace.preparers) { person in Text(person.name + (person.id == model.user?.id ? " (I will prepare it)" : "")).tag(person.id) } }
        Button("Continue with selected officer") { confirmingAssignment = true }.buttonStyle(.borderedProminent).disabled(workspace.selectedPreparer == 0)
    } }
    var metadata: some View { GroupBox("Report details") { VStack(alignment:.leading) { Text("Only bank-posted activity from \(workspace.draft?.periodStart.isEmpty == false ? workspace.draft?.periodStart ?? "" : "the first included date") through \(workspace.draft?.periodEnd.isEmpty == false ? workspace.draft?.periodEnd ?? "" : "the report preparation date") is included. PDFs, screenshots, pasted activity and typed notes are all limited to these dates.").font(.caption).foregroundStyle(.secondary);TextField("First included date (YYYY-MM-DD)",text:text(\.periodStart)).disabled(true);TextField("Report prepared through (YYYY-MM-DD)",text:text(\.periodEnd)).disabled(true);TextField("Date actually presented (YYYY-MM-DD)",text:text(\.presentedOn));TextField("Bank or credit union",text:text(\.bankName)) }.padding(10) } }
    var importReview: some View { DisclosureGroup("Source and import review") { Text(workspace.draft?.sourceNames.joined(separator:", ") ?? "");Text(workspace.draft?.extractionNotes.joined(separator:"\n") ?? "");Text("Review these lines that did not map to a financial field:").font(.caption);Text(workspace.draft?.unmappedLines.joined(separator:"\n") ?? "").font(.caption).textSelection(.enabled) } }
    func accountAmount(_ index:Int,_ key:WritableKeyPath<TreasuryAccount,String?>) -> Binding<String> { Binding(get:{workspace.draft?.accounts[index][keyPath:key] ?? ""},set:{workspace.draft?.accounts[index][keyPath:key]=$0}) }
    var accounts: some View {
        VStack(alignment:.leading,spacing:16) {
            ForEach(Array((workspace.draft?.accounts ?? []).enumerated()),id:\.element.id) { index,account in
                GroupBox(account.name) { VStack(alignment:.leading,spacing:10) {
                    TextField("Account label",text:Binding(get:{workspace.draft?.accounts[index].name ?? ""},set:{workspace.draft?.accounts[index].name=$0}))
                    accountFields(index)
                    Toggle("All bank activity for this account is listed. Calculate blank activity totals from the entries.",isOn:Binding(get:{workspace.draft?.accounts[index].activityComplete ?? false},set:{workspace.draft?.accounts[index].activityComplete=$0}))
                    Button("Remove account",role:.destructive) { workspace.draft?.accounts.remove(at:index) }
                }.padding(10) }
            }
            Button("Add account") { workspace.draft?.accounts.append(TreasuryAccount()) }
        }
    }
    func accountFields(_ index:Int) -> some View {
        let entries:[(String,WritableKeyPath<TreasuryAccount,String?>)] = [("Beginning bank balance",\.openingBalance),("Statement ending balance",\.statementBalance),("Treasurer’s book balance",\.bookBalance),("Total receipts",\.receipts),("Total payments",\.disbursements),("Transfers in",\.transfersIn),("Transfers out",\.transfersOut),("Deposits in transit",\.depositsInTransit),("Outstanding checks",\.outstandingChecks),("Bank share or hold",\.bankHold)]
        return ForEach(entries.indices,id:\.self) { i in HStack { Text(entries[i].0).frame(maxWidth:.infinity,alignment:.leading);TextField("Needs review",text:accountAmount(index,entries[i].1)).frame(width:140) } }
    }
    func accountPicker(_ value:Binding<String>) -> some View { Picker("Account",selection:value) { Text("Choose account").tag("");ForEach(workspace.draft?.accounts ?? []) { a in Text(a.name).tag(a.id) } } }
    func tx(_ i:Int,_ key:WritableKeyPath<TreasuryTransaction,String>) -> Binding<String> { Binding(get:{workspace.draft?.transactions[i][keyPath:key] ?? ""},set:{workspace.draft?.transactions[i][keyPath:key]=$0}) }
    var activity: some View {
        GroupBox("Receipts, payments and transfers") { VStack(alignment:.leading,spacing:14) {
            ForEach((workspace.draft?.transactions ?? []).indices,id:\.self) { i in VStack(alignment:.leading) {
                TextField("Bank-posted date (YYYY-MM-DD)",text:tx(i,\.date));accountPicker(tx(i,\.account))
                Picker("Entry type",selection:tx(i,\.kind)) { Text("Needs review").tag("review");Text("Receipt").tag("receipt");Text("Payment").tag("payment");Text("Transfer in").tag("transfer_in");Text("Transfer out").tag("transfer_out") }
                TextField("Amount",text:Binding(get:{workspace.draft?.transactions[i].amount ?? ""},set:{workspace.draft?.transactions[i].amount=$0}));TextField("Description",text:tx(i,\.description));TextField("Check / reference",text:tx(i,\.reference));TextField("Category",text:tx(i,\.category));Toggle("Bank-posted date confirmed",isOn:Binding(get:{workspace.draft?.transactions[i].postedDateConfirmed == true},set:{workspace.draft?.transactions[i].postedDateConfirmed=$0}));Button("Remove entry",role:.destructive) { workspace.draft?.transactions.remove(at:i) };Divider()
            } }
            Button("Add activity") { workspace.draft?.transactions.append(TreasuryTransaction(account:workspace.draft?.accounts.first?.id ?? "")) }
        }.padding(10) }
    }
    var funds: some View { GroupBox("Fenced and restricted funds") { VStack(alignment:.leading,spacing:12) {
        ForEach((workspace.draft?.funds ?? []).indices,id:\.self) { i in VStack {
            TextField("Fund name",text:Binding(get:{workspace.draft?.funds[i].name ?? ""},set:{workspace.draft?.funds[i].name=$0}));accountPicker(Binding(get:{workspace.draft?.funds[i].account ?? ""},set:{workspace.draft?.funds[i].account=$0}));TextField("Amount",text:Binding(get:{workspace.draft?.funds[i].amount ?? ""},set:{workspace.draft?.funds[i].amount=$0}));TextField("Restriction / designation",text:Binding(get:{workspace.draft?.funds[i].restriction ?? ""},set:{workspace.draft?.funds[i].restriction=$0}));Button("Remove fund",role:.destructive) { workspace.draft?.funds.remove(at:i) }
        } }
        Button("Add fund") { workspace.draft?.funds.append(TreasuryFund(account:workspace.draft?.accounts.first?.id ?? "")) };Toggle("I confirmed all fund balances and restrictions. If none is listed, none applies.",isOn:flag(\.fundsReviewed))
    }.padding(10) } }
    var obligations: some View { GroupBox("Unpaid obligations and upcoming bills") { VStack(alignment:.leading,spacing:12) {
        ForEach((workspace.draft?.obligations ?? []).indices,id:\.self) { i in VStack {
            TextField("Payee / bill",text:Binding(get:{workspace.draft?.obligations[i].name ?? ""},set:{workspace.draft?.obligations[i].name=$0}));TextField("Amount",text:Binding(get:{workspace.draft?.obligations[i].amount ?? ""},set:{workspace.draft?.obligations[i].amount=$0}));TextField("Due date (YYYY-MM-DD)",text:Binding(get:{workspace.draft?.obligations[i].dueDate ?? ""},set:{workspace.draft?.obligations[i].dueDate=$0}));TextField("Note",text:Binding(get:{workspace.draft?.obligations[i].note ?? ""},set:{workspace.draft?.obligations[i].note=$0}));Button("Remove obligation",role:.destructive) { workspace.draft?.obligations.remove(at:i) }
        } }
        Button("Add obligation") { workspace.draft?.obligations.append(TreasuryObligation()) };Toggle("I confirmed unpaid obligations. If none is listed, none remains unpaid.",isOn:flag(\.obligationsReviewed))
    }.padding(10) } }
    var workflow: some View { VStack(alignment:.leading,spacing:10) {
        if editable { Button("Save corrections") { Task { _ = await workspace.save() } } }
        if let r=workspace.selected {
            if model.user?.role == "owner" && r.status == "draft" && r.preparerUserId != model.user?.id {Button("Prepare this report as WM"){workspace.selectedPreparer = model.user?.id ?? 0; confirmingAssignment = true}.buttonStyle(.borderedProminent)}
            if model.user?.can("treasury.prepare") == true && r.status == "draft" && r.preparerUserId == model.user?.id {
                Button("Sign and finalize report") { pendingWorkflowAction = "preparer-attest" }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canFinalize)
                if !canFinalize {
                    Text("Confirm the source, funds, obligations and each account's activity, then wait for the current PDF preview before finalizing.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if r.status == "ready_for_distribution" && ["owner","secretary"].contains(model.user?.role ?? "") { Button("Mark as distributed") { pendingWorkflowAction = "mark-distributed" } }
        }
    } }
}
