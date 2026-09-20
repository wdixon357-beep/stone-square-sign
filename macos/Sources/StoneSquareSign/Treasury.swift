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
    var fieldReviews: [String:String]? = nil
}
struct TreasuryRecord: Codable, Identifiable { var id: String; var status: String; var revision: Int; var createdByUserId: Int; var preparerUserId: Int?; var supersededByReportId: String? = nil; var uploadedBy: String; var createdBy: String; var preparerRole: String; var draft: TreasuryDraft }
extension TreasuryRecord {
    func canOpen(for user: User?) -> Bool {
        user?.can("treasury.prepare") == true || (user?.can("treasury.view") == true && ["ready_for_distribution", "distributed"].contains(status))
    }
}
struct TreasuryPayload: Decodable { var report: TreasuryRecord; var notificationWarnings: [String]?; var organizationWarning: String? }
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
    @Published var bankingSource = ""; @Published var bankingFiles: [URL] = []; @Published var messageIsWarning = false; @Published var message = "" { didSet { messageIsWarning = false } }; @Published var busy = false { didSet { if !busy { Task { await consumePendingRefresh() } } } }
    @Published var pdf: Data?; @Published var previewMessage = ""; @Published var dirty = false { didSet { if !dirty { Task { await consumePendingRefresh() } } } }
    @Published var preparers: [TreasuryPreparer] = []; @Published var selectedPreparer = 0
    @Published var originalText = ""; @Published var sourceFiles: [TreasurySourceFile] = []; @Published var accessUsers: [TreasuryAccessUser] = []
    @Published var serviceUpdateRequired = false
    @Published var generationStatus: GenerationStatus?
    private var owner = false
    let transport: MinutesWorkspace
    private var previewTask: Task<Void,Never>?; private var generation = 0; private var refreshInFlight = false; private var refreshPending = false
    init(session: URLSession = .shared) { transport = MinutesWorkspace(session: session) }
    func configure(_ model: AppModel) { transport.configure(model); owner = model.user?.role == "owner" }
    func requestLiveRefresh() async { refreshPending = true; await consumePendingRefresh() }
    func consumePendingRefresh() async {
        guard refreshPending, !refreshInFlight, !busy, !dirty, selected == nil else { return }
        refreshPending = false
        await refresh()
    }
    func refresh() async {
        if refreshInFlight { refreshPending = true; return }
        refreshInFlight = true
        defer { refreshInFlight = false; if refreshPending { Task { await self.consumePendingRefresh() } } }
        await refreshGenerationStatus()
        do {
            records = try JSONDecoder().decode(TreasuryList.self, from: await transport.request("/api/treasury")).reports
            serviceUpdateRequired = false
        } catch ClientError.serviceUpdateRequired(let detail) {
            serviceUpdateRequired = true; message = detail
        } catch { message = error.localizedDescription }
    }
    func refreshGenerationStatus() async { generationStatus = await GenerationStatus.load(using: transport) }
    func open(_ report: TreasuryRecord) {
        selectedPreparer=report.preparerUserId ?? 0; originalText="";sourceFiles=[]
        Task { await loadSources(report.id); await refreshGenerationStatus() }
        selected = report; var opened=report.draft;opened.fieldReviews = opened.fieldReviews ?? [:]
        let accountFields=["openingBalance","statementBalance","bookBalance","receipts","disbursements","transfersIn","transfersOut","depositsInTransit","outstandingChecks"]
        let transactionFields=["date","account","kind","amount","description","reference"]
        let fundFields=["name","account","amount","restriction"], obligationFields=["name","amount","dueDate","note"]
        for index in opened.accounts.indices { for name in accountFields { addReviewPath(&opened,"accounts.\(index).\(name)") } }
        for index in opened.transactions.indices { for name in transactionFields { addReviewPath(&opened,"transactions.\(index).\(name)") } }
        for index in opened.funds.indices { for name in fundFields { addReviewPath(&opened,"funds.\(index).\(name)") } }
        for index in opened.obligations.indices { for name in obligationFields { addReviewPath(&opened,"obligations.\(index).\(name)") } }
        draft = opened; dirty = false; pdf = nil; preview()
    }
    private func addReviewPath(_ draft: inout TreasuryDraft,_ path:String) { if draft.fieldReviews?[path] == nil { draft.fieldReviews?[path]="unresolved" } }
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
            let payload=try JSONDecoder().decode(TreasuryPayload.self,from:data);let report=payload.report;open(report);await refresh();message=payload.organizationWarning?.isEmpty == false ? payload.organizationWarning! : "Assigned to \(report.createdBy). The original records were organized into the prefilled report."
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
    func close() { previewTask?.cancel(); generation += 1; selected = nil; draft = nil; pdf = nil; dirty = false; Task { await consumePendingRefresh() } }
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
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"sourceText\"\r\n\r\n\(bankingSource)\r\n")
            if bankingFiles.count > 5 { throw ClientError.server("Choose no more than five files total.") }
            var total = 0
            for file in bankingFiles {
                let bytes = try Data(contentsOf: file); total += bytes.count
                if bytes.count > 12*1024*1024 || total > 20*1024*1024 { throw ClientError.server("Use files under 12 MB each and 20 MB combined.") }
                let name = file.lastPathComponent.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
                append("--\(boundary)\r\nContent-Disposition: form-data; name=\"files\"; filename=\"\(name)\"\r\nContent-Type: application/octet-stream\r\n\r\n"); data.append(bytes); append("\r\n")
            }
            append("--\(boundary)--\r\n")
            let result = try await transport.request("/api/treasury/generate", method: "POST", body: data, contentType: "multipart/form-data; boundary=\(boundary)")
            let report = try JSONDecoder().decode(TreasuryPayload.self, from: result).report
            await refresh(); bankingSource = ""; bankingFiles = []
            if report.status == "awaiting_preparer" {close();message="Banking information saved. The Dashboard alert closes when a preparer claims it or a signed report covers that reporting period."}
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
    @State private var editorPane = 0
    var editable: Bool { guard model.user?.can("treasury.prepare") == true, let r = workspace.selected else { return false }; return r.status == "draft" && r.preparerUserId == model.user?.id }
    var canFinalize: Bool {
        guard editable, let draft = workspace.draft else { return false }
        return draft.sourceReviewed && draft.fundsReviewed && draft.obligationsReviewed
            && draft.accounts.allSatisfy(\.activityComplete)
            && !(draft.fieldReviews ?? [:]).contains { path,state in state == "unresolved" && financialReviewRequired(path) && !reviewValue(path).trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && reviewValue(path) != "review" }
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
        .onChange(of: model.treasuryRecordsRevision) { _, _ in
            Task { await workspace.requestLiveRefresh() }
        }
        .sheet(item: $readonlyReport) { report in FinalReportBrowserView(kind: .treasury, initialSelection: report.id, onClose: { readonlyReport = nil }).environmentObject(model).frame(minWidth: 620, idealWidth: 900, minHeight: 540, idealHeight: 700) }
        .sheet(isPresented: $showingHistory) { FinalReportBrowserView(kind: .treasury, onClose: { showingHistory = false }).environmentObject(model).frame(minWidth: 620, idealWidth: 900, minHeight: 540, idealHeight: 700) }
        .onChange(of:workspace.draft) { old,new in if old != nil && new != nil { workspace.dirty = new != workspace.selected?.draft; workspace.preview() } }
        .onChange(of: workspace.selected?.status) { _, status in
            editorSection = status == "awaiting_preparer" || workspace.draft?.transactions.isEmpty != false ? 0 : 2
        }
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
            GroupBox("Banking records") { VStack(alignment:.leading,spacing:12) {
                GenerationStatusView(status: workspace.generationStatus)
                Text("Add the banking records once. Account names and statement headings are used to separate checking, savings and any additional accounts automatically.").font(.callout).foregroundStyle(.secondary)
                Button("Choose banking files") { let panel=NSOpenPanel();panel.allowsMultipleSelection=true;panel.allowedContentTypes=[.pdf,.png,.jpeg,.plainText];if panel.runModal() == .OK { workspace.bankingFiles=panel.urls } }
                ForEach(workspace.bankingFiles,id:\.self) { Text($0.lastPathComponent).font(.caption) }
                if !workspace.bankingFiles.isEmpty { Button("Clear banking files") { workspace.bankingFiles=[] } }
                Text("Upload statements, transaction screenshots or exported records, or paste transactions, balances and banking notes below. Include the account or product name when typing information.").font(.callout).foregroundStyle(.secondary)
                TextEditor(text:$workspace.bankingSource).font(.body).frame(minHeight:160).border(Color.gray.opacity(0.25))
            }.padding(12) }
            GroupBox("Report handoff") { VStack(alignment:.leading,spacing:12) {
                Text("Report dates are set automatically. Add bank-posted dates for transactions. Use no more than five files total.").font(.callout).foregroundStyle(.secondary)
                Picker("What would you like to do?",selection:$workspace.uploadIntent) {
                    Text("Save banking information for a report").tag("save")
                    if model.user?.can("treasury.prepare") == true {Text("I’m completing the report").tag("complete")}
                }.pickerStyle(.radioGroup)
                Text("The uploaded banking information is organized into a prefilled report. Save it for another authorized preparer, or open the prefilled report and complete it yourself.").font(.caption)
                Button("Continue") { Task { await workspace.generate() } }.buttonStyle(.borderedProminent).disabled(workspace.bankingSource.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && workspace.bankingFiles.isEmpty)
            }.padding(12) } }
            if model.user?.role == "owner" { DisclosureGroup("Bank record upload access") { Text("Allow an account to supply records for another preparing officer. This does not grant bank login or other Lodge permissions.").font(.caption)
                ForEach(workspace.accessUsers.filter { !$0.canPrepare }) { user in HStack { Text(user.name); Spacer(); Button(user.uploadEnabled ? "Remove upload access" : "Allow bank record uploads") { pendingAccessUser = user } } }
            } }
            ForEach(workspace.records) { record in HStack { VStack(alignment:.leading) { Text(record.draft.periodEnd.isEmpty ? "Reporting date needs review" : LodgeCalendarDates.displayDate(record.draft.periodEnd)).font(.headline);Text("\(record.preparerUserId == model.user?.id ? "Assigned to you" : record.createdBy.isEmpty ? "Available for a preparer" : record.createdBy) · Uploaded by \(record.uploadedBy) · \((record.status == "awaiting_preparer" ? "Banking information saved for a report" : record.status == "superseded" ? "Covered period, source retained for review" : record.status.replacingOccurrences(of:"_",with:" ")))").font(.caption) }; Spacer();if record.canOpen(for: model.user) { Button("Review") { if model.user?.can("treasury.prepare") != true && ["ready_for_distribution", "distributed"].contains(record.status) { readonlyReport = record } else { workspace.open(record) } } }; if model.user?.can("treasury.prepare") == true && ["draft","awaiting_preparer"].contains(record.status) && (model.user?.role == "owner" || record.createdByUserId == model.user?.id || record.preparerUserId == model.user?.id) { Button("Delete",role:.destructive) { deleting=record } } }.padding(14).background(.background,in:RoundedRectangle(cornerRadius:12)) }
        } }.formStyle(.grouped)
    }
    var editor: some View {
        AdaptiveWorkspaceSplit(primaryTitle: "Report entries", secondaryTitle: "Document preview", compactPane: $editorPane) {
            VStack(spacing: 0) {
                Picker("Report section", selection: $editorSection) {
                    Text("Details").tag(0); Text("Accounts").tag(1); Text("Transactions").tag(2); Text("Review").tag(3)
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
                            Button("Confirm all prefilled values") { confirmPrefilledValues() }
                            Text("Green values are matched, confirmed or corrected. Gold values were prefilled and await confirmation. Red fields need information.").font(.caption).foregroundStyle(.secondary)
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
            }
        } secondary: {
            VStack(alignment: .leading, spacing: 10) {
                HStack { Text("Document preview").font(.headline); Spacer(); Button("Save PDF") { if let pdf = workspace.pdf { saveDocument(pdf, name: "Treasurer Report.pdf", type: .pdf) } }.disabled(workspace.pdf == nil || workspace.previewMessage != "Preview matches the current fields.") }
                Text(workspace.previewMessage).font(.caption).foregroundStyle(.secondary)
                LodgeDocumentPreview(data: workspace.pdf)
            }.padding(16)
        }
    }
    var handoff: some View { VStack(alignment:.leading,spacing:12) {
        if let record=workspace.selected {
            Text("Uploaded by \(record.uploadedBy)").font(.caption)
            if record.status == "awaiting_preparer" {
                Text("Prefilled report ready").font(.headline)
                Text("The uploaded banking information has been organized into this report. Claim it to confirm or correct the values and finish the report. The claim prevents another officer from working on the same report.").font(.callout)
                if model.user?.can("treasury.prepare") == true { Button("Claim this prefilled report") { workspace.selectedPreparer = model.user?.id ?? 0; confirmingAssignment = true }.buttonStyle(.borderedProminent) }
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
    func reviewState(_ path:String) -> String { workspace.draft?.fieldReviews?[path] ?? "unresolved" }
    func reviewed(_ path:String,_ value:Binding<String>) -> Binding<String> { Binding(get:{value.wrappedValue},set:{newValue in value.wrappedValue=newValue;workspace.draft?.fieldReviews?[path]=newValue.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || newValue == "review" ? "unresolved" : "corrected"}) }
    func reviewedField(_ label:String,_ path:String,_ value:Binding<String>) -> some View { HStack { TextField(label,text:reviewed(path,value));reviewButton(path) } }
    func reviewedAccountPicker(_ path:String,_ value:Binding<String>) -> some View { HStack { accountPicker(reviewed(path,value));reviewButton(path) } }
    func clearCollectionReviews(_ collection:String) {
        workspace.draft?.fieldReviews = workspace.draft?.fieldReviews?.filter { !$0.key.hasPrefix("\(collection).") }
        workspace.draft?.extractionNotes = workspace.draft?.extractionNotes.flatMap { note in
            note.components(separatedBy:"\n").filter { !$0.contains("Source evidence: \(collection)[") }
        } ?? []
    }
    func accountAmount(_ index:Int,_ key:WritableKeyPath<TreasuryAccount,String?>,_ field:String) -> Binding<String> { Binding(get:{workspace.draft?.accounts[index][keyPath:key] ?? ""},set:{value in workspace.draft?.accounts[index][keyPath:key]=value;workspace.draft?.fieldReviews?["accounts.\(index).\(field)"]=value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? "unresolved" : "corrected"}) }
    func reviewValue(_ path:String) -> String {
        let parts=path.split(separator:".").map(String.init)
        guard parts.count == 3, let index=Int(parts[1]), let draft=workspace.draft else { return "" }
        switch parts[0] {
        case "accounts" where draft.accounts.indices.contains(index):
            let account=draft.accounts[index]
            switch parts[2] { case "openingBalance":return account.openingBalance ?? "";case "statementBalance":return account.statementBalance ?? "";case "bookBalance":return account.bookBalance ?? "";case "receipts":return account.receipts ?? "";case "disbursements":return account.disbursements ?? "";case "transfersIn":return account.transfersIn ?? "";case "transfersOut":return account.transfersOut ?? "";case "depositsInTransit":return account.depositsInTransit ?? "";case "outstandingChecks":return account.outstandingChecks ?? "";default:return "" }
        case "transactions" where draft.transactions.indices.contains(index):
            let row=draft.transactions[index]
            switch parts[2] { case "date":return row.date;case "account":return row.account;case "kind":return row.kind;case "amount":return row.amount ?? "";case "description":return row.description;case "reference":return row.reference;default:return "" }
        case "funds" where draft.funds.indices.contains(index):
            let row=draft.funds[index]
            switch parts[2] { case "name":return row.name;case "account":return row.account;case "amount":return row.amount ?? "";case "restriction":return row.restriction;default:return "" }
        case "obligations" where draft.obligations.indices.contains(index):
            let row=draft.obligations[index]
            switch parts[2] { case "name":return row.name;case "amount":return row.amount ?? "";case "dueDate":return row.dueDate;case "note":return row.note;default:return "" }
        default:return ""
        }
    }
    func financialReviewRequired(_ path:String) -> Bool {
        let parts=path.split(separator:".").map(String.init);guard parts.count == 3 else{return false}
        switch parts[0] {case "accounts":return parts[2] != "bankHold";case "transactions":return ["date","account","kind","amount","description"].contains(parts[2]);case "funds":return ["name","account","amount"].contains(parts[2]);case "obligations":return ["name","amount"].contains(parts[2]);default:return false}
    }
    func confirmPrefilledValues() {
        guard var reviews=workspace.draft?.fieldReviews else { return }
        var confirmed=0
        for path in reviews.keys where reviews[path] == "unresolved" && !reviewValue(path).trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && reviewValue(path) != "review" { reviews[path]="confirmed";confirmed += 1 }
        workspace.draft?.fieldReviews=reviews;workspace.draft?.sourceReviewed=true;workspace.dirty=true
        workspace.message=confirmed == 0 ? "The uploaded information was marked reviewed. Empty fields still need information." : "\(confirmed) prefilled \(confirmed == 1 ? "value was" : "values were") confirmed. Empty fields still need information."
        workspace.preview()
    }
    func reviewButton(_ path:String) -> some View {
        let state=reviewState(path),good=["matched","confirmed","corrected"].contains(state),hasValue = !reviewValue(path).trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && reviewValue(path) != "review"
        return Button {
            if good { workspace.draft?.fieldReviews?[path] = "unresolved";workspace.message = "Check this value against the uploaded banking information, then confirm it or enter the correction." }
            else if hasValue { workspace.draft?.fieldReviews?[path] = "confirmed";workspace.message = "Value confirmed against the uploaded banking information." }
            else { workspace.message = "This information was not found in the upload. Enter the correct value." }
            workspace.dirty=true;workspace.preview()
        } label: {
            Label(state == "matched" ? "Matched to uploaded source" : state == "confirmed" ? "Officer confirmed" : state == "corrected" ? "Officer correction recorded" : hasValue ? "Confirm this value" : "Needs information", systemImage: good ? "checkmark.circle.fill" : hasValue ? "questionmark.circle.fill" : "xmark.circle.fill")
                .labelStyle(.iconOnly).foregroundStyle(good ? Color.green : hasValue ? Color.orange : Color.red).font(.title3)
        }.buttonStyle(.plain).help(good ? "Matched, confirmed or corrected. Select if this value is incorrect." : hasValue ? "Select to confirm this prefilled value." : "Enter the missing information in this field.")
    }
    var accounts: some View {
        VStack(alignment:.leading,spacing:16) {
            ForEach(Array((workspace.draft?.accounts ?? []).enumerated()),id:\.element.id) { index,account in
                GroupBox(account.name) { VStack(alignment:.leading,spacing:10) {
                    TextField("Account label",text:Binding(get:{workspace.draft?.accounts[index].name ?? ""},set:{workspace.draft?.accounts[index].name=$0}))
                    accountFields(index)
                    Toggle("All bank activity for this account is listed. Calculate blank activity totals from the entries.",isOn:Binding(get:{workspace.draft?.accounts[index].activityComplete ?? false},set:{workspace.draft?.accounts[index].activityComplete=$0}))
                    Button("Remove account",role:.destructive) { clearCollectionReviews("accounts");workspace.draft?.accounts.remove(at:index) }
                }.padding(10) }
            }
            Button("Add account") { clearCollectionReviews("accounts");workspace.draft?.accounts.append(TreasuryAccount()) }
        }
    }
    func accountFields(_ index:Int) -> some View {
        let entries:[(String,String,WritableKeyPath<TreasuryAccount,String?>)] = [("Beginning Balance","openingBalance",\.openingBalance),("Total Receipts","receipts",\.receipts),("Total Disbursements","disbursements",\.disbursements),("Transfers In","transfersIn",\.transfersIn),("Transfers Out","transfersOut",\.transfersOut),("Bank Statement Ending Balance","statementBalance",\.statementBalance),("Deposits in Transit","depositsInTransit",\.depositsInTransit),("Outstanding Checks","outstandingChecks",\.outstandingChecks),("Treasurer’s Book Balance","bookBalance",\.bookBalance)]
        return ForEach(entries.indices,id:\.self) { i in HStack { Text(entries[i].0).frame(maxWidth:.infinity,alignment:.leading);TextField("Enter correct value",text:accountAmount(index,entries[i].2,entries[i].1)).frame(width:140);reviewButton("accounts.\(index).\(entries[i].1)") } }
    }
    func accountPicker(_ value:Binding<String>) -> some View { Picker("Account",selection:value) { Text("Choose account").tag("");ForEach(workspace.draft?.accounts ?? []) { a in Text(a.name).tag(a.id) } } }
    func tx(_ i:Int,_ key:WritableKeyPath<TreasuryTransaction,String>) -> Binding<String> { Binding(get:{workspace.draft?.transactions[i][keyPath:key] ?? ""},set:{workspace.draft?.transactions[i][keyPath:key]=$0}) }
    func txAmount(_ i:Int) -> Binding<String> { Binding(get:{workspace.draft?.transactions[i].amount ?? ""},set:{workspace.draft?.transactions[i].amount=$0}) }
    var activity: some View {
        GroupBox { VStack(alignment:.leading,spacing:14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("BANK-POSTED HISTORY").font(.caption2).fontWeight(.bold).foregroundStyle(.secondary)
                    Text("Transactions").font(.title3).fontWeight(.semibold)
                }
                Spacer()
                Text("\(workspace.draft?.transactions.count ?? 0)").font(.headline).padding(.horizontal, 12).padding(.vertical, 7).background(Color.accentColor.opacity(0.12), in: Capsule())
            }
            Text("Every current-period entry organized from the uploaded PDF, screenshot, pasted activity or typed notes appears here. Confirm the account, bank-posted date, description, direction and amount. These entries become the Receipts, Disbursements and Transfers sections of the report.").font(.callout).foregroundStyle(.secondary)
            if workspace.draft?.transactions.isEmpty != false {
                Text("No current-period transactions were found. No bank-posted activity from \(workspace.draft?.periodStart ?? "the first included date") through \(workspace.draft?.periodEnd ?? "the report preparation date") appeared in the uploaded records. Earlier statements remain available under Original banking records and notes, but their transactions are not included in this report.").font(.callout).fontWeight(.semibold).foregroundStyle(.orange)
            } else if let count=workspace.draft?.transactions.count {
                Text("\(count) current-period \(count == 1 ? "transaction was" : "transactions were") organized from the uploaded records.").font(.callout).fontWeight(.semibold)
            }
            ForEach((workspace.draft?.transactions ?? []).indices,id:\.self) { i in VStack(alignment:.leading, spacing: 10) {
                HStack { Text("Transaction \(i + 1)").font(.headline); Spacer(); Text(workspace.draft?.transactions[i].date.isEmpty == false ? LodgeCalendarDates.displayDate(workspace.draft?.transactions[i].date ?? "") : "Date not found").font(.caption).foregroundStyle(.secondary) }
                reviewedField("Bank-posted date (YYYY-MM-DD)","transactions.\(i).date",tx(i,\.date));reviewedAccountPicker("transactions.\(i).account",tx(i,\.account))
                HStack { Picker("Entry type",selection:reviewed("transactions.\(i).kind",tx(i,\.kind))) { Text("Needs correction").tag("review");Text("Receipt").tag("receipt");Text("Disbursement").tag("payment");Text("Transfer into this account").tag("transfer_in");Text("Transfer out of this account").tag("transfer_out") };reviewButton("transactions.\(i).kind") }
                reviewedField("Amount","transactions.\(i).amount",txAmount(i));reviewedField("Description used on the report","transactions.\(i).description",tx(i,\.description));reviewedField("Check number or reference","transactions.\(i).reference",tx(i,\.reference));Toggle("Bank-posted date confirmed",isOn:Binding(get:{workspace.draft?.transactions[i].postedDateConfirmed == true},set:{workspace.draft?.transactions[i].postedDateConfirmed=$0}));Button("Remove transaction",role:.destructive) { clearCollectionReviews("transactions");workspace.draft?.transactions.remove(at:i) };Divider()
            } }
            Button("Add transaction") { clearCollectionReviews("transactions");workspace.draft?.transactions.append(TreasuryTransaction(account:workspace.draft?.accounts.first?.id ?? "")) }
        }.padding(10) }
    }
    var funds: some View { GroupBox("Fenced Money") { VStack(alignment:.leading,spacing:12) {
        ForEach((workspace.draft?.funds ?? []).indices,id:\.self) { i in VStack {
            reviewedField("Fund name","funds.\(i).name",Binding(get:{workspace.draft?.funds[i].name ?? ""},set:{workspace.draft?.funds[i].name=$0}));reviewedAccountPicker("funds.\(i).account",Binding(get:{workspace.draft?.funds[i].account ?? ""},set:{workspace.draft?.funds[i].account=$0}));reviewedField("Amount","funds.\(i).amount",Binding(get:{workspace.draft?.funds[i].amount ?? ""},set:{workspace.draft?.funds[i].amount=$0}));reviewedField("Restriction / designation","funds.\(i).restriction",Binding(get:{workspace.draft?.funds[i].restriction ?? ""},set:{workspace.draft?.funds[i].restriction=$0}));Button("Remove fund",role:.destructive) { clearCollectionReviews("funds");workspace.draft?.funds.remove(at:i) }
        } }
        Button("Add fund") { clearCollectionReviews("funds");workspace.draft?.funds.append(TreasuryFund(account:workspace.draft?.accounts.first?.id ?? "")) };Toggle("I confirmed all Fenced Money. If none is listed, none applies.",isOn:flag(\.fundsReviewed))
    }.padding(10) } }
    var obligations: some View { GroupBox("Outstanding Obligations") { VStack(alignment:.leading,spacing:12) {
        ForEach((workspace.draft?.obligations ?? []).indices,id:\.self) { i in VStack {
            reviewedField("Payee / bill","obligations.\(i).name",Binding(get:{workspace.draft?.obligations[i].name ?? ""},set:{workspace.draft?.obligations[i].name=$0}));reviewedField("Amount","obligations.\(i).amount",Binding(get:{workspace.draft?.obligations[i].amount ?? ""},set:{workspace.draft?.obligations[i].amount=$0}));reviewedField("Due date (YYYY-MM-DD)","obligations.\(i).dueDate",Binding(get:{workspace.draft?.obligations[i].dueDate ?? ""},set:{workspace.draft?.obligations[i].dueDate=$0}));reviewedField("Note","obligations.\(i).note",Binding(get:{workspace.draft?.obligations[i].note ?? ""},set:{workspace.draft?.obligations[i].note=$0}));Button("Remove obligation",role:.destructive) { clearCollectionReviews("obligations");workspace.draft?.obligations.remove(at:i) }
        } }
        Button("Add obligation") { clearCollectionReviews("obligations");workspace.draft?.obligations.append(TreasuryObligation()) };Toggle("I confirmed all Outstanding Obligations. If none are listed, none applies.",isOn:flag(\.obligationsReviewed))
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
