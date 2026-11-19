import AppKit
import SwiftUI
import PDFKit
import UniformTypeIdentifiers

private struct CheckOrderRecord: Decodable, Identifiable {
    struct Signer: Decodable {
        let name: String
        let role: String
        let signedAt: String?
    }

    struct Permissions: Decodable {
        let certify: Bool
        let recordPayment: Bool
        let file: Bool
        let void: Bool

        var needsAction: Bool { certify || recordPayment || file }
    }

    let id: String
    let revision: Int
    let status: String
    let payee: String
    let amount: String
    let reason: String
    let category: String?
    let authorizationReference: String
    let supportingReference: String?
    let supportingDocumentName: String?
    let requestedAt: String
    let requestedBy: String
    let secretaries: [Signer]
    let treasurers: [Signer]
    let checkNumber: String?
    let issuedOn: String?
    let paidBy: String?
    let paidAt: String?
    let ledgerReference: String?
    let deliveredOn: String?
    let deliveryRecordedBy: String?
    let deliveryRecordedAt: String?
    let filingNotes: String?
    let filedBy: String?
    let filedAt: String?
    let voidReason: String?
    let permissions: Permissions

    var amountDisplay: String {
        Decimal(string: amount, locale: LodgeDateTime.locale)?
            .formatted(.currency(code: "USD").locale(Locale(identifier: "en_US"))) ?? amount
    }

    var statusTitle: String {
        switch status {
        case "awaiting_secretaries": return "Awaiting Secretary certification"
        case "ready_for_treasurer": return "Ready for Treasurer"
        case "payment_recorded": return "Check recorded"
        case "filed": return "Filed"
        case "voided": return "Voided"
        default: return "Review status"
        }
    }
}

private struct CheckOrderList: Decodable { let orders: [CheckOrderRecord] }
private struct CheckOrderResult: Decodable { let order: CheckOrderRecord }

private enum CheckOrderEditor: Identifiable {
    case create
    case certify(CheckOrderRecord)
    case payment(CheckOrderRecord)
    case file(CheckOrderRecord)
    case void(CheckOrderRecord)

    var id: String {
        switch self {
        case .create: return "create"
        case .certify(let order): return "certify:\(order.id)"
        case .payment(let order): return "payment:\(order.id)"
        case .file(let order): return "file:\(order.id)"
        case .void(let order): return "void:\(order.id)"
        }
    }

    var record: CheckOrderRecord? {
        switch self {
        case .create: return nil
        case .certify(let order), .payment(let order), .file(let order), .void(let order): return order
        }
    }

    var title: String {
        switch self {
        case .create: return "New Check Order"
        case .certify: return "Certify Check Order"
        case .payment: return "Record Issued Check"
        case .file(let order): return order.status == "filed" ? "Record Check Delivery" : "File Check Order"
        case .void: return "Void Check Order"
        }
    }

    var submitTitle: String {
        switch self {
        case .create: return "Sign and request check"
        case .certify: return "Certify and sign"
        case .payment: return "Sign and record check"
        case .file(let order): return order.status == "filed" ? "Record delivery" : "File check order"
        case .void: return "Void check order"
        }
    }

    var needsSignature: Bool {
        switch self {
        case .create, .certify, .payment: return true
        case .file, .void: return false
        }
    }
}

private struct CheckOrderPDFRequest: Identifiable {
    let order: CheckOrderRecord
    let supportingDocument: Bool
    var id: String { "\(order.id):\(supportingDocument)" }
    var title: String { supportingDocument ? "Supporting document" : "Check Order" }
    var fileName: String { supportingDocument ? order.supportingDocumentName ?? "Supporting document.pdf" : "Check Order \(order.id).pdf" }
}

struct CheckOrdersView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var orders: [CheckOrderRecord] = []
    @State private var selectedID: String?
    @State private var editor: CheckOrderEditor?
    @State private var pdfRequest: CheckOrderPDFRequest?
    @State private var loadID = UUID()
    @State private var updateGuardID = UUID()
    @State private var loaded = false
    @State private var loading = false
    @State private var loadError = ""
    @State private var success = ""

    private var selected: CheckOrderRecord? { orders.first { $0.id == selectedID } }
    private var accentInk: Color { colorScheme == .dark ? .primary : SignTheme.brandNavy }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let selected {
                    detail(selected)
                } else {
                    list
                }
            }
            .frame(maxWidth: 820)
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(SignTheme.page)
        .task(id: model.checkOrderRecordsRevision) { await refresh() }
        .onAppear {
            AppUpdater.shared.setWorkspaceGuard(updateGuardID) {
                editor == nil ? nil : "Finish or close the Check Order form before updating."
            }
        }
        .onDisappear { AppUpdater.shared.setWorkspaceGuard(updateGuardID, check: nil) }
        .sheet(item: $editor) { action in
            CheckOrderEditorView(action: action) { order in
                loadID = UUID()
                orders.removeAll { $0.id == order.id }
                orders.append(order)
                orders.sort { $0.requestedAt > $1.requestedAt }
                selectedID = order.id
                success = successMessage(action)
                editor = nil
                model.checkOrderRecordsRevision += 1
            } onConflict: {
                model.checkOrderRecordsRevision += 1
            }
            .environmentObject(model)
        }
        .sheet(item: $pdfRequest) { request in
            CheckOrderPDFView(request: request).environmentObject(model)
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Spacer(minLength: 8)
                Button {
                    Task { await refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
                if model.user?.role == "owner" {
                    Button {
                        editor = .create
                    } label: {
                        Label("New Check Order", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            notices
            if !loaded && loading {
                ProgressView("Loading check orders…")
                    .frame(maxWidth: .infinity, minHeight: 150)
            } else if orders.isEmpty && loadError.isEmpty {
                ContentUnavailableView("No check orders", systemImage: "doc.plaintext",
                                       description: Text("Check orders will appear here as they are assigned."))
                    .frame(maxWidth: .infinity, minHeight: 180)
            } else {
                let actionable = orders.filter { $0.permissions.needsAction }
                let remaining = orders.filter { !$0.permissions.needsAction }
                if !actionable.isEmpty { orderList("Needs your action", records: actionable) }
                if !remaining.isEmpty { orderList(actionable.isEmpty ? "All check orders" : "Other check orders", records: remaining) }
            }
        }
    }

    private var notices: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !loadError.isEmpty {
                Label(loadError, systemImage: "exclamationmark.circle")
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !success.isEmpty {
                Label(success, systemImage: "checkmark.circle")
                    .foregroundStyle(accentInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.callout)
    }

    private func orderList(_ title: String, records: [CheckOrderRecord]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(records) { order in
                    Button {
                        selectedID = order.id
                        success = ""
                    } label: {
                        HStack(alignment: .center, spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(order.payee).font(.headline)
                                Text(order.statusTitle).font(.callout).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 12)
                            Text(order.amountDisplay).font(.callout.monospacedDigit())
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if order.id != records.last?.id { Divider() }
                }
            }
            .background(SignTheme.surface, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
        }
    }

    private func detail(_ order: CheckOrderRecord) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Button {
                    selectedID = nil
                    success = ""
                } label: {
                    Label("All Check Orders", systemImage: "chevron.left")
                }
                Spacer()
                Button {
                    Task { await refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
            notices
            card {
                Text(order.payee)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(accentInk)
                    .accessibilityAddTraits(.isHeader)
                Text(order.amountDisplay).font(.title3.monospacedDigit())
                Label(order.statusTitle, systemImage: "doc.text")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(accentInk)
                Divider()
                value("Reason for payment", order.reason)
                value("Budget or account category", order.category)
                value("Lodge authorization", order.authorizationReference)
                value("Supporting reference", order.supportingReference)
                if order.status == "voided" {
                    value("Reason for voiding", order.voidReason)
                }
                ViewThatFits(in: .horizontal) {
                    HStack { documentButtons(order) }
                    VStack(alignment: .leading) { documentButtons(order) }
                }
                if order.permissions.needsAction || order.permissions.void {
                    Divider()
                    ViewThatFits(in: .horizontal) {
                        HStack { orderActions(order) }
                        VStack(alignment: .leading) { orderActions(order) }
                    }
                }
            }
            card {
                Text("Signatures").font(.headline).accessibilityAddTraits(.isHeader)
                value("Worshipful Master · \(order.requestedBy)", LodgeDateTime.display(order.requestedAt))
                signerRows(order.secretaries, unsigned: order.status == "voided" ? "Unsigned at voiding" : "Certification pending")
                signerRows(order.treasurers, unsigned: treasuryStatus(order))
            }
            if let check = order.checkNumber, !check.isEmpty {
                card {
                    Text("Check record").font(.headline).accessibilityAddTraits(.isHeader)
                    value("Check number", check)
                    value("Date issued", dateLabel(order.issuedOn))
                    value("Recorded by", order.paidBy)
                    value("Ledger reference", order.ledgerReference)
                    value("Date delivered", dateLabel(order.deliveredOn))
                    if let recorder = order.deliveryRecordedBy {
                        value("Delivery recorded by \(recorder)", LodgeDateTime.display(order.deliveryRecordedAt))
                    }
                    value("Filing notes", order.filingNotes)
                    if let filedBy = order.filedBy {
                        value("Filed by \(filedBy)", LodgeDateTime.display(order.filedAt))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func orderActions(_ order: CheckOrderRecord) -> some View {
        if order.permissions.certify {
            Button("Review and certify") { editor = .certify(order) }.buttonStyle(.borderedProminent)
        }
        if order.permissions.recordPayment {
            Button("Record issued check") { editor = .payment(order) }.buttonStyle(.borderedProminent)
        }
        if order.permissions.file {
            Button(order.status == "filed" ? "Record delivery" : "File check order") {
                editor = .file(order)
            }
            .buttonStyle(.borderedProminent)
        }
        if order.permissions.void {
            Button("Void check order") { editor = .void(order) }
        }
    }

    @ViewBuilder
    private func documentButtons(_ order: CheckOrderRecord) -> some View {
        Button("View Check Order PDF") { pdfRequest = CheckOrderPDFRequest(order: order, supportingDocument: false) }
        if let name = order.supportingDocumentName, !name.isEmpty {
            Button("View supporting PDF") { pdfRequest = CheckOrderPDFRequest(order: order, supportingDocument: true) }
                .help(name)
        }
    }

    private func signerRows(_ people: [CheckOrderRecord.Signer], unsigned: String) -> some View {
        ForEach(people, id: \.role) { person in
            value("\(User.roleLabel(for: person.role)) · \(person.name)",
                  LodgeDateTime.display(person.signedAt, fallback: unsigned))
        }
    }

    private func treasuryStatus(_ order: CheckOrderRecord) -> String {
        switch order.status {
        case "voided": return "Unsigned at voiding"
        case "ready_for_treasurer": return "Available to sign"
        case "payment_recorded", "filed": return "Alternate signer"
        default: return "Available after both certifications"
        }
    }

    @ViewBuilder
    private func value(_ label: String, _ text: String?) -> some View {
        if let text, !text.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(SignTheme.surface, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(SignTheme.cardLine))
    }

    private func dateLabel(_ value: String?) -> String? {
        guard let value, !value.isEmpty,
              let date = LodgeDateTime.formatter("yyyy-MM-dd").date(from: value)
        else { return nil }
        return LodgeDateTime.formatter("EEEE, MMMM d, yyyy").string(from: date)
    }

    private func successMessage(_ action: CheckOrderEditor) -> String {
        switch action {
        case .create: return "Check order signed and routed to the Secretaries."
        case .certify: return "Your certification was recorded."
        case .payment: return "The issued check and your signature were recorded."
        case .file(let order): return order.status == "filed" ? "Check delivery was recorded." : "Check order filed."
        case .void: return "Check order voided."
        }
    }

    private func refresh() async {
        let requestID = UUID()
        loadID = requestID
        let context = model.assistantAccountContext
        loading = true
        defer {
            if loadID == requestID { loading = false; loaded = true }
        }
        do {
            let result: CheckOrderList = try await model.request("/api/check-orders", presentation: .background)
            guard loadID == requestID, model.assistantAccountContext == context, !Task.isCancelled else { return }
            orders = result.orders.sorted { $0.requestedAt > $1.requestedAt }
            if selected == nil { selectedID = nil }
            loadError = ""
        } catch {
            guard loadID == requestID, model.assistantAccountContext == context, !Task.isCancelled else { return }
            loadError = error.localizedDescription
        }
    }
}

private struct CheckOrderEditorView: View {
    struct Attachment {
        let name: String
        let bytes: Data
    }

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let action: CheckOrderEditor
    let onSaved: (CheckOrderRecord) -> Void
    let onConflict: () -> Void

    @State private var requestID = UUID().uuidString.lowercased()
    @State private var payee = ""
    @State private var amount = ""
    @State private var reason = ""
    @State private var category = ""
    @State private var authorizationReference = ""
    @State private var supportingReference = ""
    @State private var supportingDocument: Attachment?
    @State private var choosingDocument = false
    @State private var checkNumber = ""
    @State private var issuedOn = Date()
    @State private var ledgerReference = ""
    @State private var delivered = false
    @State private var deliveredOn = Date()
    @State private var filingNotes = ""
    @State private var consent = false
    @State private var busy = false
    @State private var conflict = false
    @State private var message = ""

    init(action: CheckOrderEditor, onSaved: @escaping (CheckOrderRecord) -> Void, onConflict: @escaping () -> Void) {
        self.action = action
        self.onSaved = onSaved
        self.onConflict = onConflict
        if case .file(let order) = action {
            _ledgerReference = State(initialValue: order.ledgerReference ?? "")
            _filingNotes = State(initialValue: order.filingNotes ?? "")
            _delivered = State(initialValue: order.status == "filed")
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 13) {
                    Text(action.title).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    if let order = action.record {
                        Text("\(order.payee) · \(order.amountDisplay)").font(.headline)
                        Text("Lodge authorization").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(order.authorizationReference)
                    }
                    fields.disabled(busy)
                    if action.needsSignature && model.user?.hasSignature != true {
                        Label("Set up your saved signature in Signature Profile before signing.", systemImage: "signature")
                            .foregroundStyle(.secondary)
                    }
                    if !message.isEmpty {
                        Label(message, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(22)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack(spacing: 12) {
                if busy { ProgressView().controlSize(.small).accessibilityLabel("Saving check order") }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button(action.submitTitle) { Task { await submit() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSubmit)
            }
            .padding(16)
        }
        .frame(minWidth: 420, idealWidth: 555, minHeight: 260, idealHeight: action.record == nil ? 590 : 375)
        .environment(\.timeZone, LodgeDateTime.timeZone)
        .interactiveDismissDisabled(busy)
        .fileImporter(isPresented: $choosingDocument, allowedContentTypes: [.pdf]) { result in
            attach(result)
        }
    }

    @ViewBuilder private var fields: some View {
        switch action {
        case .create:
            TextField("Check payable to", text: $payee)
            VStack(alignment: .leading, spacing: 5) {
                Text("Amount in dollars").font(.subheadline)
                TextField("Amount in dollars", text: $amount, prompt: Text("0.00"))
                    .labelsHidden()
            }
            textArea("Reason for payment", text: $reason)
            TextField("Budget or account category (optional)", text: $category)
            TextField("Lodge authorization reference", text: $authorizationReference)
            Text("Enter the meeting date and motion, or the reference to the recorded authorization.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("Supporting reference (optional)", text: $supportingReference)
            HStack {
                Button(supportingDocument == nil ? "Attach supporting PDF" : "Replace supporting PDF") {
                    choosingDocument = true
                }
                if let supportingDocument {
                    Text(supportingDocument.name).lineLimit(1).help(supportingDocument.name)
                    Button("Remove") { self.supportingDocument = nil }
                }
            }
            Text("I confirm the Lodge authorized this disbursement and I issue this check order for the stated payee and amount.")
            Toggle("Apply my saved signature and route this request to both Secretaries.", isOn: $consent)
        case .certify:
            Text("I certify that I reviewed this check order, its authorization, and its supporting record for transmission to the Treasurer.")
            Toggle("Apply my saved signature to this certification.", isOn: $consent)
        case .payment:
            Text("Use this step after issuing the check. Enter the number and date from the issued check.")
            TextField("Check number", text: $checkNumber)
            DatePicker("Date check issued", selection: $issuedOn, in: ...Date(), displayedComponents: .date)
            Text("I confirm the check was issued for the payee and exact amount on this order, and that the check number and issue date are accurate.")
            Toggle("Apply my saved signature to this check record.", isOn: $consent)
        case .file(let order):
            if order.status == "filed" {
                LabeledContent("Ledger or reference number", value: ledgerReference)
                if !filingNotes.isEmpty { LabeledContent("Filing notes", value: filingNotes) }
                DatePicker("Date delivered", selection: $deliveredOn, in: ...Date(), displayedComponents: .date)
            } else {
                TextField("Ledger or reference number", text: $ledgerReference)
                Toggle("The check has been delivered", isOn: $delivered)
                if delivered {
                    DatePicker("Date delivered", selection: $deliveredOn, in: ...Date(), displayedComponents: .date)
                }
                textArea("Filing notes (optional)", text: $filingNotes)
            }
        case .void:
            Text("Use this step before a check is issued. Voiding closes the order and preserves its signatures in the record.")
            textArea("Reason for voiding", text: $reason)
        }
    }

    private func textArea(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.subheadline)
            TextEditor(text: text)
                .frame(minHeight: 60, idealHeight: 64, maxHeight: 88)
                .padding(3)
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(SignTheme.cardLine))
                .accessibilityLabel(title)
        }
    }

    private var canSubmit: Bool {
        guard !busy, !conflict else { return false }
        if action.needsSignature && (!consent || model.user?.hasSignature != true) { return false }
        switch action {
        case .create:
            return !payee.trimmed.isEmpty && !reason.trimmed.isEmpty && !authorizationReference.trimmed.isEmpty
                && amount.trimmed.range(of: #"^[0-9]{1,9}(?:\.[0-9]{1,2})?$"#, options: .regularExpression) != nil
                && (Decimal(string: amount.trimmed, locale: LodgeDateTime.locale) ?? 0) > 0
        case .certify: return true
        case .payment: return !checkNumber.trimmed.isEmpty
        case .file: return !ledgerReference.trimmed.isEmpty
        case .void: return !reason.trimmed.isEmpty
        }
    }

    private func attach(_ result: Result<URL, Error>) {
        do {
            let url = try result.get()
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let file = try FileHandle(forReadingFrom: url)
            defer { try? file.close() }
            let limit = 2 * 1024 * 1024
            let bytes = try file.read(upToCount: limit + 1) ?? Data()
            guard bytes.count <= limit, bytes.starts(with: Data("%PDF-".utf8)), PDFDocument(data: bytes) != nil else {
                throw ClientError.rejected("Choose a PDF that is 2 MB or smaller.")
            }
            supportingDocument = Attachment(name: url.lastPathComponent, bytes: bytes)
            message = ""
        } catch {
            message = error.localizedDescription
        }
    }

    private func submit() async {
        guard canSubmit else { return }
        let context = model.assistantAccountContext
        busy = true
        message = ""
        defer { busy = false }
        do {
            let (path, fields) = try requestPayload()
            let body = try JSONSerialization.data(withJSONObject: fields)
            let result: CheckOrderResult = try await model.request(path, method: "POST", body: body)
            guard model.assistantAccountContext == context else { return }
            onSaved(result.order)
        } catch ClientError.conflict(let error) {
            guard model.assistantAccountContext == context else { return }
            conflict = action.record != nil
            message = conflict ? "\(error) Close this form and review the latest order." : error
            onConflict()
        } catch {
            guard model.assistantAccountContext == context else { return }
            message = error.localizedDescription
        }
    }

    private func requestPayload() throws -> (String, [String: Any]) {
        let base = "/api/check-orders"
        if case .create = action {
            var fields: [String: Any] = [
                "clientRequestId": requestID, "payee": payee.trimmed, "amount": amount.trimmed, "reason": reason.trimmed,
                "category": category.trimmed, "authorizationReference": authorizationReference.trimmed,
                "supportingReference": supportingReference.trimmed, "consent": consent
            ]
            if let supportingDocument {
                fields["supportingDocument"] = ["name": supportingDocument.name, "base64": supportingDocument.bytes.base64EncodedString()]
            }
            return (base, fields)
        }
        guard let record = action.record, UUID(uuidString: record.id) != nil else { throw ClientError.invalidResponse }
        let path = "\(base)/\(record.id)"
        var fields: [String: Any] = ["revision": record.revision]
        switch action {
        case .create: throw ClientError.invalidResponse
        case .certify:
            fields["consent"] = consent
            return ("\(path)/certify", fields)
        case .payment:
            fields["consent"] = consent
            fields["checkNumber"] = checkNumber.trimmed
            fields["issuedOn"] = LodgeCalendarDates.key(issuedOn)
            return ("\(path)/record-payment", fields)
        case .file:
            fields["ledgerReference"] = ledgerReference.trimmed
            fields["filingNotes"] = filingNotes.trimmed
            if delivered { fields["deliveredOn"] = LodgeCalendarDates.key(deliveredOn) }
            return ("\(path)/file", fields)
        case .void:
            fields["reason"] = reason.trimmed
            return ("\(path)/void", fields)
        }
    }
}

private struct CheckOrderPDFView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let request: CheckOrderPDFRequest
    @State private var bytes: Data?
    @State private var message = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(request.title).font(.headline)
                Spacer()
                Button("Save PDF") {
                    if let bytes { saveDocument(bytes, name: request.fileName, type: .pdf) }
                }
                .disabled(bytes == nil)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(14)
            Divider()
            if !message.isEmpty {
                ContentUnavailableView("PDF unavailable", systemImage: "doc.text", description: Text(message))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let bytes {
                LodgeDocumentPreview(data: bytes)
            } else {
                ProgressView("Opening PDF…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 420, idealWidth: 730, minHeight: 360, idealHeight: 620)
        .task {
            let context = model.assistantAccountContext
            do {
                let data = try await model.checkOrderPDF(id: request.order.id, supportingDocument: request.supportingDocument)
                guard !Task.isCancelled, context == model.assistantAccountContext else { return }
                guard PDFDocument(data: data) != nil else { throw ClientError.invalidResponse }
                bytes = data
            } catch {
                guard !Task.isCancelled, context == model.assistantAccountContext else { return }
                message = error.localizedDescription
            }
        }
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
