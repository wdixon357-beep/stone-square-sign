import Foundation
import PDFKit

final class ReportFixture: URLProtocol {
    static var pdf = Data()
    static var deliveries = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let sending = request.url!.query?.contains("copy=1") == true
        if sending { Self.deliveries += 1 }
        let data = sending ? try! JSONSerialization.data(withJSONObject: ["pdf": Self.pdf.base64EncodedString(), "mailed": true]) : Self.pdf
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": sending ? "application/json" : "application/pdf"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class MinutesConflictFixture: URLProtocol {
    static var saveBody: Data?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.httpMethod == "PUT" {
            if let body = request.httpBody { Self.saveBody = body }
            else if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }; data.append(buffer, count: count)
                }
                Self.saveBody = data
            }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"error":"The record changed. Refresh before saving."}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class GenerationFixture: URLProtocol {
    static var response = Data()
    static var requests: [(method: String, path: String, body: Data)] = []
    static var beforeReply: (@MainActor (URLRequest) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }; data.append(buffer, count: count)
            }
        }
        let body = data
        Task { @MainActor in
            Self.requests.append((request.httpMethod ?? "GET", request.url!.path, body))
            Self.beforeReply?(request)
            let payload = request.url!.path == "/api/generation/status"
                ? Data(#"{"configured":true,"model":"gpt-5.6-terra","monthlyLimitDollars":5,"remainingDollars":4.75}"#.utf8)
                : Self.response
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: payload)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

@main struct NativeReportTests {
    @MainActor static func main() async throws {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReportFixture.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        ReportFixture.pdf = try Data(contentsOf: URL(fileURLWithPath: "test/sample-dispensation.pdf"))
        let model = ReportBrowserModel(persistenceURL: scratch.appendingPathComponent("draft.json"), session: session)
        model.schema = ["officers": [["name": "QA Officer", "office": "Secretary"]], "types": ["officer": ["name": "Officer Report", "fields": [["id": "summary", "label": "Summary", "req": true]]]]]
        model.name = "QA Officer"; model.email = "qa@example.org"
        await model.prepare(send: false)
        precondition(model.pdf == nil && model.error?.contains("Summary is required") == true)
        print("PASS: missing required content prevents preview")
        model.fields = ["summary": "Fictional report test. No real Lodge records."]
        model.changed()
        precondition(model.draftSaved && FileManager.default.fileExists(atPath: model.persistenceURL!.path))
        let restored = ReportBrowserModel(persistenceURL: model.persistenceURL, session: session)
        precondition(restored.fields == model.fields && restored.draftSaved && !restored.reviewed && restored.signatureName.isEmpty)
        print("PASS: draft survives reopening without carrying a signature or approval")
        model.reviewed = true; model.signatureName = "QA Officer"
        await model.prepare(send: true)
        precondition(ReportFixture.deliveries == 0 && model.error?.contains("preview") == true)
        print("PASS: report cannot be sent before previewing")
        await model.prepare(send: false)
        precondition(model.previewCurrent && model.pdf.flatMap { PDFDocument(data: $0) } != nil)
        print("PASS: native PDF preview loads and matches current content")
        model.fields["summary"] = "Changed fictional content."; model.changed()
        precondition(!model.previewCurrent && !model.reviewed)
        model.reviewed = true
        await model.prepare(send: true)
        precondition(ReportFixture.deliveries == 0)
        print("PASS: content changes invalidate preview and block stale approval")
        await model.prepare(send: false); model.reviewed = true; model.signatureName = "QA Officer"
        await model.prepare(send: true)
        precondition(ReportFixture.deliveries == 1 && model.message.contains("Signed report emailed"))
        print("PASS: reviewed current report reaches only the isolated delivery fixture")
        model.startOver()
        precondition(model.fields.isEmpty && model.pdf == nil && !model.reviewed && model.signatureName.isEmpty && model.name == "QA Officer")
        print("PASS: new report clears content and signature while retaining contact details")

        let minutesRecord = try JSONDecoder().decode(MinutesRecord.self, from: Data(#"{"id":"synthetic-minutes","status":"draft","createdBy":"QA Officer","updatedAt":"2026-09-12T18:00:00.000Z","draft":{"meetingType":"Stated Communication","present":[],"excused":[],"visitors":[],"officerAttendance":[],"income":[],"expenses":[],"sections":[{"heading":"Opening","body":"Synthetic saved content."}],"warnings":[],"sensitiveReview":[],"actionItems":[]}}"#.utf8))
        let minutesConfig = URLSessionConfiguration.ephemeral
        minutesConfig.protocolClasses = [MinutesConflictFixture.self]
        let minutesSession = URLSession(configuration: minutesConfig)
        defer { minutesSession.invalidateAndCancel() }
        let minutes = MinutesWorkspace(session: minutesSession)
        minutes.baseURL = URL(string: "https://minutes-fixture.invalid")
        minutes.token = "synthetic-token"
        minutes.selected = minutesRecord
        var changedDraft = minutesRecord.draft
        changedDraft.sections[0].body = "Synthetic unsaved correction."
        minutes.draft = changedDraft; minutes.dirty = true
        await minutes.save()
        let sent = try JSONSerialization.jsonObject(with: MinutesConflictFixture.saveBody!) as! [String: Any]
        precondition(sent["expectedUpdatedAt"] as? String == minutesRecord.updatedAt && sent["draft"] is [String: Any])
        print("PASS: minutes save includes the version opened by the officer")
        precondition(minutes.draft == changedDraft && minutes.dirty && minutes.selected?.draft == minutesRecord.draft)
        precondition(minutes.message == "The record changed. Refresh before saving." && !minutes.busy)
        print("PASS: conflicting minutes save retains unsaved input and displays the server error")

        let generationConfig = URLSessionConfiguration.ephemeral
        generationConfig.protocolClasses = [GenerationFixture.self]
        let generationSession = URLSession(configuration: generationConfig)
        defer { generationSession.invalidateAndCancel() }
        let reportApp = AppModel(session: generationSession, savedSessionToken: "synthetic-token")
        let savedServer = reportApp.serverAddress
        reportApp.serverAddress = "https://generation-fixture.invalid"
        defer { reportApp.serverAddress = savedServer }
        let report = ReportBrowserModel(persistenceURL: scratch.appendingPathComponent("organizer.json"))
        report.schema = model.schema
        report.source = "The committee met on Tuesday."
        report.changed()
        let sourceRestored = ReportBrowserModel(persistenceURL: report.persistenceURL)
        precondition(sourceRestored.source == report.source)
        GenerationFixture.response = Data(#"{"fields":{"summary":"The committee met on Tuesday."},"warnings":["Confirm the meeting date."],"evidence":[{"field":"summary","quote":"The committee met on Tuesday."}]}"#.utf8)
        GenerationFixture.beforeReply = { request in
            precondition(request.url?.host == "generation-fixture.invalid")
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token")
        }
        await report.organize(using: reportApp)
        GenerationFixture.beforeReply = nil
        precondition(report.fields.isEmpty && report.organization?.fields["summary"] != nil)
        let reportRequest = GenerationFixture.requests.last!
        let reportBody = try JSONSerialization.jsonObject(with: reportRequest.body) as! [String: Any]
        precondition(reportRequest.path == "/api/reports/organize" && reportBody["fields"] as? [String: String] == [:])
        precondition(report.organization?.warnings.count == 1 && report.organization?.evidence.count == 1)
        report.fields["retained"] = "Keep this field."
        report.applyOrganization()
        precondition(report.fields["summary"] == nil)
        await report.organize(using: reportApp)
        report.reviewed = true; report.signatureName = "QA Officer"; report.pdf = ReportFixture.pdf
        report.applyOrganization()
        precondition(report.fields["summary"] == report.source && report.fields["retained"] == "Keep this field.")
        precondition(!report.reviewed && report.signatureName.isEmpty && report.pdf == nil)
        print("PASS: report source persists; incomplete reports organize without changing fields until explicit Apply, which resets review and retains other fields")
        GenerationFixture.beforeReply = { _ in report.source = "Changed while organizing."; report.changed() }
        let previousFields = report.fields
        await report.organize(using: reportApp)
        precondition(report.organization == nil && report.fields == previousFields && !report.busy)
        GenerationFixture.beforeReply = nil
        report.startOver()
        precondition(report.source.isEmpty && report.organization == nil)
        print("PASS: changed report snapshots reject stale suggestions, and new reports clear the source")

        report.schema = ["types": [
            "officer": ["fields": [["id": "activities", "kind": "long"]]],
            "committee": ["fields": [["id": "summary", "kind": "long"], ["id": "decisions", "kind": "choices"]]]]]
        report.type = "officer"
        report.fields = ["activities": "Keep the officer activity."]
        report.type = "committee"
        report.fields["summary"] = "Existing committee summary."
        report.fields["summaryOther"] = "Keep unrelated local value."
        report.fields["decisionsOther"] = "Supported other choice."
        report.source = "The committee met on Tuesday."
        report.changed()
        GenerationFixture.response = Data(#"{"fields":{"summary":"The committee met on Tuesday.","summaryOther":"Must not apply.","decisionsOther":"Updated choice."},"warnings":[],"evidence":[]}"#.utf8)
        await report.organize(using: reportApp)
        let switchedRequest = GenerationFixture.requests.last!
        let switchedBody = try JSONSerialization.jsonObject(with: switchedRequest.body) as! [String: Any]
        let switchedFields = switchedBody["fields"] as! [String: String]
        precondition(switchedBody["type"] as? String == "committee")
        precondition(switchedFields == ["summary": "Existing committee summary.", "decisionsOther": "Supported other choice."])
        report.applyOrganization()
        precondition(report.fields["activities"] == "Keep the officer activity.")
        precondition(report.fields["summaryOther"] == "Keep unrelated local value.")
        precondition(report.fields["summary"] == report.source && report.fields["decisionsOther"] == "Updated choice.")
        print("PASS: changing report type sends only current fields and choice Other values while preserving unrelated local fields")

        let organizing = MinutesWorkspace(session: generationSession)
        organizing.baseURL = URL(string: "https://generation-fixture.invalid"); organizing.token = "synthetic-token"
        let status = await GenerationStatus.load(using: organizing)
        precondition(status?.explanation.hasPrefix("Terra enabled.") == true && status?.allowance(forOwner: true)?.contains("$4.75 remaining of $5.00") == true)
        precondition(status?.allowance(forOwner: false) == nil)
        print("PASS: native generation status discloses enabled processing and shows allowance only to the owner")
        let localStatus = try JSONDecoder().decode(GenerationStatus.self, from: Data(#"{"configured":false,"monthlyLimitDollars":5}"#.utf8))
        precondition(localStatus.explanation == "Local organizer active. Terra setup is pending." && localStatus.allowance(forOwner: true) == nil)
        let unavailableStatus = await GenerationStatus.load(using: minutes)
        precondition(unavailableStatus == nil)
        print("PASS: unconfigured and unavailable generation states remain distinct without inventing an allowance")

        organizing.selected = minutesRecord; organizing.draft = changedDraft
        GenerationFixture.response = try JSONEncoder().encode(["draft": minutesRecord.draft])
        await organizing.reorganize()
        let minutesRequest = GenerationFixture.requests.last { $0.path.hasSuffix("/reorganize") }!
        let minutesRequestBody = try JSONSerialization.jsonObject(with: minutesRequest.body) as! [String: String]
        precondition(minutesRequest.method == "POST" && minutesRequestBody["expectedUpdatedAt"] == minutesRecord.updatedAt)
        precondition(organizing.draft == minutesRecord.draft && organizing.dirty && organizing.selected?.updatedAt == minutesRecord.updatedAt)
        print("PASS: minutes reorganization sends the opened version and leaves the replacement unsaved")
        organizing.close(); organizing.selected = minutesRecord; organizing.draft = changedDraft; organizing.dirty = true
        GenerationFixture.beforeReply = { request in
            if request.url!.path.hasSuffix("/reorganize") { organizing.selected?.updatedAt = "2026-09-12T19:00:00.000Z" }
        }
        await organizing.reorganize()
        precondition(organizing.draft == changedDraft && organizing.dirty)
        print("PASS: late minutes generation cannot overwrite an editor whose record version changed")
        organizing.close(); GenerationFixture.beforeReply = nil

        let treasuryDraft = TreasuryDraft(version: 1, periodStart: "", periodEnd: "", presentedOn: "", bankName: "", accounts: [], transactions: [], funds: [], obligations: [], fundsReviewed: false, obligationsReviewed: false, sourceReviewed: false, remarks: "Synthetic saved report.", unmappedLines: [], sourceNames: [], extractionNotes: [])
        let treasuryRecord = TreasuryRecord(id: "synthetic-treasury", status: "draft", revision: 3, createdByUserId: 9, preparerUserId: 9, uploadedBy: "QA Uploader", createdBy: "QA Preparer", preparerRole: "treasury_preparer", draft: treasuryDraft)
        let treasury = TreasuryWorkspace(session: generationSession)
        treasury.transport.baseURL = URL(string: "https://generation-fixture.invalid"); treasury.transport.token = "synthetic-token"
        treasury.selected = treasuryRecord; treasury.draft = treasuryDraft
        var replacement = treasuryDraft; replacement.remarks = "Synthetic organized report."
        GenerationFixture.response = try JSONEncoder().encode(["draft": replacement])
        await treasury.reorganize()
        let treasuryRequest = GenerationFixture.requests.last { $0.path.hasSuffix("/organize") }!
        let treasuryRequestBody = try JSONSerialization.jsonObject(with: treasuryRequest.body) as! [String: Int]
        precondition(treasuryRequest.method == "POST" && treasuryRequestBody["revision"] == 3)
        precondition(treasury.draft == replacement && treasury.dirty && treasury.selected?.draft == treasuryDraft && treasury.selected?.revision == 3)
        print("PASS: treasury reorganization sends the revision and preserves the saved report until a separate save")
        treasury.close(); treasury.selected = treasuryRecord; treasury.draft = treasuryDraft
        GenerationFixture.beforeReply = { request in
            if request.url!.path.hasSuffix("/organize") { treasury.selected?.revision = 4 }
        }
        await treasury.reorganize()
        precondition(treasury.draft == treasuryDraft && treasury.selected?.revision == 4)
        print("PASS: late treasury generation cannot replace a newer report revision")
        treasury.close(); GenerationFixture.beforeReply = nil
        precondition(GenerationFixture.requests.allSatisfy { $0.path == "/api/generation/status" || $0.path.hasSuffix("/reorganize") || $0.path.hasSuffix("/organize") })
        print("PASS: reorganization fixtures make no save, sign, delivery or new-report requests")
    }
}
