import Foundation

final class SubmissionFixture: URLProtocol {
    static var requests: [URLRequest] = []
    static var uploadBodies: [Data] = []
    static var resolutionBodies: [Data] = []
    static var uploadStatus = 200
    static var packetState = "awaiting_report"
    static var owner = true
    static var packet: String {
        #"{"packet":{"state":"\#(packetState)","automaticDeliveryEnabled":false,"recipient":{"name":"District Deputy Fixture","to":"deputy@example.invalid"},"report":null,"draft":null,"message":"Fixture delivery state","delivery":{"attemptedAt":"2026-10-16T19:00:00.000Z"}}}"#
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        if request.httpMethod == "PUT" || request.url?.path.hasSuffix("/submission-resolution") == true {
            var body = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    body.append(buffer, count: count)
                }
            }
            if request.httpMethod == "PUT" { Self.uploadBodies.append(body) }
            else { Self.resolutionBodies.append(body) }
        }
        var status = 200
        var contentType = "application/json"
        var body = Self.packet
        switch request.url!.path {
        case "/api/documents/fixture/supporting-report":
            if request.httpMethod == "PUT" {
                status = Self.uploadStatus
                if status != 200 { body = #"{"error":"The packet is already sending."}"# }
            } else { contentType = "application/pdf"; body = "%PDF-1.4 fixture supporting report" }
        case "/api/documents/fixture/submission-packet", "/api/documents/fixture/submission-resolution": break
        case "/api/documents/fixture/submit": body = #"{"message":"Same packet retried."}"#
        case "/api/auth/me":
            body = #"{"user":{"id":9998,"email":"owner@example.invalid","name":"Fixture Owner","role":"owner","hasSignature":true}}"#
        default: body = #"{"documents":[],"officers":[],"pending":[],"profiles":[],"alerts":[]}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":contentType])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct SubmissionTests {
    @MainActor static func main() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SubmissionFixture.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let model = AppModel(session: session, savedSessionToken: "test-only-not-a-real-token")
        model.user = User(id:9998,email:"owner@example.invalid",name:"Fixture Owner",role:"owner",hasSignature:true)
        let packet = try await model.submissionPacket(documentId:"fixture")
        precondition(packet.state == "awaiting_report" && packet.canSaveSupportingReport)
        precondition(packet.automaticDeliveryEnabled == false)
        precondition(packet.recipientEmail == "deputy@example.invalid")
        precondition(SubmissionFixture.requests.count == 1 && SubmissionFixture.requests[0].httpMethod == "GET")
        print("PASS: opening the native packet is read-only and displays the configured deputy before attachment")

        for state in ["disabled", "awaiting_signature", "awaiting_report", "ready", "sending", "sent", "failed", "uncertain", "unknown"] {
            SubmissionFixture.packetState = state
            let value = try await model.submissionPacket(documentId:"fixture")
            precondition(value.canSaveSupportingReport == ["disabled","awaiting_signature","awaiting_report","failed"].contains(state))
            if state == "sent" { precondition(value.statusTitle == "Email submission recorded") }
            else if ["sending","uncertain"].contains(state) {
                precondition(value.statusTitle == "Previous email attempt needs verification")
            } else { precondition(value.statusTitle == "Automatic email sending is off") }
        }
        let olderPacket = try JSONDecoder().decode(DispensationSubmissionPacket.self, from:Data(#"{"state":"ready"}"#.utf8))
        precondition(olderPacket.automaticDeliveryEnabled != true && olderPacket.statusTitle == "Automatic email sending is off")
        for json in [#"{"state":"awaiting_report"}"#, #"{"state":"awaiting_report","automaticDeliveryEnabled":true}"#] {
            let unsafeArchive = try JSONDecoder().decode(DispensationSubmissionPacket.self, from:Data(json.utf8))
            precondition(!unsafeArchive.canSaveSupportingReport)
        }
        let lockedPacket = try JSONDecoder().decode(DispensationSubmissionPacket.self, from:Data(#"{"state":"disabled","automaticDeliveryEnabled":false,"reportLocked":true}"#.utf8))
        precondition(!lockedPacket.canSaveSupportingReport)
        print("PASS: native states preserve historical attempts and show disabled sending even when an older service omits the delivery flag")

        let documentDecoder = JSONDecoder()
        documentDecoder.keyDecodingStrategy = .convertFromSnakeCase
        let documentJSON = #"{"id":"corrected-fixture","title":"Synthetic dispensation","original_name":"fixture.pdf","status":"completed","created_at":"2026-10-16T18:00:00.000Z","updated_at":"2026-10-16T20:00:00.000Z","signers":[],"needs_signature":false,"template_kind":"dispensation_v1","submitted_at":"2026-10-16T19:00:00.000Z","submitted_to":"deputy@example.invalid"}"#
        let legacyDocument = try documentDecoder.decode(LodgeDocument.self, from: Data(documentJSON.utf8))
        precondition(legacyDocument.signatureCorrectedAt == nil)
        precondition(legacyDocument.submittedAt == "2026-10-16T19:00:00.000Z")
        var correctedJSON = try JSONSerialization.jsonObject(with: Data(documentJSON.utf8)) as! [String: Any]
        correctedJSON["signature_corrected_at"] = "2026-10-16T20:00:00.000Z"
        let correctedDocument = try documentDecoder.decode(LodgeDocument.self, from: JSONSerialization.data(withJSONObject: correctedJSON))
        precondition(correctedDocument.signatureCorrectedAt == "2026-10-16T20:00:00.000Z")
        precondition(correctedDocument.submittedAt == legacyDocument.submittedAt && correctedDocument.submittedTo == legacyDocument.submittedTo)
        print("PASS: native signature correction metadata decodes with legacy compatibility and preserves the earlier PDF email history")

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sign-native-packet-" + UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:directory) }
        let file = directory.appendingPathComponent("matching\"report\n.pdf")
        let bytes = Data("%PDF-1.4 fixture matching report".utf8)
        try bytes.write(to:file)
        SubmissionFixture.packetState = "sent"
        let result = try await model.attachSupportingReport(documentId:"fixture",url:file,sourceLabel:"Stone Square Dispensation Reports")
        precondition(result.state == "sent")
        let uploads = SubmissionFixture.requests.filter { $0.httpMethod == "PUT" }
        precondition(uploads.count == 1)
        let upload = uploads[0]
        let body = String(decoding:SubmissionFixture.uploadBodies[0],as:UTF8.self)
        precondition(body.contains("name=\"report\"; filename=\"matching_report_.pdf\""))
        precondition(body.contains("Stone Square Dispensation Reports") && body.contains(String(decoding:bytes,as:UTF8.self)))
        precondition(upload.value(forHTTPHeaderField:"Authorization") == "Bearer test-only-not-a-real-token")
        precondition(upload.value(forHTTPHeaderField:"Content-Type")?.contains("multipart/form-data; boundary=") == true)
        precondition(!SubmissionFixture.requests.contains { $0.url!.path == "/api/documents/fixture/submit" })
        print("PASS: native report upload keeps PDF bytes and source folder, sanitizes multipart filename, and never separately sends email")

        let supporting = try await model.supportingReportData(documentId:"fixture")
        precondition(String(decoding:supporting,as:UTF8.self).contains("fixture supporting report"))
        print("PASS: protected native report preview uses the injected authenticated session")

        let requestCount = SubmissionFixture.requests.count
        let oversized = directory.appendingPathComponent("too-large.pdf")
        try Data(repeating:0,count:12*1024*1024+1).write(to:oversized)
        do {
            _ = try await model.attachSupportingReport(documentId:"fixture",url:oversized,sourceLabel:"Selected report PDF")
            preconditionFailure("Oversized report must not upload")
        } catch ClientError.server(let message) { precondition(message.contains("12 MB")) }
        precondition(SubmissionFixture.requests.count == requestCount)
        print("PASS: native 12 MB limit rejects oversized reports before network activity")

        SubmissionFixture.uploadStatus = 409
        do {
            _ = try await model.attachSupportingReport(documentId:"fixture",url:file,sourceLabel:"Selected report PDF")
            preconditionFailure("A sending packet must not be replaced")
        } catch ClientError.conflict(let message) { precondition(message.contains("already sending")) }
        precondition(SubmissionFixture.requests.filter { $0.httpMethod == "PUT" }.count == 2)
        print("PASS: packet replacement conflict remains visible and a write is never automatically retried")

        let beforeInvalidResolution = SubmissionFixture.requests.count
        do {
            _ = try await model.resolveSubmission(documentId:"fixture",outcome:"not_delivered",note:"short",expectedAttemptedAt:"2026-10-16T19:00:00.000Z")
            preconditionFailure("Resolution needs a substantive verification note")
        } catch ClientError.rejected { }
        precondition(SubmissionFixture.requests.count == beforeInvalidResolution)
        do {
            _ = try await model.resolveSubmission(documentId:"fixture",outcome:"not_delivered",note:"Verified no delivery in logs.",expectedAttemptedAt:nil)
            preconditionFailure("Resolution must identify the exact delivery attempt")
        } catch ClientError.rejected { }
        precondition(SubmissionFixture.requests.count == beforeInvalidResolution)
        SubmissionFixture.packetState = "sent"
        let resolved = try await model.resolveSubmission(documentId:"fixture",outcome:"delivered",note:"  Checked delivery logs: fixture packet accepted.  ",expectedAttemptedAt:packet.delivery?.attemptedAt)
        precondition(resolved.state == "sent")
        let resolutionBody = try JSONSerialization.jsonObject(with:SubmissionFixture.resolutionBodies[0]) as! [String:String]
        precondition(resolutionBody["outcome"] == "delivered")
        precondition(resolutionBody["expectedAttemptedAt"] == "2026-10-16T19:00:00.000Z")
        precondition(resolutionBody["note"] == "Checked delivery logs: fixture packet accepted.")
        precondition(SubmissionFixture.requests.filter { $0.url!.path.hasSuffix("/submission-resolution") }.count == 1)
        print("PASS: native uncertain-delivery resolution requires a verification note and performs one explicit resolution write")

        model.user = User(id:9997,email:"secretary@example.invalid",name:"Fixture Secretary",role:"secretary",hasSignature:true)
        let beforeDenied = SubmissionFixture.requests.count
        do { _ = try await model.submissionPacket(documentId:"fixture"); preconditionFailure("Secretary must not manage owner packet") }
        catch ClientError.server { }
        do { _ = try await model.attachSupportingReport(documentId:"fixture",url:file,sourceLabel:"Selected report PDF"); preconditionFailure("Secretary must not attach owner packet") }
        catch ClientError.server { }
        do { _ = try await model.supportingReportData(documentId:"fixture"); preconditionFailure("Secretary must not open owner packet report") }
        catch ClientError.server { }
        do { _ = try await model.resolveSubmission(documentId:"fixture",outcome:"delivered",note:"Checked delivery logs.",expectedAttemptedAt:packet.delivery?.attemptedAt); preconditionFailure("Secretary must not resolve owner packet") }
        catch ClientError.server { }
        precondition(SubmissionFixture.requests.count == beforeDenied)
        print("PASS: native secretary and non-owner packet management is denied before network activity")
    }
}
