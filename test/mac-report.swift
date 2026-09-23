import Foundation
import PDFKit

final class ReportFixture: URLProtocol {
    static var pdf = Data()
    static var deliveries = 0
    static var handoffs = 0
    static var archives = 0
    static var portalBodies: [[String: Any]] = []
    static var mailed = true
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url?.path == "/api/reports/handoff" {
            precondition(request.url?.host == "sign-fixture.invalid")
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token")
            Self.handoffs += 1
            let expiry = Int(Date().addingTimeInterval(300).timeIntervalSince1970)
            let data = try! JSONSerialization.data(withJSONObject: ["url": "https://request.stonesquare22pha.org/report", "assertion": "synthetic-report-assertion", "expiresAt": expiry])
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        if request.url?.path == "/api/officer-reports" {
            precondition(request.url?.host == "sign-fixture.invalid")
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token")
            Self.archives += 1
            let data = Data(#"{"ok":true,"id":"officer-report-test","duplicate":false}"#.utf8)
            let response = HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        precondition(request.url?.host == "request.stonesquare22pha.org")
        precondition(request.url?.path == "/api/report")
        precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-report-assertion")
        var portalBody = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                portalBody.append(buffer, count: count)
            }
        }
        if let object = try? JSONSerialization.jsonObject(with: portalBody) as? [String: Any] {
            Self.portalBodies.append(object)
        }
        let sending = request.url!.query?.contains("copy=1") == true
        if sending { Self.deliveries += 1 }
        let data = sending ? try! JSONSerialization.data(withJSONObject: ["id": "RPT-NATIVE-TEST", "filename": "Native_Report.pdf", "pdf": Self.pdf.base64EncodedString(), "mailed": Self.mailed]) : Self.pdf
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
    static var statusCode = 200
    static var routeResponses: [String: (status: Int, data: Data)] = [:]
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
            let route = "\(request.httpMethod ?? "GET") \(request.url!.path)"
            let configured = Self.routeResponses[route]
            let payload = configured?.data ?? (request.url!.path == "/api/generation/status"
                ? Data(#"{"configured":true,"administratorDetails":true,"model":"gpt-5.6-luna","monthlyLimitDollars":5,"remainingDollars":4.75}"#.utf8)
                : Self.response)
            let response = HTTPURLResponse(url: request.url!, statusCode: configured?.status ?? Self.statusCode, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: payload)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

struct MinutesEnvelope: Encodable { let minutes: [MinutesRecord] }
struct MinutesSingleEnvelope: Encodable { let minutes: MinutesRecord; let notificationWarnings: [String] }

@main struct NativeReportTests {
    @MainActor static func main() async throws {
        let archiveJSON = Data(#"{"id":"historical-1","title":"Meeting Minutes, January 1, 2024","recordDate":"2024-01-01"}"#.utf8)
        let archiveRecord = try JSONDecoder().decode(FinalReportBrowserView.ArchiveRecord.self, from: archiveJSON)
        precondition(archiveRecord.id == "historical-1" && archiveRecord.recordDate == "2024-01-01")
        print("PASS: native archive list decodes the exact minimal API payload")
        precondition(LodgeDateTime.display("2026-06-15T21:01:00.000Z") == "Monday, June 15, 2026 at 5:01 PM EDT")
        precondition(LodgeDateTime.display("2026-12-15T21:01:00Z") == "Tuesday, December 15, 2026 at 4:01 PM EST")
        print("PASS: native queue timestamps use readable Eastern dates and times")
        let alertConfig = URLSessionConfiguration.ephemeral
        alertConfig.protocolClasses = [GenerationFixture.self]
        let alertSession = URLSession(configuration: alertConfig)
        defer { alertSession.invalidateAndCancel() }
        let reviewedDraft = MinutesDraft(
            organizerVersion: 2, sourceType: "notes", meetingDate: "2026-09-03",
            meetingType: "Stated Communication", degree: "Third Degree of Masonry",
            openingTime: "7:36 PM", closingTime: "10:30 PM", presiding: "WM Dixon-Saunders",
            quorum: "Yes", nextMeeting: "Thursday, September 17, 2026",
            prayerRequested: true, closingPrayerGiven: true, present: [], excused: [], visitors: [],
            officerAttendance: [], income: [], expenses: [], sections: [], warnings: [], sensitiveReview: [], actionItems: []
        )
        let reviewedRecord = MinutesRecord(
            masterChanges: [], submittedDraft: reviewedDraft, id: "reviewed-minutes", draft: reviewedDraft,
            status: "ready_for_distribution", createdBy: "Adrian Reese", updatedAt: "2026-09-13T23:00:00Z",
            createdByUserId: 2, preparerRole: "assistant_secretary", preparerAttestedAt: "2026-09-13T22:00:00Z",
            masterAttestedAt: "2026-09-13T23:00:00Z", approvedByLodgeOn: nil, approvalNote: nil
        )
        GenerationFixture.response = try JSONEncoder().encode(MinutesEnvelope(minutes: [reviewedRecord]))
        GenerationFixture.statusCode = 200
        let minutesApp = AppModel(session: alertSession, savedSessionToken: "synthetic-token")
        let savedMinutesServer = minutesApp.serverAddress
        minutesApp.serverAddress = "https://minutes-fixture.invalid"
        defer { minutesApp.serverAddress = savedMinutesServer }
        let alertWorkspace = MinutesWorkspace(session: alertSession)
        alertWorkspace.configure(minutesApp)
        alertWorkspace.token = "synthetic-token"
        let reviewedOpened = await alertWorkspace.openReviewedRecord(id: reviewedRecord.id)
        precondition(reviewedOpened, "reviewed alert did not open the matching minutes")
        precondition(alertWorkspace.selected?.id == reviewedRecord.id, "reviewed alert selected the wrong minutes")
        GenerationFixture.statusCode = 503
        let missingOpened = await alertWorkspace.openReviewedRecord(id: "missing-minutes")
        precondition(!missingOpened, "failed minutes load incorrectly reported success")
        print("PASS: native reviewed-minutes alerts clear only after the matching record opens")
        GenerationFixture.statusCode = 200
        GenerationFixture.requests = []
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReportFixture.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        ReportFixture.pdf = try Data(contentsOf: URL(fileURLWithPath: "test/sample-dispensation.pdf"))
        let secureReportApp = AppModel(session: session, savedSessionToken: "synthetic-token")
        let savedReportServer = secureReportApp.serverAddress
        secureReportApp.serverAddress = "https://sign-fixture.invalid"
        defer { secureReportApp.serverAddress = savedReportServer }
        secureReportApp.user = User(id: 1, email: "qa@example.org", name: "QA Officer", role: "secretary", hasSignature: true, permissions: ["reports.create"])
        let model = ReportBrowserModel(persistenceURL: scratch.appendingPathComponent("draft.json"), session: session)
        model.configure(secureReportApp)
        model.schema = ["officers": [["name": "QA Officer", "office": "Secretary"]], "types": ["officer": ["name": "Officer Report", "fields": [["id": "summary", "label": "Summary", "req": true]]]]]
        await model.prepare(send: false)
        precondition(model.pdf == nil && model.error?.contains("Summary is required") == true)
        print("PASS: missing required content prevents preview")
        model.fields = ["summary": "Fictional report test. No real Lodge records."]
        model.changed()
        precondition(model.draftSaved && FileManager.default.fileExists(atPath: model.persistenceURL!.path))
        let restored = ReportBrowserModel(persistenceURL: model.persistenceURL, session: session)
        precondition(restored.fields == model.fields && restored.draftSaved && !restored.reviewed && restored.signatureName.isEmpty)
        print("PASS: draft survives reopening without carrying a signature or approval")
        let anotherAccount = AppModel(session: session, savedSessionToken: "synthetic-token")
        anotherAccount.user = User(id: 2, email: "other@example.invalid", name: "Other Officer", role: "officer", hasSignature: true, permissions: ["reports.create"])
        let isolatedDraft = ReportBrowserModel(persistenceURL: model.persistenceURL, session: session)
        isolatedDraft.configure(anotherAccount)
        precondition(isolatedDraft.fields.isEmpty && isolatedDraft.source.isEmpty && isolatedDraft.phone.isEmpty && !isolatedDraft.draftSaved)
        print("PASS: a saved local report draft is never shown to a different Dashboard account")
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
        precondition(ReportFixture.handoffs == 1)
        precondition(ReportFixture.archives == 1)
        precondition(ReportFixture.portalBodies.count == 3)
        for body in ReportFixture.portalBodies {
            precondition(body["name"] == nil && body["email"] == nil && body["office"] == nil && body["isOfficer"] == nil && body["signatureName"] == nil)
            precondition(body["type"] as? String == "officer")
        }
        print("PASS: report preview and final use a short-lived signed handoff without editable officer identity")
        print("PASS: reviewed current report reaches only the isolated delivery fixture")
        ReportFixture.mailed = false
        await model.prepare(send: true)
        precondition(ReportFixture.deliveries == 2 && ReportFixture.archives == 2 && model.messageIsWarning && model.message.contains("delivery failed"))
        ReportFixture.mailed = true
        print("PASS: a prepared report with failed email delivery displays a distinct warning state")
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
        let bankingAlert = TreasuryAlert(
            id: "waiting-bank-record", title: "Banking information is awaiting report preparation",
            message: "Uploaded by John Brown.", uploadedBy: "John Brown", createdAt: "2026-09-20T14:00:00Z"
        )
        reportApp.treasuryAlerts = [bankingAlert]
        GenerationFixture.requests = []
        GenerationFixture.routeResponses = [
            "POST /api/treasury/alerts/waiting-bank-record/dismiss": (200, Data(#"{"ok":true}"#.utf8)),
        ]
        await reportApp.dismissTreasuryAlert(bankingAlert)
        precondition(reportApp.treasuryAlerts.isEmpty)
        precondition(GenerationFixture.requests.first?.method == "POST" && GenerationFixture.requests.first?.path == "/api/treasury/alerts/waiting-bank-record/dismiss")
        GenerationFixture.routeResponses = [:]
        print("PASS: native banking reminder dismissal persists through the shared service and clears the local sidebar alert")
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
        let waitingRecord = try JSONDecoder().decode(MinutesRecord.self, from: Data(#"{"id":"waiting-minutes","status":"awaiting_preparer","createdBy":"WM Dixon-Saunders","sourceUploadedBy":"WM Dixon-Saunders","updatedAt":"2026-09-20T14:00:00.000Z","draft":{"meetingType":"Stated Communication","present":[],"excused":[],"visitors":[],"officerAttendance":[],"income":[],"expenses":[],"sections":[],"warnings":[],"sensitiveReview":[],"actionItems":[]}}"#.utf8))
        let claimedRecord = try JSONDecoder().decode(MinutesRecord.self, from: Data(#"{"id":"waiting-minutes","status":"draft","createdBy":"Adrian Reese","sourceUploadedBy":"WM Dixon-Saunders","preparerUserId":502,"preparer":"Adrian Reese","claimedAt":"2026-09-20T14:05:00.000Z","updatedAt":"2026-09-20T14:05:05.000Z","draft":{"meetingDate":"2026-09-17","meetingType":"Stated Communication","present":[],"excused":[],"visitors":[],"officerAttendance":[],"income":[],"expenses":[],"sections":[{"heading":"Opening","body":"The Lodge opened in due form."}],"warnings":[],"sensitiveReview":[],"actionItems":[]}}"#.utf8))
        organizing.source = "Synthetic transcript sent by the Worshipful Master for Adrian Reese or William McDuffie to claim and organize into the Lodge meeting minutes."
        organizing.sourceType = "transcript"
        GenerationFixture.requests = []
        GenerationFixture.routeResponses = [
            "POST /api/minutes/handoff": (201, try JSONEncoder().encode(MinutesSingleEnvelope(minutes: waitingRecord, notificationWarnings: []))),
            "GET /api/minutes": (200, try JSONEncoder().encode(MinutesEnvelope(minutes: [waitingRecord]))),
        ]
        await organizing.handoff()
        let handoffRequest = GenerationFixture.requests.first { $0.path == "/api/minutes/handoff" }!
        let handoffBody = String(data: handoffRequest.body, encoding: .utf8) ?? ""
        precondition(handoffRequest.method == "POST" && handoffBody.contains("Synthetic transcript sent by the Worshipful Master") && handoffBody.contains("transcript"))
        precondition(organizing.source.isEmpty && organizing.records.first?.status == "awaiting_preparer" && organizing.message.contains("sent to Adrian Reese and William McDuffie"))
        print("PASS: native owner handoff sends the source to both Secretary offices and refreshes the shared queue")

        GenerationFixture.requests = []
        GenerationFixture.routeResponses = [
            "POST /api/minutes/waiting-minutes/claim": (200, try JSONEncoder().encode(MinutesSingleEnvelope(minutes: claimedRecord, notificationWarnings: []))),
            "GET /api/minutes": (200, try JSONEncoder().encode(MinutesEnvelope(minutes: [claimedRecord]))),
        ]
        await organizing.claim(waitingRecord)
        precondition(GenerationFixture.requests.first?.method == "POST" && GenerationFixture.requests.first?.path == "/api/minutes/waiting-minutes/claim")
        precondition(organizing.selected?.id == claimedRecord.id && organizing.selected?.status == "draft" && organizing.message.contains("assigned to you"))
        print("PASS: native Secretary claim opens the generated draft owned by the successful claimant")

        organizing.close()
        GenerationFixture.requests = []
        GenerationFixture.routeResponses = [
            "POST /api/minutes/waiting-minutes/claim": (409, Data(#"{"error":"This source has already been claimed by William M. McDuffie."}"#.utf8)),
            "GET /api/minutes": (200, try JSONEncoder().encode(MinutesEnvelope(minutes: [waitingRecord]))),
        ]
        await organizing.claim(waitingRecord)
        precondition(organizing.selected == nil && organizing.records.first?.id == waitingRecord.id && organizing.message.contains("already been claimed"))
        print("PASS: native claim conflict refreshes the queue and explains that another Secretary claimed it")
        GenerationFixture.routeResponses = [:]
        let status = await GenerationStatus.load(using: organizing)
        precondition(status?.explanation(forOwner: true).hasPrefix("Luna enabled.") == true && status?.allowance(forOwner: true)?.contains("$4.75 remaining of $5.00") == true)
        precondition(status?.allowance(forOwner: false) == nil)
        print("PASS: native generation status discloses enabled processing and shows allowance only to the owner")
        let localStatus = try JSONDecoder().decode(GenerationStatus.self, from: Data(#"{"configured":false,"administratorDetails":true,"monthlyLimitDollars":5}"#.utf8))
        precondition(localStatus.explanation(forOwner: true) == "Local organizer active. Luna setup is pending." && localStatus.allowance(forOwner: true) == nil)
        let unavailableStatus = await GenerationStatus.load(using: minutes)
        precondition(unavailableStatus == nil)
        print("PASS: unconfigured and unavailable generation states remain distinct without inventing an allowance")

        let minutesDraftDirectory = scratch.appendingPathComponent("minutes-local-draft")
        let localMinutes = MinutesWorkspace(session: generationSession, persistenceDirectory: minutesDraftDirectory)
        reportApp.user = User(id: 501, email: "owner@example.invalid", name: "QA Owner", role: "owner", hasSignature: true)
        localMinutes.configure(reportApp)
        localMinutes.source = "Synthetic unfinished minutes source."
        localMinutes.sourceType = "compiled_notes"
        let selectedFile = scratch.appendingPathComponent("minutes-source.txt")
        try Data("Synthetic file source".utf8).write(to: selectedFile)
        localMinutes.selectSourceFile(selectedFile)
        precondition(localMinutes.localDraftSaved && localMinutes.fileURL != selectedFile)
        localMinutes.message = "An officer attendance status is not established by its source reference. Please try again."
        localMinutes.prepareForDisplay()
        precondition(localMinutes.message.isEmpty)
        let restoredMinutes = MinutesWorkspace(session: generationSession, persistenceDirectory: minutesDraftDirectory)
        restoredMinutes.configure(reportApp)
        precondition(restoredMinutes.source == localMinutes.source)
        precondition(restoredMinutes.sourceType == "compiled_notes")
        precondition(restoredMinutes.sourceFileName == "minutes-source.txt")
        precondition(restoredMinutes.fileURL != nil)
        precondition(restoredMinutes.localDraftSaved)
        reportApp.user = User(id: 502, email: "other@example.invalid", name: "Other Officer", role: "secretary", hasSignature: true)
        let isolatedMinutes = MinutesWorkspace(session: generationSession, persistenceDirectory: minutesDraftDirectory)
        isolatedMinutes.configure(reportApp)
        precondition(isolatedMinutes.source.isEmpty && isolatedMinutes.fileURL == nil && !isolatedMinutes.localDraftSaved)
        reportApp.user = User(id: 501, email: "owner@example.invalid", name: "QA Owner", role: "owner", hasSignature: true)
        restoredMinutes.clearLocalSourceDraft()
        precondition(restoredMinutes.source.isEmpty && restoredMinutes.fileURL == nil && !restoredMinutes.localDraftSaved)
        print("PASS: unfinished minutes source and selected files persist privately per user, stale errors clear on return, and explicit clearing removes the local draft")

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
        let agenda = AgendaWorkspace()
        model.startOver(); organizing.close(); treasury.close(); agenda.close()
        precondition(AppUpdater.unfinishedReportWork(report: model, minutes: organizing, treasury: treasury, agenda: agenda, operationInProgress: false) == nil)
        organizing.dirty = true
        precondition(AppUpdater.unfinishedReportWork(report: model, minutes: organizing, treasury: treasury, agenda: agenda, operationInProgress: false)?.contains("Meeting Minutes edits") == true)
        organizing.dirty = false; organizing.source = "Unsaved source"
        precondition(AppUpdater.unfinishedReportWork(report: model, minutes: organizing, treasury: treasury, agenda: agenda, operationInProgress: false)?.contains("source notes") == true)
        organizing.localDraftSaved = true
        precondition(AppUpdater.unfinishedReportWork(report: model, minutes: organizing, treasury: treasury, agenda: agenda, operationInProgress: false) == nil)
        organizing.localDraftSaved = false
        organizing.source = ""; treasury.bankingSource = "Unsaved banking source"
        precondition(AppUpdater.unfinishedReportWork(report: model, minutes: organizing, treasury: treasury, agenda: agenda, operationInProgress: false)?.contains("source material") == true)
        treasury.bankingSource = ""; treasury.originalText = "Previously saved banking source"
        model.source = "Locally saved report notes"; model.changed()
        precondition(AppUpdater.unfinishedReportWork(report: model, minutes: organizing, treasury: treasury, agenda: agenda, operationInProgress: false) == nil)
        agenda.dirty = true
        precondition(AppUpdater.unfinishedReportWork(report: model, minutes: organizing, treasury: treasury, agenda: agenda, operationInProgress: false)?.contains("Agenda Creator edits") == true)
        agenda.dirty = false
        precondition(AppUpdater.unfinishedReportWork(report: model, minutes: organizing, treasury: treasury, agenda: agenda, operationInProgress: true) != nil)
        let updater = AppUpdater()
        let editorID = UUID()
        updater.setEditorGuard(editorID, reason: "Unfinished candidate record")
        precondition(updater.unfinishedWorkReason == "Unfinished candidate record")
        updater.setEditorGuard(editorID, reason: nil)
        precondition(updater.unfinishedWorkReason == nil)
        let firstWindow = UUID(), secondWindow = UUID()
        updater.setWorkspaceGuard(firstWindow) { "Unsaved workspace" }
        updater.setWorkspaceGuard(secondWindow) { nil }
        precondition(updater.unfinishedWorkReason == "Unsaved workspace")
        updater.setWorkspaceGuard(secondWindow, check: nil)
        precondition(updater.unfinishedWorkReason == "Unsaved workspace")
        updater.setWorkspaceGuard(secondWindow) { "Second window edits" }
        updater.setWorkspaceGuard(firstWindow, check: nil)
        precondition(updater.unfinishedWorkReason == "Second window edits")
        updater.setWorkspaceGuard(secondWindow, check: nil)
        precondition(updater.unfinishedWorkReason == nil)
        print("PASS: each window retains its update guard when another window opens or closes")
        print("PASS: updater blocks unfinished operations and report input but permits saved local notes and loaded banking sources")
        let warden = User(id: 42, email: "synthetic-warden@example.invalid", name: "QA Warden", role: "warden", hasSignature: false)
        precondition(warden.canSign && warden.canReadDues && warden.canProposeDispensation && warden.canUseTreasury && !warden.can("treasury.prepare"))
        precondition(warden.proposalWorkspaceTitle == "My Dispensation Proposals" && warden.showsPersonalProposals)
        precondition(warden.canOpen(.documents) && !warden.canReadApprovals && !warden.canOpen(.approvals))
        let decoder = JSONDecoder()
        let restrictedSecretary = try decoder.decode(User.self, from: Data(#"{"id":44,"email":"qa@example.invalid","name":"QA Secretary","role":"secretary","hasSignature":true,"permissions":["minutes.view","settings.manage"]}"#.utf8))
        precondition(restrictedSecretary.canReadMinutes && !restrictedSecretary.can("minutes.prepare") && !restrictedSecretary.canSign)
        precondition(!restrictedSecretary.canReadApprovals)
        precondition(restrictedSecretary.canOpen(.settings) && !restrictedSecretary.canOpen(.access) && !restrictedSecretary.canOpen(.documents))
        let manualPreparer = try decoder.decode(User.self, from: Data(#"{"id":45,"email":"qa@example.invalid","name":"QA Preparer","role":"treasury_preparer","hasSignature":true,"permissions":["treasury.prepare","dues.self","signature.manage","settings.manage"]}"#.utf8))
        precondition(manualPreparer.canUseTreasury && !manualPreparer.can("treasury.upload") && !manualPreparer.canOpen(.reportGenerator) && !manualPreparer.canOpen(.minutes))
        let admin = try decoder.decode(User.self, from: Data(#"{"id":46,"email":"qa@example.invalid","name":"QA Owner","role":"owner","hasSignature":true,"permissions":[]}"#.utf8))
        precondition(admin.canOpen(.access) && admin.can("treasury.upload") && admin.can("documents.sign"))
        precondition(!admin.showsPersonalProposals && admin.canOpen(.proposalReview) && admin.proposalWorkspaceTitle == "Warden Proposals")
        let access = try decoder.decode(AccountAccessResponse.self, from: Data(#"{"capabilities":[{"id":"minutes.prepare","label":"Prepare minutes"}],"accounts":[{"key":"invite:7","id":7,"name":"QA Officer","email":"qa@example.invalid","role":"officer","pending":true,"revoked":false,"permissions":["minutes.view"]}]}"#.utf8))
        precondition(access.accounts[0].id == "invite:7" && access.accounts[0].pending && access.capabilities[0].id == "minutes.prepare")
        print("PASS: explicit capabilities override role defaults, finalized readers cannot prepare, manual treasury preparers lack upload, and owner retains administration")
        let normalizedPermissions = AccessPermissions.normalized(["minutes.prepare", "treasury.upload", "documents.sign", "signature.manage", "candidates.edit"])
        precondition(normalizedPermissions == ["minutes.prepare", "minutes.view", "treasury.upload", "treasury.view", "documents.sign", "documents.status", "signature.manage", "candidates.edit", "candidates.view"])
        precondition(AccessPermissions.normalized(["treasury.prepare"]) == ["treasury.prepare", "treasury.view"])
        precondition(AccessPermissions.normalized(normalizedPermissions) == normalizedPermissions)
        let officer = User(id: 47, email: "qa@example.invalid", name: "QA Officer", role: "officer", hasSignature: true)
        precondition(officer.canOpen(.reportGenerator) && officer.canOpen(.minutes) && officer.canOpen(.treasury) && officer.canOpen(.profile) && officer.canOpen(.settings))
        precondition(!officer.can("minutes.prepare") && !officer.can("treasury.prepare") && !officer.canOpen(.access))
        print("PASS: permission prerequisites normalize consistently and the officer fallback grants only reports, finalized views, signature and settings")
        let candidateEditor = User(id: 48, email: "editor@example.invalid", name: "QA Candidate Editor", role: "officer", hasSignature: true, permissions: ["candidates.view", "candidates.edit"])
        precondition(candidateEditor.canOpen(.candidateTracker) && candidateEditor.can("candidates.edit"))
        let candidateReader = User(id: 49, email: "reader@example.invalid", name: "QA Candidate Reader", role: "officer", hasSignature: true, permissions: ["candidates.view"])
        precondition(candidateReader.canOpen(.candidateTracker) && !candidateReader.can("candidates.edit"))
        print("PASS: candidate viewing and editing are independently assigned capabilities")
        var uploader = warden; uploader.permissions = ["treasury.upload", "treasury.view"]
        precondition(!treasuryRecord.canOpen(for: uploader))
        var finalizedTreasury = treasuryRecord; finalizedTreasury.status = "ready_for_distribution"
        precondition(finalizedTreasury.canOpen(for: uploader) && treasuryRecord.canOpen(for: manualPreparer))
        print("PASS: upload-only accounts cannot open unsigned treasury rows but can open finalized reports")
        let redactedStatus = try JSONDecoder().decode(GenerationStatus.self, from: Data(#"{"configured":true}"#.utf8))
        precondition(redactedStatus.allowance(forOwner: false) == nil)
        precondition(!redactedStatus.explanation(forOwner: false).contains("Luna"))
        precondition(!redactedStatus.explanation(forOwner: false).contains("OpenAI"))
        precondition(LodgeCalendarDates.displayDate("2026-09-19") == "Sep 19, 2026")
        precondition(LodgeCalendarDates.displayTime("19:30") == "7:30 PM")
        precondition(LodgeCalendarDates.displayTime(nil).isEmpty)
        print("PASS: calendar, building request and treasury list dates use consistent readable Eastern formatting")
        var proposalDraft = DispensationProposalDraft()
        precondition(!proposalDraft.isReady)
        proposalDraft.eventDate = "2026-10-15"; proposalDraft.requestDetails = "Synthetic event request."
        precondition(proposalDraft.isReady)
        proposalDraft.requestDetails = String(repeating: "x", count: 601)
        precondition(!proposalDraft.isReady)
        proposalDraft.requestDetails = "Synthetic event request."
        reportApp.user = warden
        GenerationFixture.beforeReply = { request in
            GenerationFixture.response = request.httpMethod == "POST" ? Data(#"{"proposal":{"id":"synthetic-proposal"},"notificationWarnings":["Notification delivery needs review."]}"#.utf8) : Data(#"{"proposals":[]}"#.utf8)
        }
        let proposalSubmitted = await reportApp.submitProposal(proposalDraft)
        precondition(proposalSubmitted && reportApp.message.contains("Notification delivery needs review.") && reportApp.messageIsWarning)
        GenerationFixture.beforeReply = nil
        let proposalRequest = GenerationFixture.requests.last { $0.path == "/api/proposals" && $0.method == "POST" }!
        let proposalBody = try JSONSerialization.jsonObject(with: proposalRequest.body) as! [String: String]
        precondition(proposalBody["eventDate"] == "2026-10-15" && proposalBody["requestDetails"] == "Synthetic event request.")
        print("PASS: Wardens have assigned native navigation, submit proposals through the authenticated service, see delivery warnings, and see no generation model or allowance details")
        var changedWarden = warden; changedWarden.permissions = []
        GenerationFixture.response = try JSONEncoder().encode(["user": changedWarden])
        await reportApp.refresh(silent: true)
        precondition(reportApp.user?.permissions == [] && reportApp.user?.canReadDues == false && reportApp.documents.isEmpty)
        print("PASS: periodic account refresh applies changed permissions without another sign-in")
        precondition(GenerationFixture.requests.allSatisfy { $0.path == "/api/auth/me" || $0.path == "/api/generation/status" || $0.path == "/api/proposals" || $0.path == "/api/minutes" || $0.path == "/api/minutes/handoff" || $0.path.hasSuffix("/claim") || $0.path.hasSuffix("/reorganize") || $0.path.hasSuffix("/organize") })
        print("PASS: generation and proposal fixtures make no signing or document delivery requests")
        let buildingPayload = Data(#"{"requests":[{"id":"request-1","organization":"Synthetic group","contactName":"QA Contact","contact":"qa@example.invalid","date":"2026-11-01","start":"","end":"","spaces":["Front yard"],"bathroomAccess":true,"description":"Synthetic request","status":"pending","note":"","revision":"r1","requesterNotified":false}],"canDecide":true}"#.utf8)
        let building = BuildingRequestsWorkspace()
        var buildingReader = warden; buildingReader.permissions = ["building.view", "calendar.view"]
        reportApp.user = buildingReader
        GenerationFixture.response = buildingPayload
        await building.load(using: reportApp)
        let requestCount = GenerationFixture.requests.count
        let unauthorizedDecision = await building.decide(building.requests[0], decision: "approved", note: "", using: reportApp)
        precondition(!unauthorizedDecision && GenerationFixture.requests.count == requestCount)
        var buildingDecider = buildingReader; buildingDecider.permissions = ["building.view", "building.decide", "calendar.view"]
        reportApp.user = buildingDecider
        GenerationFixture.beforeReply = { request in
            precondition(request.url?.host == "generation-fixture.invalid")
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token")
            GenerationFixture.statusCode = request.httpMethod == "POST" ? 409 : 200
            GenerationFixture.response = request.httpMethod == "POST" ? Data(#"{"error":"The request changed."}"#.utf8) : buildingPayload
        }
        let staleDecision = await building.decide(building.requests[0], decision: "approved", note: "Synthetic note", using: reportApp)
        precondition(!staleDecision && building.message.contains("latest details"))
        let buildingDecision = GenerationFixture.requests.last { $0.path.hasSuffix("/decision") }!
        let decisionBody = try JSONSerialization.jsonObject(with: buildingDecision.body) as! [String: Any]
        precondition(decisionBody["revision"] as? String == "r1" && decisionBody["decision"] as? String == "approved")
        GenerationFixture.beforeReply = nil; GenerationFixture.statusCode = 200
        let approvedPayload = Data(#"{"request":{"id":"request-1","organization":"Synthetic group","contactName":"QA Contact","contact":"qa@example.invalid","date":"2026-11-01","spaces":["Front yard"],"bathroomAccess":true,"description":"Synthetic request","status":"approved","revision":"r2","requesterNotified":false}}"#.utf8)
        GenerationFixture.response = approvedPayload
        let recordedDecision = await building.decide(building.requests[0], decision: "approved", note: "Synthetic note", using: reportApp)
        precondition(recordedDecision && building.message.contains("not been confirmed") && building.messageIsWarning && building.requests[0].status == "approved")
        print("PASS: building reads never decide, view-only accounts cannot decide, stale decisions reload, and notification status stays accurate")
        let calendarPayload = Data(#"{"events":[{"id":"event-1","title":"Synthetic event","startDate":"2026-11-01","endDate":"2026-11-03","startTime":"","endTime":"","allDay":false,"location":"Hall","description":"Synthetic notes","category":"lodge","status":"tentative","source":"Lodge calendar","editable":true,"sourceUrl":"","revision":"3"}],"warnings":["External calendar unavailable."],"timezone":"America/New_York"}"#.utf8)
        let calendar = LodgeCalendarWorkspace()
        GenerationFixture.response = calendarPayload
        let selectedDate = ISO8601DateFormatter().date(from: "2026-11-01T04:30:00Z")!
        await calendar.load(date: selectedDate, using: reportApp)
        let event = calendar.events[0]
        precondition(event.includes(day: "2026-11-03") && !event.includes(day: "2026-11-04") && !event.allDay && event.timeLabel.isEmpty)
        precondition(LodgeCalendarDates.range(selectedDate) == ("2026-11-01", "2026-11-30"))
        precondition(!LodgeCalendarDates.valid("2026-02-30") && calendar.warnings.count == 1)
        let eventDraft = LodgeEventDraft(event)
        precondition(eventDraft.valid && eventDraft.status == "tentative" && eventDraft.revision == "3")
        let beforeViewOnlySave = GenerationFixture.requests.count
        let deniedCalendarSave = await calendar.save(eventDraft, event: event, date: selectedDate, using: reportApp)
        precondition(!deniedCalendarSave && GenerationFixture.requests.count == beforeViewOnlySave)
        reportApp.user = admin
        GenerationFixture.beforeReply = { request in
            GenerationFixture.response = request.httpMethod == "GET" ? calendarPayload : Data(#"{"ok":true}"#.utf8)
        }
        let calendarSaved = await calendar.save(eventDraft, event: event, date: selectedDate, using: reportApp)
        precondition(calendarSaved)
        let calendarWrite = GenerationFixture.requests.last { $0.path == "/api/lodge-calendar/event-1" && $0.method == "PUT" }!
        let eventBody = try JSONSerialization.jsonObject(with: calendarWrite.body) as! [String: Any]
        precondition(eventBody["revision"] as? String == "3" && eventBody["status"] as? String == "tentative" && eventBody["allDay"] as? Bool == false)
        GenerationFixture.beforeReply = nil
        precondition(AccessPermissions.normalized(["building.decide", "calendar.manage"]) == ["building.decide", "building.view", "calendar.manage", "calendar.view"])
        print("PASS: calendar uses Eastern month ranges, inclusive dates, unknown times, visible source warnings and manager-only versioned edits")
        var requester = warden; requester.permissions = ["building.request"]
        reportApp.user = requester
        precondition(requester.canOpen(.building) && !requester.can("building.view"))
        let beforeQueue = GenerationFixture.requests.count
        await building.load(using: reportApp)
        precondition(GenerationFixture.requests.count == beforeQueue && building.requests.isEmpty)
        var pickerBooking = BuildingBooking()
        precondition(pickerBooking.start == "09:00" && pickerBooking.end == "10:00")
        pickerBooking.dateSelection = ISO8601DateFormatter().date(from: "2026-11-02T01:00:00Z")!
        precondition(pickerBooking.date == "2026-11-01")
        pickerBooking.startSelection = ISO8601DateFormatter().date(from: "2000-01-01T14:30:00Z")!
        precondition(pickerBooking.start == "09:30")
        pickerBooking.endSelection = ISO8601DateFormatter().date(from: "2000-01-01T15:30:00Z")!
        precondition(pickerBooking.end == "10:30" && pickerBooking.valid)
        let newRequest = NewBuildingRequestWorkspace()
        newRequest.draft.bookings = [BuildingBooking(date: "2026-11-01", start: "13:00", end: "15:00")]
        newRequest.draft.spaces = ["Lodge building", "Back yard"]
        newRequest.draft.phone = ""; newRequest.draft.details = "Synthetic Lodge event"
        precondition(newRequest.draft.validationMessage == nil && !newRequest.canSubmit)
        GenerationFixture.response = Data(#"{"busy":[{"date":"2026-11-01","start":"14:00","end":"16:00","label":"Pending hold","status":"pending","allDay":false}]}"#.utf8)
        await newRequest.checkAvailability(using: reportApp)
        precondition(newRequest.conflicts.count == 1 && !newRequest.canSubmit)
        newRequest.draft.bookings[0].end = "14:00"
        precondition(!newRequest.availabilityCurrent)
        await newRequest.checkAvailability(using: reportApp)
        precondition(newRequest.conflicts.isEmpty && newRequest.canSubmit)
        GenerationFixture.response = Data(#"{"busy":[{"date":"2026-11-01","label":"Unknown time","allDay":false}]}"#.utf8)
        await newRequest.checkAvailability(using: reportApp)
        precondition(!newRequest.availabilityWarning.isEmpty && !newRequest.canSubmit)
        newRequest.warningAcknowledged = true
        precondition(newRequest.canSubmit)
        GenerationFixture.statusCode = 503; GenerationFixture.response = Data(#"{"error":"Synthetic unavailable"}"#.utf8)
        let originalID = newRequest.draft.submissionId
        let failedSubmit = await newRequest.submit(using: reportApp)
        precondition(!failedSubmit && newRequest.retryPending && newRequest.draft.submissionId == originalID)
        let firstSubmit = GenerationFixture.requests.last!.body
        let submittedFields = try JSONSerialization.jsonObject(with: firstSubmit) as! [String: Any]
        precondition(submittedFields["purpose"] as? String == "Synthetic Lodge event" && submittedFields["acknowledgeAvailabilityWarning"] as? Bool == true)
        precondition(submittedFields["name"] == nil && submittedFields["email"] == nil && submittedFields["organization"] == nil)
        let beforeRetryCheck = GenerationFixture.requests.count
        await newRequest.checkAvailability(using: reportApp)
        precondition(GenerationFixture.requests.count == beforeRetryCheck)
        GenerationFixture.statusCode = 200; GenerationFixture.response = Data(#"{"ok":true,"ref":"synthetic-ref","refs":["synthetic-ref"],"wmNotified":false}"#.utf8)
        let recovered = await newRequest.submit(using: reportApp)
        precondition(recovered && GenerationFixture.requests.last!.body == firstSubmit && newRequest.receipt?.references == ["synthetic-ref"] && newRequest.messageIsWarning && !newRequest.hasUnsubmittedChanges)
        newRequest.startNew()
        precondition(newRequest.draft.submissionId != originalID && !newRequest.retryPending)
        print("PASS: native Lodge requests isolate queue access, block pending overlaps, require availability review and acknowledgment, and recover receipts with an identical frozen submission")
    }
}
