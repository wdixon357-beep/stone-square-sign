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
    }
}
