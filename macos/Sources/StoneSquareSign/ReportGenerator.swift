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

// Native controls consume the same published schema and report endpoint as the web.
// The Sign session and stored Lodge signatures are never passed to this service.
@MainActor
final class ReportBrowserModel: ObservableObject {
    static let reportURL = URL(string: "https://request.stonesquare22pha.org/report")!
    @Published var schema: [String: Any] = [:]
    @Published var isOfficer = true
    @Published var name = ""
    @Published var email = ""
    @Published var phone = ""
    @Published var type = "officer"
    @Published var fields: [String: String] = [:]
    @Published var reviewed = false
    @Published var signatureName = ""
    @Published var pdf: Data?
    @Published var busy = false
    @Published var error: String?
    @Published var message = ""
    var clientId = UUID().uuidString
    private var previewKey: Data?
    var officers: [[String: String]] { schema["officers"] as? [[String: String]] ?? [] }
    var office: String { isOfficer ? officers.first { $0["name"] == name }?["office"] ?? "" : "" }
    var isMaster: Bool { office == "Worshipful Master" }
    var recipient: String { isMaster ? "your Lodge inbox" : "the Worshipful Master" }
    var types: [String: [String: Any]] { schema[isMaster ? "masterTypes" : "types"] as? [String: [String: Any]] ?? [:] }
    var reportFields: [NativeReportField] { (types[type]?["fields"] as? [[String: Any]] ?? []).map(NativeReportField.init) }
    var reviewStatement: String { schema["reviewStatement"] as? String ?? "I have reviewed this report and confirm its accuracy." }
    var previewCurrent: Bool { previewKey == contentKey() && pdf != nil }
    var persistenceURL: URL? { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("Stone Square Sign/report-draft.json") }

    init() {
        guard let url = persistenceURL, let data = try? Data(contentsOf: url),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let timestamp = raw["savedAt"] as? Double, Date().timeIntervalSince1970 - timestamp < 7 * 86400 else { return }
        isOfficer = raw["isOfficer"] as? Bool ?? true; name = raw["name"] as? String ?? ""
        email = raw["email"] as? String ?? ""; phone = raw["phone"] as? String ?? ""
        type = raw["type"] as? String ?? "officer"; fields = raw["fields"] as? [String: String] ?? [:]
        clientId = raw["clientId"] as? String ?? UUID().uuidString
    }
    func payload() -> [String: Any] {
        ["isOfficer": isOfficer, "office": office, "name": name, "email": email, "phone": phone,
         "type": type, "fields": fields, "reviewed": reviewed, "signatureName": signatureName, "clientId": clientId]
    }
    func contentKey() -> Data? {
        var object = payload(); object.removeValue(forKey: "reviewed"); object.removeValue(forKey: "signatureName")
        return try? JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
    }
    func changed() {
        reviewed = false; previewKey = nil
        var object = payload(); object["reviewed"] = false; object["signatureName"] = ""; object["savedAt"] = Date().timeIntervalSince1970
        if let url = persistenceURL, let data = try? JSONSerialization.data(withJSONObject: object) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try? data.write(to: url, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }
    func loadIfNeeded() async {
        guard schema.isEmpty else { return }
        busy = true; defer { busy = false }
        do {
            let (data, response) = try await URLSession.shared.data(from: Self.reportURL.deletingLastPathComponent().appendingPathComponent("api/report").appending(queryItems: [URLQueryItem(name: "schema", value: "1")]))
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["types"] != nil else { throw ClientError.invalidResponse }
            schema = object; error = nil
        } catch { self.error = "Report fields could not load. \(error.localizedDescription)" }
    }
    func validate(signing: Bool) throws {
        if isOfficer && office.isEmpty { throw ClientError.server("Choose your name from the officer list.") }
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ClientError.server("Enter your name.") }
        if !email.contains("@") || !email.contains(".") { throw ClientError.server("Enter a working email address.") }
        for field in reportFields where field.required {
            if (fields[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (fields[field.id + "Other"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw ClientError.server("\(field.label) is required.")
            }
        }
        if signing && (!reviewed || signatureName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
            throw ClientError.server("Review the report, check the confirmation, and type your name before sending.")
        }
    }
    func prepare(send: Bool) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            try validate(signing: send)
            let key = contentKey()
            var request = URLRequest(url: URL(string: "https://request.stonesquare22pha.org/api/report?\(send ? "copy" : "preview")=1")!)
            request.httpMethod = "POST"; request.timeoutInterval = 90
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: payload())
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
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
            } else {
                guard PDFDocument(data: data) != nil else { throw ClientError.invalidResponse }
                pdf = data; message = "Preview ready. No email has been sent."
            }
            previewKey = key; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func startOver() {
        fields = [:]; reviewed = false; signatureName = ""; pdf = nil; message = ""; error = nil
        clientId = UUID().uuidString; changed()
    }
}

struct ReportGeneratorView: View {
    @ObservedObject var browser: ReportBrowserModel
    @State private var confirmSend = false
    @State private var confirmReset = false
    private func fieldBinding(_ id: String) -> Binding<String> {
        Binding(get: { browser.fields[id] ?? "" }, set: { browser.fields[id] = $0; browser.changed() })
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) { Text("Report Generator").font(.title2.weight(.semibold)); Text("Prepare a Lodge report for review").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Start over") { confirmReset = true }
                Button("Preview report") { Task { await browser.prepare(send: false) } }.buttonStyle(.borderedProminent)
            }.padding(20)
            Divider()
            if browser.schema.isEmpty {
                ContentUnavailableView("Report form", systemImage: "doc.text", description: Text(browser.error ?? "Loading report fields…"))
                Button("Try again") { Task { await browser.loadIfNeeded() } }
            } else {
                HSplitView {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            identity
                            GroupBox("Report details") {
                                VStack(alignment: .leading, spacing: 14) {
                                    Picker("Report type", selection: $browser.type) {
                                        ForEach(["officer", "committee", "event", "formal"].filter { browser.isOfficer || $0 != "officer" }, id: \.self) { key in
                                            Text(browser.types[key]?["name"] as? String ?? key.capitalized).tag(key)
                                        }
                                    }
                                    ForEach(browser.reportFields) { field in reportField(field) }
                                }.padding(12)
                            }
                            GroupBox("Review and sign") {
                                VStack(alignment: .leading, spacing: 12) {
                                    Toggle(browser.reviewStatement, isOn: $browser.reviewed).toggleStyle(.checkbox)
                                    TextField("Type your name to sign", text: $browser.signatureName)
                                    Text("Send final report emails your signed copy to \(browser.recipient).").font(.caption).foregroundStyle(.secondary)
                                    Button("Send final report") { confirmSend = true }.buttonStyle(.borderedProminent).disabled(!browser.reviewed || browser.signatureName.isEmpty)
                                }.padding(12)
                            }
                        }.padding(20).textFieldStyle(.roundedBorder)
                    }.frame(minWidth: 340, idealWidth: 460)
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Text("Document preview").font(.headline); Spacer(); Button("Save PDF") { if let pdf = browser.pdf { saveDocument(pdf, name: "Lodge Report.pdf", type: .pdf) } }.disabled(browser.pdf == nil || !browser.previewCurrent) }
                        if browser.pdf != nil && !browser.previewCurrent { Text("The report has changed. Update the preview before saving.").font(.caption).foregroundStyle(.orange) }
                        if browser.pdf == nil { ContentUnavailableView("Report preview", systemImage: "doc.richtext", description: Text("Complete the report fields, then select Preview report.")) }
                        else { LodgeDocumentPreview(data: browser.pdf) }
                    }.padding(14).frame(minWidth: 280, idealWidth: 480)
                }
            }
            if let error = browser.error { Text(error).foregroundStyle(.red).font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading) }
            if !browser.message.isEmpty { Text(browser.message).font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading) }
        }.background(Color(nsColor: .windowBackgroundColor)).disabled(browser.busy)
        .task { await browser.loadIfNeeded() }
        .onChange(of: browser.name) { _, _ in browser.signatureName = ""; browser.changed() }
        .onChange(of: browser.email) { _, _ in browser.changed() }
        .onChange(of: browser.phone) { _, _ in browser.changed() }
        .onChange(of: browser.isOfficer) { _, value in browser.name = ""; if !value && browser.type == "officer" { browser.type = "formal" }; browser.changed() }
        .onChange(of: browser.type) { _, _ in browser.changed() }
        .alert("Send this signed report?", isPresented: $confirmSend) {
            Button("Send final report") { Task { await browser.prepare(send: true) } }; Button("Cancel", role: .cancel) {}
        } message: { Text("The current report will be signed with the name you entered and emailed to \(browser.recipient).") }
        .alert("Start a new report?", isPresented: $confirmReset) {
            Button("Clear report", role: .destructive) { browser.startOver() }; Button("Cancel", role: .cancel) {}
        } message: { Text("The saved report fields will be cleared. Your contact details remain available.") }
    }
    private var identity: some View {
        GroupBox("Prepared by") {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("I am a Lodge officer", isOn: $browser.isOfficer).toggleStyle(.checkbox)
                if browser.isOfficer {
                    Picker("Officer", selection: $browser.name) {
                        Text("Choose your name").tag("")
                        ForEach(browser.officers, id: \.self) { officer in Text("\(officer["name"] ?? "") · \(officer["office"] ?? "")").tag(officer["name"] ?? "") }
                    }
                } else { TextField("Your name", text: $browser.name) }
                TextField("Email address", text: $browser.email)
                TextField("Phone (optional)", text: $browser.phone)
            }.padding(12)
        }
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
                TextEditor(text: fieldBinding(field.id)).font(.body).frame(minHeight: 95).padding(5).background(Color(nsColor: .textBackgroundColor))
            } else {
                TextField(field.kind == "date" ? "YYYY-MM-DD" : field.kind == "time" ? "HH:MM" : field.kind == "money" ? "$0.00" : field.label, text: fieldBinding(field.id))
            }
            if !field.hint.isEmpty { Text(field.hint).font(.caption).foregroundStyle(.secondary) }
        }
    }
}
