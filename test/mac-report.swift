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
        await model.prepare(send: false); model.reviewed = true
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
    }
}
