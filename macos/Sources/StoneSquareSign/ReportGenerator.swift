import AppKit
import Foundation
import SwiftUI
import PDFKit

struct NativeReportField: Identifiable {
    let id: String; let label: String; let kind: String; let required: Bool; let hint: String
    let picks: [String]; let choices: [[String]]
    init(_ raw: [String: Any]) {
        id = raw["id"] as? String ?? ""; label = raw["label"] as? String ?? ""
        kind = raw["kind"] as? String ?? "text"; required = raw["req"] as? Bool ?? false
        hint = raw["hint"] as? String ?? ""; picks = raw["options"] as? [String] ?? []
        choices = raw["options"] as? [[String]] ?? []
    }
}

struct ReportOrganization: Decodable {
    struct Evidence: Decodable { let field: String; let quote: String }
    let fields: [String: String]
    let warnings: [String]
    let evidence: [Evidence]
}

private struct ReportHandoffResponse: Decodable {
    let url: String
    let assertion: String
    let expiresAt: Int
}

// Native controls consume the same published schema and report endpoint as the web.
// The Sign session and stored Lodge signatures are never passed to this service.
@MainActor
final class ReportBrowserModel: ObservableObject {
    static let reportURL = URL(string: "https://request.stonesquare22pha.org/report")!
    private static let reportAPIURL = URL(string: "https://request.stonesquare22pha.org/api/report")!
    @Published var schema: [String: Any] = [:]
    @Published var isOfficer = true
    @Published var name = ""
    @Published var email = ""
    @Published var phone = ""
    @Published var type = "officer"
    @Published var fields: [String: String] = [:]
    @Published var source = ""
    @Published var organization: ReportOrganization?
    @Published var organizing = false
    private var organizationKey: Data?
    private var revision = 0
    @Published var reviewed = false
    @Published var signatureName = ""
    @Published var pdf: Data?
    @Published var busy = false
    @Published var error: String?
    @Published var messageIsWarning = false
    @Published var message = "" { didSet { messageIsWarning = false } }
    @Published var draftSaved = false
    var clientId = UUID().uuidString
    private weak var appModel: AppModel?
    private var assertion = ""
    private var assertionExpiresAt = Date.distantPast
    private var assertionUserID: Int?
    private var configuredUserID: Int?
    private var loadedDraftUserID: Int?
    private var previewKey: Data?
    var officers: [[String: String]] { schema["officers"] as? [[String: String]] ?? [] }
    var office: String { appModel?.user?.role == "owner" ? "Worshipful Master" : appModel?.user?.roleLabel ?? "Lodge Officer" }
    var isMaster: Bool { appModel?.user?.role == "owner" }
    var recipient: String { isMaster ? "your Lodge inbox" : "the Worshipful Master" }
    var types: [String: [String: Any]] { schema[isMaster ? "masterTypes" : "types"] as? [String: [String: Any]] ?? [:] }
    var reportFields: [NativeReportField] { (types[type]?["fields"] as? [[String: Any]] ?? []).map(NativeReportField.init) }
    var reviewStatement: String { schema["reviewStatement"] as? String ?? "I have reviewed this report and confirm its accuracy." }
    var previewCurrent: Bool { previewKey == contentKey() && pdf != nil }
    let persistenceURL: URL?
    private let session: URLSession

    init(persistenceURL: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("Stone Square Sign/report-draft.json"), session: URLSession = .shared) {
        self.persistenceURL = persistenceURL
        self.session = session
        guard let url = persistenceURL, let data = try? Data(contentsOf: url),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let timestamp = raw["savedAt"] as? Double, Date().timeIntervalSince1970 - timestamp < 7 * 86400 else { return }
        isOfficer = raw["isOfficer"] as? Bool ?? true; name = raw["name"] as? String ?? ""
        email = raw["email"] as? String ?? ""; phone = raw["phone"] as? String ?? ""
        type = raw["type"] as? String ?? "officer"; fields = raw["fields"] as? [String: String] ?? [:]
        source = raw["source"] as? String ?? ""
        clientId = raw["clientId"] as? String ?? UUID().uuidString
        loadedDraftUserID = raw["userId"] as? Int
        draftSaved = true
    }
    func configure(_ model: AppModel) {
        appModel = model
        guard let user = model.user else { return }
        let belongsToAnotherUser = loadedDraftUserID.map { $0 != user.id } ?? (draftSaved && user.role != "owner")
        if belongsToAnotherUser || configuredUserID.map({ $0 != user.id }) == true {
            phone = ""; type = "officer"; fields = [:]; source = ""; reviewed = false; signatureName = ""
            organization = nil; pdf = nil; previewKey = nil; clientId = UUID().uuidString; draftSaved = false
            loadedDraftUserID = nil
        }
        if assertionUserID != user.id {
            assertion = ""; assertionExpiresAt = .distantPast; assertionUserID = nil
        }
        configuredUserID = user.id
        isOfficer = true
        name = user.name
        email = user.email
    }
    func payload() -> [String: Any] {
        ["phone": phone, "type": type, "fields": fields, "reviewed": reviewed, "clientId": clientId]
    }
    func contentKey() -> Data? {
        var object = payload(); object.removeValue(forKey: "reviewed"); object.removeValue(forKey: "signatureName")
        return try? JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
    }
    func changed() {
        reviewed = false; signatureName = ""; previewKey = nil; pdf = nil
        organization = nil; organizationKey = nil; revision += 1
        draftSaved = false
        var object = payload(); object["source"] = source; object["reviewed"] = false; object["signatureName"] = ""; object["savedAt"] = Date().timeIntervalSince1970
        if let configuredUserID { object["userId"] = configuredUserID; loadedDraftUserID = configuredUserID }
        if let url = persistenceURL, let data = try? JSONSerialization.data(withJSONObject: object) {
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try data.write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
                draftSaved = true
            } catch { self.error = "This draft could not be saved on this Mac. Keep the report open and save a PDF when ready." }
        }
    }
    private var organizerFieldIDs: Set<String> {
        Set(reportFields.flatMap { $0.kind == "choices" ? [$0.id, $0.id + "Other"] : [$0.id] })
    }
    private func organizerKey() -> Data? {
        try? JSONSerialization.data(withJSONObject: ["source": source, "type": type, "master": isMaster, "fields": fields], options: .sortedKeys)
    }
    func organize(using model: AppModel) async {
        guard !busy, !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard let key = organizerKey() else { return }
        let startingRevision = revision
        busy = true; organizing = true; organization = nil; organizationKey = nil; error = nil; message = ""
        defer { busy = false; organizing = false }
        do {
            let requestFields = fields.filter { organizerFieldIDs.contains($0.key) }
            let body = try JSONSerialization.data(withJSONObject: ["source": source, "type": type, "master": isMaster, "fields": requestFields])
            let result: ReportOrganization = try await model.request("/api/reports/organize", method: "POST", body: body)
            guard startingRevision == revision, key == organizerKey() else {
                message = "The report changed. Organize it again to review current suggestions."
                return
            }
            organization = result; organizationKey = key
            message = result.fields.isEmpty ? "No supported field suggestions were found. Review the notes and warnings." : "Suggestions are ready for your review."
        } catch {
            guard startingRevision == revision, key == organizerKey() else { return }
            let detail = error.localizedDescription.contains("404") || error is DecodingError
                ? "Report organization is currently unavailable."
                : error.localizedDescription
            self.error = "The report could not be organized. \(detail) Your notes and report fields remain in this draft."
        }
    }
    func applyOrganization() {
        guard let result = organization, organizationKey == organizerKey() else {
            organization = nil
            message = "The report changed. Organize it again before applying suggestions."
            return
        }
        let allowed = organizerFieldIDs
        for (field, value) in result.fields where allowed.contains(field) { fields[field] = value }
        changed()
        message = "Suggestions applied. Review the fields and build a new preview before signing."
    }
    func loadIfNeeded() async {
        guard schema.isEmpty else { return }
        busy = true; defer { busy = false }
        do {
            let (data, response) = try await portalRequest(queryItems: [URLQueryItem(name: "schema", value: "1")])
            guard response.statusCode == 200,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["types"] != nil else { throw ClientError.invalidResponse }
            schema = object; error = nil
            if types[type] == nil, let available = ["officer", "committee", "event", "formal"].first(where: { types[$0] != nil }) {
                type = available; changed()
            }
        } catch {
            let detail = error.localizedDescription
            self.error = detail.contains("404")
                ? "The Report Generator update is still being applied. Try again shortly."
                : "Report fields could not load. \(detail)"
        }
    }
    func validate(signing: Bool) throws {
        guard let user = appModel?.user else { throw ClientError.server("Your Dashboard sign-in could not be confirmed. Sign in again before preparing this report.") }
        for field in reportFields where field.required {
            if (fields[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (fields[field.id + "Other"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw ClientError.server("\(field.label) is required.")
            }
        }
        if signing && !previewCurrent { throw ClientError.server("Update and review the preview before signing this report.") }
        if signing && !user.hasSignature { throw ClientError.server("Save your signature in Signature Profile before sending this report.") }
        if signing && !reviewed {
            throw ClientError.server("Review the report and check the confirmation before sending.")
        }
    }
    func prepare(send: Bool) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            try validate(signing: send)
            let key = contentKey()
            let body = try JSONSerialization.data(withJSONObject: payload())
            let (data, response) = try await portalRequest(
                method: "POST",
                queryItems: [URLQueryItem(name: send ? "copy" : "preview", value: "1")],
                body: body
            )
            guard (200..<300).contains(response.statusCode) else {
                let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let problems = raw?["problems"] as? [[String: String]]
                throw ClientError.server(problems?.first?["message"] ?? raw?["error"] as? String ?? "The report could not be prepared. Try again.")
            }
            if send {
                guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let encoded = raw["pdf"] as? String, let bytes = Data(base64Encoded: encoded), PDFDocument(data: bytes) != nil else { throw ClientError.invalidResponse }
                pdf = bytes
                message = raw["mailed"] as? Bool == true ? "Signed report emailed to \(recipient)."
                    : raw["delivery"] as? String == "pending" ? "Signed report prepared. Email delivery is still being checked. Use Send final report again to check the same delivery."
                    : "Signed report prepared, but email delivery failed. Use Send final report again to retry."
                messageIsWarning = raw["mailed"] as? Bool != true
            } else {
                guard PDFDocument(data: data) != nil else { throw ClientError.invalidResponse }
                pdf = data; message = "Preview ready. No email has been sent."
            }
            previewKey = key; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func startOver() {
        source = ""; fields = [:]; reviewed = false; signatureName = ""; pdf = nil; message = ""; error = nil
        clientId = UUID().uuidString; changed()
    }

    private func portalAssertion() async throws -> String {
        guard let appModel, let user = appModel.user else { throw ClientError.unauthorized("Your Dashboard sign-in could not be confirmed.") }
        if !assertion.isEmpty, assertionUserID == user.id, assertionExpiresAt.timeIntervalSinceNow > 15 { return assertion }
        let handoff: ReportHandoffResponse = try await appModel.request("/api/reports/handoff", method: "POST", body: Data("{}".utf8))
        guard let url = URL(string: handoff.url), url.scheme?.lowercased() == "https",
              url.host?.lowercased() == Self.reportAPIURL.host?.lowercased(),
              url.path == Self.reportURL.path,
              (url.port == nil || url.port == 443), url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              !handoff.assertion.isEmpty else { throw ClientError.invalidResponse }
        let expiry = Date(timeIntervalSince1970: TimeInterval(handoff.expiresAt))
        guard expiry.timeIntervalSinceNow > 0, expiry.timeIntervalSinceNow <= 305 else { throw ClientError.invalidResponse }
        assertion = handoff.assertion
        assertionExpiresAt = expiry
        assertionUserID = user.id
        return assertion
    }

    private func portalRequest(method: String = "GET", queryItems: [URLQueryItem], body: Data? = nil, retryingAuthentication: Bool = false) async throws -> (Data, HTTPURLResponse) {
        var components = URLComponents(url: Self.reportAPIURL, resolvingAgainstBaseURL: false)!
        components.queryItems = queryItems
        guard let url = components.url else { throw ClientError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 90
        request.setValue("Bearer \(try await portalAssertion())", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        if response.statusCode == 401, !retryingAuthentication {
            assertion = ""; assertionExpiresAt = .distantPast; assertionUserID = nil
            return try await portalRequest(method: method, queryItems: queryItems, body: body, retryingAuthentication: true)
        }
        return (data, response)
    }
}

struct ReportGeneratorView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var browser: ReportBrowserModel
    @State private var confirmSend = false
    @State private var confirmReset = false
    private func fieldBinding(_ id: String) -> Binding<String> {
        Binding(get: { browser.fields[id] ?? "" }, set: { browser.fields[id] = $0; browser.changed() })
    }
    @State private var step = 0
    private var reportTitle: String { browser.types[browser.type]?["name"] as? String ?? "Lodge report" }
    private var requiredFields: [NativeReportField] { browser.reportFields.filter { $0.required } }
    private var completedFields: Int { requiredFields.filter { !(browser.fields[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Image(systemName: "doc.text.fill").font(.title2).foregroundStyle(SignTheme.gold)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Report Generator").font(.title2.weight(.semibold))
                    Text("Prepare, review and send a Lodge report").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if browser.busy { ProgressView().controlSize(.small) }
                Button { confirmReset = true } label: { Label("New report", systemImage: "square.and.pencil") }
                    .disabled(browser.busy)
            }.padding(22)
            Divider()
            if browser.schema.isEmpty {
                VStack(spacing: 16) {
                    ContentUnavailableView("Report workspace", systemImage: "doc.text", description: Text(browser.error ?? "Loading report fields…"))
                    Button("Try again") { Task { await browser.loadIfNeeded() } }.disabled(browser.busy)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                GeometryReader { available in
                HSplitView {
                    VStack(spacing: 0) {
                        Picker("Report stage", selection: $step) {
                            Text("1. Details").tag(0)
                            Text("2. Content").tag(1)
                            Text("3. Review").tag(2)
                        }.pickerStyle(.segmented).padding(18)
                        Divider()
                        Form {
                            if step == 0 {
                                Section {
                                    identity
                                } header: { Text("Preparing officer") }
                                Section {
                                    Picker("Report type", selection: $browser.type) {
                                        ForEach(["officer", "committee", "event", "formal"].filter { browser.types[$0] != nil }, id: \.self) { key in
                                            Text(browser.types[key]?["name"] as? String ?? key.capitalized).tag(key)
                                        }
                                    }
                                    Text("Your selected report determines the sections in the document.").font(.caption).foregroundStyle(.secondary)
                                } header: { Text("Document") }
                            } else if step == 1 {
                                organizer
                                Section {
                                    ForEach(browser.reportFields) { field in reportField(field) }
                                } header: { Text(reportTitle) }
                            } else {
                                Section {
                                    LabeledContent("Report", value: reportTitle)
                                    LabeledContent("Prepared by", value: browser.name)
                                    LabeledContent("Delivery", value: browser.recipient)
                                } header: { Text("Final review") }
                                Section {
                                    Label(browser.previewCurrent ? "Preview matches this report" : "Update the preview before signing", systemImage: browser.previewCurrent ? "checkmark.circle.fill" : "doc.badge.clock")
                                        .foregroundStyle(browser.previewCurrent ? Color.green : Color.secondary)
                                    Toggle(browser.reviewStatement, isOn: $browser.reviewed).toggleStyle(.checkbox).disabled(!browser.previewCurrent)
                                    LabeledContent("Signed as", value: browser.name)
                                    Text("Your saved Dashboard identity and signature are applied only when you confirm Send final report.").font(.caption).foregroundStyle(.secondary)
                                } header: { Text("Your signature") }
                                Section {
                                    Button { confirmSend = true } label: { Label("Send final report", systemImage: "paperplane") }
                                        .buttonStyle(.borderedProminent)
                                        .disabled(!browser.previewCurrent || !browser.reviewed)
                                    Text("Emails the signed report to \(browser.recipient).").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }.formStyle(.grouped).textFieldStyle(.roundedBorder)
                        Divider()
                        HStack {
                            if step > 0 { Button("Back") { step -= 1 } }
                            Spacer()
                            if step < 2 { Button(step == 0 ? "Write report" : "Review report") { step += 1 }.buttonStyle(.borderedProminent) }
                        }.padding(16)
                    }.frame(minWidth: 340, maxWidth: .infinity)
                    previewPane.frame(minWidth: 320, maxWidth: .infinity)
                }
                // Use the window's proposed space. The two panes' intrinsic
                // widths must not make the surrounding navigation view wider
                // than the window when it is resized.
                .frame(width: available.size.width, height: available.size.height)
                }.disabled(browser.busy)
                Divider()
                HStack(spacing: 8) {
                    Image(systemName: "externaldrive").foregroundStyle(.secondary)
                    Text(browser.draftSaved ? "Draft saved on this Mac" : "Draft not saved yet").font(.caption)
                    Spacer()
                    Text("\(completedFields) of \(requiredFields.count) required sections completed").font(.caption).foregroundStyle(.secondary)
                }.padding(.horizontal, 20).padding(.vertical, 10)
            }
            if let error = browser.error, !browser.schema.isEmpty {
                Label(error, systemImage: "exclamationmark.circle.fill").foregroundStyle(.red).font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }
            if !browser.message.isEmpty {
                Group {
                    if browser.messageIsWarning { Label(browser.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    else { Text(browser.message) }
                }.font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.background(Color(nsColor: .windowBackgroundColor))
        .task { browser.configure(model); await browser.loadIfNeeded() }
        .onChange(of: browser.phone) { _, _ in browser.changed() }
        .onChange(of: browser.type) { _, _ in browser.changed() }
        .alert("Send this signed report?", isPresented: $confirmSend) {
            Button("Send final report") { Task { await browser.prepare(send: true) } }; Button("Cancel", role: .cancel) {}
        } message: { Text("The current report will be signed with your Dashboard identity and emailed to \(browser.recipient).") }
        .alert("Start a new report?", isPresented: $confirmReset) {
            Button("Clear report", role: .destructive) { browser.startOver(); step = 0 }; Button("Cancel", role: .cancel) {}
        } message: { Text("The saved report fields will be cleared. Your contact details remain available.") }
    }

    private var organizer: some View {
        Section {
            Text("Paste notes or source text, then review the suggested report fields before applying them.").font(.callout).foregroundStyle(.secondary)
            TextEditor(text: Binding(get: { browser.source }, set: { browser.source = $0; browser.changed() }))
                .font(.body).scrollContentBackground(.hidden).frame(minHeight: 150).padding(8)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.2)))
                .accessibilityLabel("Report source notes")
            Button(browser.organizing ? "Organizing…" : "Organize report") { Task { await browser.organize(using: model) } }
                .disabled(browser.busy || browser.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Text(model.user?.role == "owner" ? "Uses the Lodge's approved generation allowance. Your notes are retained on this Mac." : "Your notes are retained on this Mac. Review each suggestion before applying it.").font(.caption).foregroundStyle(.secondary)
            if let result = browser.organization {
                ForEach(Array(result.warnings.enumerated()), id: \.offset) { _, warning in
                    Label(warning, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
                }
                ForEach(result.fields.keys.sorted(), id: \.self) { field in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(browser.reportFields.first { $0.id == field || $0.id + "Other" == field }?.label ?? field).font(.headline)
                        if let existing = browser.fields[field], !existing.isEmpty {
                            Text("Current: \(existing)").font(.callout).foregroundStyle(.secondary)
                        }
                        Text(result.fields[field] ?? "").textSelection(.enabled)
                        ForEach(Array(result.evidence.filter { $0.field == field }.enumerated()), id: \.offset) { _, evidence in
                            Text("Source: \(evidence.quote)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                }
                HStack {
                    Button("Apply suggestions") { browser.applyOrganization() }.disabled(result.fields.isEmpty)
                    Button("Dismiss") { browser.organization = nil; browser.message = "" }
                }
            }
        } header: { Text("Organize your notes") }
    }

    private var previewPane: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Document preview").font(.headline)
                    Text(browser.pdf == nil ? "Your formatted report" : browser.previewCurrent ? "Current version" : "Changes need a new preview")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { if let pdf = browser.pdf { saveDocument(pdf, name: "Lodge Report.pdf", type: .pdf) } } label: { Image(systemName: "square.and.arrow.down") }
                    .help("Save PDF").accessibilityLabel("Save PDF").disabled(!browser.previewCurrent)
            }.padding(18)
            Divider()
            if browser.pdf == nil {
                ContentUnavailableView("See your report here", systemImage: "doc.richtext", description: Text("Complete the details and content, then build the preview. Review the document before signing."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                LodgeDocumentPreview(data: browser.pdf).padding(12)
            }
            Divider()
            HStack {
                if let data = browser.pdf, let document = PDFDocument(data: data) { Text("\(document.pageCount) \(document.pageCount == 1 ? "page" : "pages")").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button(browser.pdf == nil ? "Build preview" : "Update preview") { Task { await browser.prepare(send: false) } }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
            }.padding(16)
        }.background(SignTheme.navy.opacity(0.035))
    }

    @ViewBuilder private var identity: some View {
        LabeledContent("Signed in as", value: browser.name)
        LabeledContent("Office", value: browser.office)
        LabeledContent("Email", value: browser.email)
        TextField("Phone (optional)", text: $browser.phone)
        Text("Your identity comes from your Dashboard account and cannot be changed inside the report.").font(.caption).foregroundStyle(.secondary)
    }
    @ViewBuilder private func reportField(_ field: NativeReportField) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(field.label + (field.required ? " *" : "")).font(.subheadline.weight(.medium))
            if field.kind == "pick" {
                Picker(field.label, selection: Binding(get: { let value = browser.fields[field.id] ?? ""; return field.picks.contains(value) || value.isEmpty ? value : "Other" }, set: { browser.fields[field.id] = $0 == "Other" ? "Other" : $0; browser.changed() })) {
                    Text("Choose…").tag(""); ForEach(field.picks, id: \.self) { Text($0).tag($0) }; Text("Other").tag("Other")
                }.labelsHidden()
                if !(browser.fields[field.id] ?? "").isEmpty && !field.picks.contains(browser.fields[field.id] ?? "") { TextField("Type the committee name", text: fieldBinding(field.id)) }
            } else if field.kind == "choices" {
                ForEach(field.choices, id: \.self) { option in
                    if option.count >= 2 {
                        Toggle(option[1], isOn: Binding(get: { (browser.fields[field.id] ?? "").split(separator: ",").map(String.init).contains(option[0]) }, set: { on in
                            var selected = Set((browser.fields[field.id] ?? "").split(separator: ",").map(String.init)); if on { selected.insert(option[0]) } else { selected.remove(option[0]) }; browser.fields[field.id] = selected.sorted().joined(separator: ","); browser.changed()
                        })).toggleStyle(.checkbox)
                    }
                }
                TextField("Something else", text: fieldBinding(field.id + "Other"))
            } else if ["long", "list", "budget"].contains(field.kind) {
                TextEditor(text: fieldBinding(field.id)).font(.body).scrollContentBackground(.hidden).frame(minHeight: 140).padding(8).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7)).overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.2))).accessibilityLabel(field.label)
            } else {
                TextField(field.kind == "date" ? "YYYY-MM-DD" : field.kind == "time" ? "HH:MM" : field.kind == "money" ? "$0.00" : field.label, text: fieldBinding(field.id))
            }
            if !field.hint.isEmpty { Text(field.hint).font(.caption).foregroundStyle(.secondary) }
        }
    }
}
