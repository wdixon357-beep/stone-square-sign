import AppKit
import SwiftUI
import PDFKit
import UniformTypeIdentifiers

private func minutesStatusLabel(_ status: String) -> String {
    switch status {
    case "awaiting_preparer": "Awaiting Adrian or McDuffie"
    case "organizing": "Creating the organized draft"
    case "ready_for_distribution": "Signed and available in the Dashboard"
    case "distributed": "Distributed by the Secretary or Assistant Secretary"
    default: status.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

struct MinutesSection: Codable, Equatable { var heading: String; var body: String }
struct MinutesAttendance: Codable, Equatable {
    var name: String
    var title: String
    var status: String
    var stationCoverage: String? = nil
    var actingName: String? = nil
    var actingRole: String? = nil
    var actingWholeMeeting: Bool? = nil

    var requiresStationCoverage: Bool { ["excused", "absent", "arrived_late"].contains(status) }
    var hasStationCoverageValues: Bool {
        stationCoverage != nil || !(actingName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actingRole != nil || actingWholeMeeting != nil
    }
    func reviewComplete(requiringCoverage: Bool) -> Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              ["present", "excused", "absent", "arrived_late"].contains(status) else { return false }
        guard requiringCoverage else { return true }
        if let actingRole, actingRole != assistantRole || stationCoverage != "filled" { return false }
        let coverage = ["filled", "vacant"].contains(stationCoverage ?? "") ? stationCoverage : nil
        let hasActingName = !(actingName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard requiresStationCoverage else { return coverage == nil && !hasActingName && actingRole == nil && actingWholeMeeting == nil }
        guard let coverage else { return false }
        if coverage == "vacant" { return !hasActingName && actingRole == nil && actingWholeMeeting == nil }
        guard !(actingName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !Self.sameOfficer(actingName ?? "", name),
              let actingWholeMeeting else { return false }
        return actingWholeMeeting || status == "arrived_late"
    }
    var assistantRole: String? {
        switch title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "treasurer": return "Assistant Treasurer"
        case "secretary": return "Assistant Secretary"
        default: return nil
        }
    }
    mutating func selectAssistant(role: String, name: String) {
        guard role == assistantRole, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let changed = stationCoverage != "filled" || actingName != name || actingRole != role
        stationCoverage = "filled"; actingName = name; actingRole = role
        if changed { actingWholeMeeting = nil }
    }
    static func sameOfficer(_ left: String, _ right: String) -> Bool {
        func tokens(_ value: String) -> [String] {
            value.lowercased()
                .replacingOccurrences(of: #"\b(?:past\s+master|brother|bro|pm|hpm|jr|sr|ii|iii|iv)\b"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"[^a-z]+"#, with: " ", options: .regularExpression)
                .split(whereSeparator: { $0.isWhitespace }).map(String.init).filter { $0.count > 1 }
        }
        let a = tokens(left), b = tokens(right)
        guard !a.isEmpty, !b.isEmpty else { return false }
        func isOfficeAlias(_ value: String) -> Bool {
            value.trimmingCharacters(in: .whitespacesAndNewlines).range(
                of: #"^(?:wm|sw|jw|sd|jd|ss|js)\.?\s+[a-z'-]+\.?$"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
        }
        let officeAlias = (isOfficeAlias(left) || isOfficeAlias(right)) && a.last == b.last
        return a.joined() == b.joined()
            || (a.count >= 2 && b.count >= 2 && a.first == b.first && a.last == b.last)
            || officeAlias
    }
    mutating func setStatus(_ value: String) {
        guard status != value else { return }
        status = value
        if !requiresStationCoverage {
            stationCoverage = nil; actingName = nil; actingRole = nil; actingWholeMeeting = nil
        } else if value != "arrived_late", actingWholeMeeting == false {
            actingWholeMeeting = nil
        }
    }
    mutating func setCoverage(_ value: String?) {
        stationCoverage = value
        if value != "filled" { actingName = nil; actingRole = nil; actingWholeMeeting = nil }
    }
    mutating func setWholeMeeting(_ value: Bool?) {
        actingWholeMeeting = value
        // Choosing this answer explicitly records the regular officer's arrival.
        if value == false { status = "arrived_late" }
    }
}
struct MinutesAttendanceReview: Codable, Equatable {
    var officerRoll: Bool = false
    var otherPresent: Bool = false
    var otherExcused: Bool = false
}
enum MinutesAttendanceWorkflow {
    static func requiresPreparerConfirmation(status: String?, preparerUserID: Int?, createdByUserID: Int?, viewerUserID: Int?) -> Bool {
        guard status == "draft", let preparer = preparerUserID ?? createdByUserID, let viewerUserID else { return false }
        return preparer == viewerUserID
    }
    static func statusLabel(_ status: String, preparing: Bool) -> String {
        switch status {
        case "present": return "Present"
        case "arrived_late": return "Arrived later"
        case "excused": return "Excused"
        case "absent": return "Absent"
        default: return preparing ? "Needs confirmation" : "Not recorded"
        }
    }
    static func coverageSummary(_ row: MinutesAttendance) -> String? {
        guard row.requiresStationCoverage || row.hasStationCoverageValues else { return nil }
        if !row.requiresStationCoverage { return "Recorded station coverage differs from the attendance status." }
        if row.actingWholeMeeting == false && row.status != "arrived_late" {
            return "Partial coverage is recorded, but the regular officer's arrival is not recorded."
        }
        if row.stationCoverage == "vacant" {
            return row.status == "arrived_late" ? "Station remained vacant until the regular officer arrived." : "Station remained vacant."
        }
        if row.stationCoverage == "filled", let name = row.actingName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            let covering = row.actingRole == row.assistantRole ? [row.actingRole, name].compactMap { $0 }.joined(separator: " ") : name
            if row.actingWholeMeeting == true { return "Covered by \(covering) for the whole meeting." }
            if row.actingWholeMeeting == false { return "Covered by \(covering) until the regular officer arrived." }
            return "Covered by \(covering); duration not recorded."
        }
        return "Station coverage not recorded."
    }
    static func assistantCoverageIssue(_ row: MinutesAttendance, officers: [MinutesAttendance]) -> String? {
        guard let role = row.actingRole else { return nil }
        guard role == row.assistantRole, row.stationCoverage == "filled" else {
            return "Select the correct assistant for this station or choose another covering Brother."
        }
        let assistants = officers.filter { $0.title.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare(role) == .orderedSame }
        guard assistants.count == 1, let assistant = assistants.first,
              MinutesAttendance.sameOfficer(row.actingName ?? "", assistant.name) else {
            return "The \(role)'s recorded name does not match this coverage. Review the officer roll and select station coverage again."
        }
        return nil
    }
    static func visibleReminders(_ warnings: [String], officers: [MinutesAttendance], preparing: Bool) -> [String] {
        guard !preparing else { return warnings }
        let prefix = "Confirm attendance for "
        let suffix = ": the source mentions the officer but does not establish an attendance status."
        return warnings.compactMap { warning in
            guard warning.hasPrefix(prefix), warning.hasSuffix(suffix) else { return warning }
            let name = String(warning.dropFirst(prefix.count).dropLast(suffix.count))
            if officers.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame
                && ["present", "arrived_late", "excused", "absent"].contains($0.status) }) { return nil }
            return "The preparing officer still needs to record attendance for \(name)."
        }
    }
}
struct MinutesFinance: Codable, Equatable {
    var date: String?; var reference: String?; var party: String?; var description: String?; var amount: String?
}
struct MinutesDraft: Codable, Equatable {
    var organizerVersion: Int?
    var officerAttendanceVersion: Int?
    var closingFormatVersion: Int?
    var meetingDetailsVersion: Int?
    var sourceType: String?
    var meetingDate: String?; var meetingType: String; var degree: String?
    var openingTime: String?; var closingTime: String?; var presiding: String?; var quorum: String?; var nextMeeting: String?
    var prayerRequested: Bool?; var closingPrayerGiven: Bool?
    var present: [String]; var excused: [String]; var visitors: [String]
    var officerAttendance: [MinutesAttendance]
    var attendanceReview: MinutesAttendanceReview?
    var income: [MinutesFinance]; var expenses: [MinutesFinance]
    var sections: [MinutesSection]; var warnings: [String]; var sensitiveReview: [String]; var actionItems: [String]
    var presidingReviewComplete: Bool {
        !warnings.contains("Confirm the presiding officer before attestation: the generated name had no source reference and has been left unconfirmed.")
            || !(presiding ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
struct MinutesChange: Codable, Hashable { let field: String; let before: String; let after: String }
struct MinutesRecord: Codable, Identifiable {
    var masterChanges: [MinutesChange]?; var submittedDraft: MinutesDraft?
    var id: String; var draft: MinutesDraft; var status: String; var createdBy: String; var updatedAt: String
    var createdByUserId: Int?; var preparerRole: String?; var preparerAttestedAt: String?; var masterAttestedAt: String?
    var sourceUploadedByUserId: Int?; var sourceUploadedBy: String?; var preparerUserId: Int?; var preparer: String?; var claimedAt: String?
    var approvedByLodgeOn: String?; var approvalNote: String?
}
struct MinutesListPayload: Decodable { let minutes: [MinutesRecord] }
struct MinutesPayload: Decodable { let minutes: MinutesRecord; let notificationWarnings: [String]? }
struct ReorganizedPayload: Decodable { let draft: MinutesDraft }
struct MinutesSavePayload: Encodable { let draft: MinutesDraft; let expectedUpdatedAt: String }


struct MinutesMeetingDetails: Codable, Equatable {
    var meetingDate = ""
    var meetingType = ""
    var degree = ""
    var openingTime = ""
    var closingTime = ""
    var presiding = ""
    var quorum = ""
    var nextMeeting = ""

    init() {}
    init(draft: MinutesDraft) {
        meetingDate = draft.meetingDate ?? ""; meetingType = draft.meetingType; degree = draft.degree ?? ""
        openingTime = draft.openingTime ?? ""; closingTime = draft.closingTime ?? ""
        presiding = draft.presiding ?? ""; quorum = draft.quorum ?? ""; nextMeeting = draft.nextMeeting ?? ""
    }
    private static func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
    static func dateValue(_ value: String) -> String? {
        let value = trimmed(value)
        guard let match = MinutesDateText.match(value), match.range == value.startIndex..<value.endIndex else { return nil }
        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX")
        format.calendar = MinutesDateText.calendar; format.timeZone = MinutesDateText.calendar.timeZone; format.dateFormat = "yyyy-MM-dd"
        return format.string(from: match.date)
    }
    static func validTime(_ value: String) -> Bool {
        let value = trimmed(value)
        return value.range(of: #"^(?:(?:0?[1-9]|1[0-2])(?::[0-5][0-9])?\s*(?:a\.?m\.?|p\.?m\.?)|(?:[01][0-9]|2[0-3]):[0-5][0-9])$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }
    var hasValues: Bool { [meetingDate, meetingType, degree, openingTime, closingTime, presiding, quorum, nextMeeting].contains { !Self.trimmed($0).isEmpty } }
    var missingFields: [String] {
        var fields: [String] = []
        if Self.dateValue(meetingDate) == nil { fields.append("meeting date") }
        if Self.trimmed(meetingType).isEmpty || Self.trimmed(meetingType).count > 100 { fields.append("meeting type") }
        if !["First Degree", "Second Degree", "Third Degree", "Round Table"].contains(Self.trimmed(degree)) { fields.append("degree") }
        if !Self.validTime(openingTime) { fields.append("opening time with AM or PM") }
        if !Self.validTime(closingTime) { fields.append("closing time with AM or PM") }
        if Self.trimmed(presiding).isEmpty || Self.trimmed(presiding).count > 160 { fields.append("presiding officer") }
        if !["Yes", "No"].contains(Self.trimmed(quorum)) { fields.append("quorum") }
        if Self.dateValue(nextMeeting) == nil { fields.append("next meeting date") }
        return fields
    }
    var isComplete: Bool { missingFields.isEmpty }
    var normalized: MinutesMeetingDetails {
        var value = self
        value.meetingDate = Self.dateValue(meetingDate) ?? Self.trimmed(meetingDate)
        value.nextMeeting = Self.dateValue(nextMeeting) ?? Self.trimmed(nextMeeting)
        value.meetingType = Self.trimmed(meetingType); value.openingTime = Self.trimmed(openingTime)
        value.closingTime = Self.trimmed(closingTime); value.presiding = Self.trimmed(presiding)
        value.degree = Self.trimmed(degree); value.quorum = Self.trimmed(quorum)
        return value
    }
    var completionMessage: String { "Complete the meeting details before creating or submitting minutes: " + missingFields.joined(separator: ", ") + "." }
}
struct MinutesClaimPayload: Encodable { let meetingDetails: MinutesMeetingDetails }
struct MinutesReorganizePayload: Encodable { let expectedUpdatedAt: String; let meetingDetails: MinutesMeetingDetails }

@MainActor
final class MinutesWorkspace: ObservableObject {
    @Published var records: [MinutesRecord] = []
    @Published var selected: MinutesRecord?
    @Published var draft: MinutesDraft?
    @Published var source = "" { didSet { if source != oldValue { persistLocalSourceDraft() } } }
    @Published var meetingDetails = MinutesMeetingDetails() { didSet { if meetingDetails != oldValue { persistLocalSourceDraft() } } }
    @Published var sourceType = "auto" { didSet { if sourceType != oldValue { persistLocalSourceDraft() } } }
    @Published var fileURL: URL? { didSet { if fileURL != oldValue { persistLocalSourceDraft() } } }
    @Published var sourceFileName = ""
    @Published var localDraftSaved = false
    @Published var pdf: Data?
    @Published var messageIsWarning = false
    @Published var message = "" { didSet { messageIsWarning = false } }
    @Published var previewMessage = ""
    @Published var busy = false
    @Published var dirty = false
    @Published var generationStatus: GenerationStatus?
    var baseURL: URL?
    var token = ""
    private var previewTask: Task<Void, Never>?
    private var revision = 0
    private var configuredUserID: Int?
    private var accountEpoch: UInt64 = 0
    private struct AccountContext: Equatable { let userID: Int?; let epoch: UInt64 }
    private var accountContext: AccountContext { AccountContext(userID: configuredUserID, epoch: accountEpoch) }
    private var restoringLocalDraft = false
    private let persistenceDirectory: URL?
    private let session: URLSession

    private struct LocalSourceDraft: Codable {
        let source: String
        let sourceType: String
        let storedFileName: String?
        let originalFileName: String?
        let meetingDetails: MinutesMeetingDetails?
        let savedAt: Date
    }

    init(
        session: URLSession = .shared,
        persistenceDirectory: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("Stone Square Sign")
    ) {
        self.session = session
        self.persistenceDirectory = persistenceDirectory
    }

    private func draftURL(for userID: Int) -> URL? {
        persistenceDirectory?.appendingPathComponent("minutes-source-draft-\(userID).json")
    }
    private func storedSourceURL(for userID: Int, extension fileExtension: String) -> URL? {
        let safeExtension = fileExtension.lowercased().filter { $0.isLetter || $0.isNumber }
        return persistenceDirectory?.appendingPathComponent("minutes-source-file-\(userID)\(safeExtension.isEmpty ? "" : ".\(safeExtension)")")
    }
    private func loadLocalSourceDraft(for userID: Int) {
        restoringLocalDraft = true
        defer { restoringLocalDraft = false }
        source = ""; sourceType = "auto"; fileURL = nil; sourceFileName = ""; meetingDetails = MinutesMeetingDetails(); localDraftSaved = false
        guard let url = draftURL(for: userID), let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode(LocalSourceDraft.self, from: data),
              Date().timeIntervalSince(saved.savedAt) < 30 * 86400 else { return }
        source = saved.source
        sourceType = ["auto", "compiled_notes", "transcript"].contains(saved.sourceType) ? saved.sourceType : "auto"
        meetingDetails = saved.meetingDetails ?? MinutesMeetingDetails()
        if let name = saved.storedFileName,
           let stored = persistenceDirectory?.appendingPathComponent(name),
           FileManager.default.fileExists(atPath: stored.path) {
            fileURL = stored
            sourceFileName = saved.originalFileName ?? stored.lastPathComponent
        }
        localDraftSaved = !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || fileURL != nil || meetingDetails.hasValues
    }
    func persistLocalSourceDraft() {
        guard !restoringLocalDraft, let userID = configuredUserID, let url = draftURL(for: userID) else { return }
        let hasSource = !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || fileURL != nil || meetingDetails.hasValues
        guard hasSource else {
            try? FileManager.default.removeItem(at: url)
            localDraftSaved = false
            return
        }
        let storedFileName: String?
        if let fileURL, let persistenceDirectory,
           fileURL.standardizedFileURL.deletingLastPathComponent() == persistenceDirectory.standardizedFileURL {
            storedFileName = fileURL.lastPathComponent
        } else {
            storedFileName = nil
        }
        let saved = LocalSourceDraft(
            source: source,
            sourceType: sourceType,
            storedFileName: storedFileName,
            originalFileName: sourceFileName.isEmpty ? fileURL?.lastPathComponent : sourceFileName,
            meetingDetails: meetingDetails,
            savedAt: Date()
        )
        do {
            let data = try JSONEncoder().encode(saved)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            localDraftSaved = true
        } catch {
            localDraftSaved = false
            message = "This minutes source could not be saved on this Mac. Keep Meeting Minutes open until the draft is created."
        }
    }
    func selectSourceFile(_ externalURL: URL) {
        guard let userID = configuredUserID,
              let destination = storedSourceURL(for: userID, extension: externalURL.pathExtension) else {
            fileURL = externalURL; sourceFileName = externalURL.lastPathComponent; return
        }
        do {
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            for item in (try? FileManager.default.contentsOfDirectory(at: destination.deletingLastPathComponent(), includingPropertiesForKeys: nil)) ?? []
              where item.lastPathComponent.hasPrefix("minutes-source-file-\(userID)") {
                try? FileManager.default.removeItem(at: item)
            }
            try FileManager.default.copyItem(at: externalURL, to: destination)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            sourceFileName = externalURL.lastPathComponent
            fileURL = destination
            persistLocalSourceDraft()
            message = "Source file saved on this Mac until the minutes draft is created."
        } catch {
            message = "The selected source file could not be saved on this Mac. \(error.localizedDescription)"
        }
    }
    func clearLocalSourceDraft() {
        restoringLocalDraft = true
        if let userID = configuredUserID {
            if let url = draftURL(for: userID) { try? FileManager.default.removeItem(at: url) }
            if let directory = persistenceDirectory {
                for item in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
                  where item.lastPathComponent.hasPrefix("minutes-source-file-\(userID)") {
                    try? FileManager.default.removeItem(at: item)
                }
            }
        }
        source = ""; sourceType = "auto"; fileURL = nil; sourceFileName = ""; meetingDetails = MinutesMeetingDetails(); localDraftSaved = false
        restoringLocalDraft = false
    }
    func prepareForDisplay() {
        if selected == nil { message = ""; messageIsWarning = false }
    }

    func configure(_ model: AppModel) {
        let nextURL = URL(string: model.serverAddress.trimmingCharacters(in: .whitespacesAndNewlines))
        let nextToken = model.webSessionToken ?? ""
        let nextUserID = model.user?.id
        let userChanged = configuredUserID != nextUserID
        if userChanged || baseURL != nextURL || token != nextToken {
            accountEpoch &+= 1
            busy = false
        }
        baseURL = nextURL; token = nextToken
        if userChanged {
            generationStatus = nil; message = ""; messageIsWarning = false
            configuredUserID = nextUserID
            if let nextUserID { loadLocalSourceDraft(for: nextUserID) }
            else {
                restoringLocalDraft = true
                source = ""; sourceType = "auto"; fileURL = nil; sourceFileName = ""; meetingDetails = MinutesMeetingDetails(); localDraftSaved = false
                restoringLocalDraft = false
            }
        }
    }
    func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json") async throws -> Data {
        guard let baseURL, let url = URL(string: path, relativeTo: baseURL), !token.isEmpty else { throw ClientError.invalidServer }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body; request.timeoutInterval = 90
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("mac",forHTTPHeaderField:"X-Stone-Square-Client")
        let (data, response) = try await ReliableTransport.perform(session: session, request: request, path: path, token: token)
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 404 && path == "/api/treasury" {
                throw ClientError.serviceUpdateRequired("Treasurer Reports is installed on this Mac. The shared Lodge service must be updated before banking records and reports can be opened here.")
            }
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let reference = object?["incidentReference"] as? String
            let message = [object?["error"] as? String ?? "The request could not be completed. Try again.", reference.map { "Incident \($0)." }].compactMap { $0 }.joined(separator: " ")
            throw ClientError.server(message)
        }
        return data
    }
    func refresh() async {
        let context = accountContext
        await refreshGenerationStatus()
        guard accountContext == context else { return }
        do {
            let result = try await request("/api/minutes")
            guard accountContext == context else { return }
            records = try JSONDecoder().decode(MinutesListPayload.self, from: result).minutes
        } catch { if accountContext == context { message = error.localizedDescription } }
    }
    func openReviewedRecord(id: String) async -> Bool {
        do {
            let loaded = try JSONDecoder().decode(MinutesListPayload.self, from: await request("/api/minutes")).minutes
            records = loaded
            guard let record = loaded.first(where: { $0.id == id }) else {
                message = "The reviewed minutes could not be found. The alert will remain until the record is available."
                return false
            }
            open(record)
            return true
        } catch {
            message = "The reviewed minutes could not be opened. The alert will remain until the record loads successfully."
            return false
        }
    }
    func refreshGenerationStatus() async {
        let context = accountContext
        let status = await GenerationStatus.load(using: self)
        guard accountContext == context else { return }
        generationStatus = status
    }
    func open(_ record: MinutesRecord) {
        previewTask?.cancel(); revision += 1
        selected = record; draft = record.draft; pdf = nil; message = ""; messageIsWarning = false; dirty = false
        Task { await refreshGenerationStatus() }
        updatePreview()
    }
    func close() { previewTask?.cancel(); revision += 1; selected = nil; draft = nil; pdf = nil; dirty = false }
    private func sourceUploadBody(includingMeetingDetails: Bool) throws -> (body: Data, contentType: String) {
        let boundary = "Minutes-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"sourceType\"\r\n\r\n\(sourceType)\r\n")
        if includingMeetingDetails {
            let details = try JSONEncoder().encode(meetingDetails.normalized)
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"meetingDetails\"\r\n\r\n")
            body.append(details); append("\r\n")
        }
        if let fileURL {
            let bytes = try Data(contentsOf: fileURL)
            if bytes.count > 12 * 1024 * 1024 { throw ClientError.server("Choose a file smaller than 12 MB.") }
            let filename = (sourceFileName.isEmpty ? fileURL.lastPathComponent : sourceFileName)
                .replacingOccurrences(of: "\"", with: "")
                .replacingOccurrences(of: "\r", with: "")
                .replacingOccurrences(of: "\n", with: "")
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"transcriptFile\"; filename=\"\(filename)\"\r\nContent-Type: application/octet-stream\r\n\r\n")
            body.append(bytes); append("\r\n")
        } else {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"transcriptText\"\r\n\r\n\(source)\r\n")
        }
        append("--\(boundary)--\r\n")
        return (body, "multipart/form-data; boundary=\(boundary)")
    }
    func generate() async {
        guard meetingDetails.isComplete else { message = meetingDetails.completionMessage; return }
        let context = accountContext
        busy = true; defer { if accountContext == context { busy = false } }
        do {
            let upload = try sourceUploadBody(includingMeetingDetails: true)
            let result = try await request("/api/minutes/generate", method: "POST", body: upload.body, contentType: upload.contentType)
            guard accountContext == context else { return }
            let record = try JSONDecoder().decode(MinutesPayload.self, from: result).minutes
            await refresh()
            guard accountContext == context else { return }
            clearLocalSourceDraft(); open(record)
        } catch { if accountContext == context { message = error.localizedDescription } }
        guard accountContext == context else { return }
        await refreshGenerationStatus()
    }
    func handoff() async {
        let context = accountContext
        busy = true; defer { if accountContext == context { busy = false } }
        do {
            let upload = try sourceUploadBody(includingMeetingDetails: false)
            let data = try await request("/api/minutes/handoff", method: "POST", body: upload.body, contentType: upload.contentType)
            guard accountContext == context else { return }
            let payload = try JSONDecoder().decode(MinutesPayload.self, from: data)
            clearLocalSourceDraft()
            await refresh()
            guard accountContext == context else { return }
            message = (["Transcript sent to Adrian Reese and William McDuffie. It is waiting for one of them to claim it."] + (payload.notificationWarnings ?? [])).joined(separator: " ")
            messageIsWarning = payload.notificationWarnings?.isEmpty == false
        } catch { if accountContext == context { message = error.localizedDescription } }
    }
    func claim(_ record: MinutesRecord, meetingDetails: MinutesMeetingDetails) async {
        guard meetingDetails.isComplete else { message = meetingDetails.completionMessage; return }
        let context = accountContext
        busy = true; defer { if accountContext == context { busy = false } }
        do {
            let data = try await request("/api/minutes/\(record.id)/claim", method: "POST", body: JSONEncoder().encode(MinutesClaimPayload(meetingDetails: meetingDetails.normalized)))
            guard accountContext == context else { return }
            let claimed = try JSONDecoder().decode(MinutesPayload.self, from: data).minutes
            await refresh()
            guard accountContext == context else { return }
            open(claimed)
            message = "This source is assigned to you. Review every section before attesting."
        } catch {
            guard accountContext == context else { return }
            await refresh()
            guard accountContext == context else { return }
            message = error.localizedDescription
        }
    }
    func save() async {
        guard let record = selected, var draft else { return }
        draft.closingFormatVersion = 3
        if record.status == "draft", (draft.officerAttendanceVersion ?? 0) < 2 {
            draft.officerAttendanceVersion = 2
            var review = draft.attendanceReview ?? MinutesAttendanceReview()
            review.officerRoll = false
            draft.attendanceReview = review
        }
        busy = true; defer { busy = false }
        do {
            let body = try JSONEncoder().encode(MinutesSavePayload(draft: draft, expectedUpdatedAt: record.updatedAt))
            let result = try await request("/api/minutes/\(record.id)", method: "PUT", body: body)
            selected = try JSONDecoder().decode(MinutesPayload.self, from: result).minutes
            self.draft = selected?.draft; dirty = false; await refresh(); message = "Corrections saved."
        } catch { message = error.localizedDescription }
    }
    func remove(_ record: MinutesRecord) async {
        busy = true; defer { busy = false }
        do { _ = try await request("/api/minutes/\(record.id)", method: "DELETE"); if selected?.id == record.id { close() }; await refresh(); message = record.status == "awaiting_preparer" ? "Meeting source deleted." : "Draft deleted." }
        catch { message = error.localizedDescription }
    }
    func reorganize() async {
        guard let record = selected, let draft else { return }
        let details = MinutesMeetingDetails(draft: draft)
        guard details.isComplete else { message = details.completionMessage; return }
        let context = accountContext
        busy = true; defer { if accountContext == context { busy = false } }
        do {
            let data = try await request("/api/minutes/\(record.id)/reorganize", method: "POST", body: JSONEncoder().encode(MinutesReorganizePayload(expectedUpdatedAt: record.updatedAt, meetingDetails: details.normalized)))
            guard accountContext == context else { return }
            let replacement = try JSONDecoder().decode(ReorganizedPayload.self, from: data).draft
            guard selected?.id == record.id, selected?.updatedAt == record.updatedAt else { await refreshGenerationStatus(); return }
            self.draft = replacement
            dirty = true; updatePreview(); message = "Reorganized from the original source. Review before saving."
        } catch { if accountContext == context { message = error.localizedDescription } }
        guard accountContext == context else { return }
        await refreshGenerationStatus()
    }
    func action(_ action: String, body: [String: String] = [:]) async {
        guard let record = selected else { return }
        if action == "preparer-attest", let draft {
            let details = MinutesMeetingDetails(draft: draft)
            guard details.isComplete else { message = details.completionMessage; return }
        }
        busy = true; defer { busy = false }
        do {
            let data = try await request("/api/minutes/\(record.id)/\(action)", method: "POST", body: JSONEncoder().encode(body))
            let payload = try JSONDecoder().decode(MinutesPayload.self, from: data)
            await refresh()
            if action == "master-attest" {
                close()
                message = (["You reviewed and signed the minutes. They are now filed under Finalized in Dashboard and available to every Brother with minutes access."] + (payload.notificationWarnings ?? [])).joined(separator: " ")
            } else {
                open(payload.minutes)
                message = (["Record updated."] + (payload.notificationWarnings ?? [])).joined(separator: " ")
            }
            messageIsWarning = payload.notificationWarnings?.isEmpty == false
        } catch { message = error.localizedDescription; messageIsWarning = false }
    }
    func updatePreview() {
        previewTask?.cancel(); revision += 1
        let expected = revision
        guard let draft, let id = selected?.id else { return }
        previewMessage = "Updating preview…"
        previewTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(700))
                let bytes = try await request("/api/minutes/\(id)/preview", method: "POST", body: JSONEncoder().encode(["draft": draft]))
                guard !Task.isCancelled, expected == revision, selected?.id == id else { return }
                pdf = bytes; previewMessage = "Preview matches the current fields."
            } catch { if !Task.isCancelled && expected == revision { previewMessage = error.localizedDescription } }
        }
    }
    func downloadWord() async {
        guard let record = selected else { return }
        do { let data = try await request("/api/minutes/\(record.id)/docx"); saveDocument(data, name: "Meeting Minutes.docx", type: UTType(filenameExtension: "docx") ?? .data) }
        catch { message = error.localizedDescription }
    }
}

@MainActor
func saveDocument(_ data: Data, name: String, type: UTType) {
    let panel = NSSavePanel(); panel.allowedContentTypes = [type]; panel.nameFieldStringValue = name
    if panel.runModal() == .OK, let url = panel.url {
        do { try data.write(to: url, options: .atomic) }
        catch { let alert = NSAlert(); alert.messageText = "The document could not be saved."; alert.informativeText = error.localizedDescription; alert.runModal() }
    }
}
struct LodgeDocumentPreview: NSViewRepresentable {
    let data: Data?
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView(); view.autoScales = true; view.displayMode = .singlePageContinuous
        view.backgroundColor = .windowBackgroundColor; return view
    }
    func updateNSView(_ view: PDFView, context: Context) {
        guard context.coordinator.data != data else { return }
        let page = view.currentPage.flatMap { view.document?.index(for: $0) } ?? 0
        context.coordinator.data = data
        view.document = data.flatMap(PDFDocument.init(data:))
        if let document = view.document, let target = document.page(at: min(page, max(document.pageCount - 1, 0))) { view.go(to: target) }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var data: Data? }
}

struct MeetingMinutesView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @ObservedObject var workspace: MinutesWorkspace
    @State private var deleting: MinutesRecord?
    @State private var confirmReorganize = false
    @State private var confirmClose = false
    @State private var pendingAction: String?
    @State private var approvalDate = ""
    @State private var approvalNote = ""
    @State private var showingHistory = false
    @State private var readonlyRecord: MinutesRecord?
    @State private var deferredRecordsRefresh = false
    @State private var editorPane = 0
    @State private var changingAttendance = false
    @State private var claimingRecord: MinutesRecord?
    @State private var claimMeetingDetails = MinutesMeetingDetails()
    let onExit: () -> Void
    init(workspace: MinutesWorkspace, onExit: @escaping () -> Void = {}) {
        self.workspace = workspace
        self.onExit = onExit
    }
    private var editable: Bool { model.user?.can("minutes.prepare") == true && (workspace.selected?.status == "draft" || (workspace.selected?.status == "awaiting_master_attestation" && model.user?.role == "owner")) }
    private var preparingAttendance: Bool {
        MinutesAttendanceWorkflow.requiresPreparerConfirmation(status: workspace.selected?.status,
            preparerUserID: workspace.selected?.preparerUserId, createdByUserID: workspace.selected?.createdByUserId,
            viewerUserID: model.user?.id)
    }
    private var attendanceReminders: [String] {
        MinutesAttendanceWorkflow.visibleReminders(workspace.draft?.warnings ?? [],
            officers: workspace.draft?.officerAttendance ?? [], preparing: preparingAttendance)
    }
    private func text(_ key: WritableKeyPath<MinutesDraft, String?>) -> Binding<String> {
        Binding(get: { workspace.draft?[keyPath: key] ?? "" }, set: { workspace.draft?[keyPath: key] = $0.isEmpty ? nil : $0 })
    }
    private func names(_ key: WritableKeyPath<MinutesDraft, [String]>) -> Binding<String> {
        Binding(get: { workspace.draft?[keyPath: key].joined(separator: "\n") ?? "" }, set: { workspace.draft?[keyPath: key] = $0.components(separatedBy: "\n").filter { !$0.isEmpty } })
    }
    private func attendanceConfirmation(_ key: WritableKeyPath<MinutesAttendanceReview, Bool>) -> Binding<Bool> {
        Binding(get: { workspace.draft?.attendanceReview?[keyPath: key] ?? false }, set: { value in
            guard preparingAttendance else { return }
            if key == \.officerRoll, workspace.selected?.status == "draft" {
                workspace.draft?.officerAttendanceVersion = 2
            }
            var review = workspace.draft?.attendanceReview ?? MinutesAttendanceReview()
            review[keyPath: key] = value
            workspace.draft?.attendanceReview = review
        })
    }
    private func attendanceNames(_ key: WritableKeyPath<MinutesDraft, [String]>, confirmation: WritableKeyPath<MinutesAttendanceReview, Bool>) -> Binding<String> {
        Binding(get: { workspace.draft?[keyPath: key].joined(separator: "\n") ?? "" }, set: { value in
            workspace.draft?[keyPath: key] = value.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if preparingAttendance {
                var review = workspace.draft?.attendanceReview ?? MinutesAttendanceReview()
                review[keyPath: confirmation] = false
                workspace.draft?.attendanceReview = review
            }
        })
    }
    private func resetOfficerConfirmation() {
        guard preparingAttendance else { return }
        if workspace.selected?.status == "draft" { workspace.draft?.officerAttendanceVersion = 2 }
        var review = workspace.draft?.attendanceReview ?? MinutesAttendanceReview()
        review.officerRoll = false
        workspace.draft?.attendanceReview = review
    }
    private var stationCoverageRequired: Bool {
        workspace.selected?.status == "draft" || (workspace.draft?.officerAttendanceVersion ?? 0) >= 2
    }
    private var meetingDetailsReady: Bool { workspace.draft.map { MinutesMeetingDetails(draft: $0).isComplete } ?? false }
    private var attendanceReady: Bool {
        guard let draft = workspace.draft, let review = draft.attendanceReview else { return false }
        return review.officerRoll && review.otherPresent && review.otherExcused
            && draft.presidingReviewComplete
            && draft.officerAttendance.allSatisfy { $0.reviewComplete(requiringCoverage: stationCoverageRequired) }
            && draft.officerAttendance.allSatisfy { MinutesAttendanceWorkflow.assistantCoverageIssue($0, officers: draft.officerAttendance) == nil }
    }
    private func openRequestedSignedMinutes() {
        guard let id = model.requestedMinutesRecordID,
              let record = workspace.records.first(where: { $0.id == id && ["ready_for_distribution", "distributed", "approved_by_lodge"].contains($0.status) }) else { return }
        readonlyRecord = record
        model.requestedMinutesRecordID = nil
    }
    private var status: String { minutesStatusLabel(workspace.selected?.status ?? "draft") }
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Meeting Minutes", subtitle: workspace.selected == nil ? "Prepare and manage the Lodge meeting record" : status, symbol: "text.document.fill") {
                if workspace.selected != nil {
                    if workspace.dirty { Text("Unsaved changes").font(.caption).foregroundStyle(.secondary) }
                    Button("Exit and keep saved draft") { if workspace.dirty { confirmClose = true } else { workspace.close() } }
                    if editable {
                        Button("Save draft and exit") {
                            Task {
                                if workspace.dirty { await workspace.save() }
                                if !workspace.dirty { workspace.close() }
                            }
                        }.buttonStyle(.borderedProminent)
                    }
                    if editable { Button("Save corrections") { Task { await workspace.save() } }.buttonStyle(.borderedProminent) }
                } else {
                    if !workspace.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || workspace.fileURL != nil || workspace.meetingDetails.hasValues {
                        Button("Save draft and exit") {
                            workspace.persistLocalSourceDraft()
                            if workspace.localDraftSaved { onExit() }
                        }.buttonStyle(.borderedProminent)
                    }
                    Button("Historical minutes") { showingHistory = true }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await workspace.refresh() } }
                }
            }
            if workspace.selected != nil, workspace.draft != nil { editor } else { recordList }
            if !workspace.message.isEmpty {
                Group {
                    if workspace.messageIsWarning { Label(workspace.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    else { Text(workspace.message) }
                }.font(.callout).textSelection(.enabled).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.bar)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .opacity(appeared ? 1 : 0)
        .onAppear { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.24)) { appeared = true } }
        .disabled(workspace.busy)
        .task {
            workspace.configure(model)
            workspace.prepareForDisplay()
            await workspace.refresh()
            openRequestedSignedMinutes()
        }
        .onChange(of: model.requestedMinutesRecordID) { _, _ in openRequestedSignedMinutes() }
        .onChange(of: workspace.selected?.id) { _, _ in changingAttendance = false }
        .onChange(of: model.minutesRecordsRevision) { _, _ in
            if workspace.dirty { deferredRecordsRefresh = true }
            else { Task { await workspace.refresh() } }
        }
        .sheet(isPresented: $showingHistory) { FinalReportBrowserView(kind: .minutes, onClose: { showingHistory = false }).environmentObject(model).frame(minWidth: 620, idealWidth: 900, minHeight: 540, idealHeight: 700) }
        .sheet(item: $claimingRecord) { record in
            VStack(alignment: .leading, spacing: 16) {
                Text("Meeting details before creating minutes").font(.title2.weight(.semibold))
                Text("Enter all eight details for this meeting. The uploaded source remains unchanged.").foregroundStyle(.secondary)
                ScrollView { MinutesMeetingDetailsFields(details: $claimMeetingDetails).padding(2) }
                if !workspace.message.isEmpty { Text(workspace.message).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                HStack {
                    Button("Cancel") { claimingRecord = nil }
                    Spacer()
                    Button("Claim and create draft") {
                        Task {
                            await workspace.claim(record, meetingDetails: claimMeetingDetails)
                            if workspace.selected?.id == record.id { claimingRecord = nil }
                        }
                    }.buttonStyle(.borderedProminent).disabled(!claimMeetingDetails.isComplete || workspace.busy)
                }
            }.padding(22).frame(minWidth: 520, idealWidth: 600, minHeight: 590, idealHeight: 680)
                .interactiveDismissDisabled(workspace.busy)
        }
        .sheet(item: $readonlyRecord) { record in
            FinalReportBrowserView(kind: .minutes, initialSelection: record.id, onClose: { readonlyRecord = nil }).environmentObject(model).frame(minWidth: 620, idealWidth: 900, minHeight: 540, idealHeight: 700)
        }
        .onChange(of: workspace.draft) { old, new in
            guard old != nil, old != new else { return }
            workspace.dirty = new != workspace.selected?.draft; workspace.updatePreview()
        }
        .alert(deleting?.status == "awaiting_preparer" ? "Delete this meeting source?" : "Delete this unsigned draft?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button(deleting?.status == "awaiting_preparer" ? "Delete source" : "Delete draft", role: .destructive) { if let record = deleting { Task { await workspace.remove(record) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(deleting?.status == "awaiting_preparer" ? "It will be removed from the Secretary's Office queue." : "It will be removed from the active records. Signed and approved records cannot be deleted.") }
        .alert("Reorganize the original source?", isPresented: $confirmReorganize) {
            Button("Reorganize") { Task { await workspace.reorganize() } }; Button("Cancel", role: .cancel) {}
        } message: { Text("This replaces the editor contents with a fresh draft. Review it before saving.") }
        .alert("Exit this meeting minutes draft?", isPresented: $confirmClose) {
            Button("Exit and keep saved draft", role: .destructive) {
                workspace.close()
                if deferredRecordsRefresh { deferredRecordsRefresh = false; Task { await workspace.refresh() } }
            }; Button("Keep editing", role: .cancel) {}
        } message: { Text("Only the latest unsaved corrections will be discarded. The uploaded transcript and last saved draft will remain available.") }
        .alert("Confirm record action", isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } })) {
            Button("Continue") { if let action = pendingAction { Task { await workspace.action(action, body: action == "lodge-approval" ? ["approvalDate": approvalDate, "approvalNote": approvalNote] : [:]) } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(pendingAction == "master-attest"
                ? "Your signature will immediately publish the signed PDF to every officer in the Dashboard. Distribution to the Craft remains a separate recorded action."
                : "\(actionLabel(pendingAction ?? ""))? Review the saved document before continuing.")
        }
    }
    private var recordList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let newest = workspace.records.first(where: { ["ready_for_distribution", "distributed", "approved_by_lodge"].contains($0.status) }) {
                    AdaptiveControlBar {
                        HStack(spacing: 16) { signedMinutesNotice(newest); Spacer(); signedMinutesButton }
                    } compact: {
                        VStack(alignment: .leading, spacing: 12) { signedMinutesNotice(newest); signedMinutesButton }
                    }
                    .padding(16)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(SignTheme.gold.opacity(0.7), lineWidth: 1))
                }
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("New transcript or meeting notes").font(.headline)
                        Text(model.user?.role == "owner"
                             ? "Upload the source for Adrian Reese or William McDuffie to claim, or create the draft yourself."
                             : "Use compiled meeting notes or a corrected transcript. Attendance and agenda sections are organized for your review.").foregroundStyle(.secondary)
                        GroupBox("Meeting details for the draft") {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(model.user?.role == "owner"
                                     ? "Complete all eight details to create your own draft. Sending source notes to the Secretaries sends only the source, without these details."
                                     : "Enter all eight details. Your entries carry into the draft and preview.")
                                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                MinutesMeetingDetailsFields(details: $workspace.meetingDetails)
                            }.padding(10)
                        }
                        GenerationStatusView(status: workspace.generationStatus)
                        Picker("Source format", selection: $workspace.sourceType) {
                            Text("Detect automatically").tag("auto"); Text("Compiled meeting notes").tag("compiled_notes"); Text("Meeting transcript").tag("transcript")
                        }.frame(maxWidth: 380)
                        TextEditor(text: $workspace.source).font(.body).frame(minHeight: 150).padding(5).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                        if workspace.localDraftSaved {
                            Label("Source and meeting details are saved privately on this Mac. Entered details apply when you create the draft.", systemImage: "checkmark.circle.fill")
                                .font(.caption).foregroundStyle(.green)
                        }
                        AdaptiveControlBar {
                            HStack { sourceFileControls; Spacer(); if model.user?.role == "owner" { handoffMinutesButton }; createMinutesButton }
                        } compact: {
                            VStack(alignment: .leading, spacing: 10) { sourceFileControls; if model.user?.role == "owner" { handoffMinutesButton }; createMinutesButton }
                        }
                    }.padding(14)
                }
                let activeRecords = workspace.records.filter { !["ready_for_distribution", "distributed", "approved_by_lodge"].contains($0.status) }
                Text("Active drafts and reviews").font(.title3.weight(.semibold))
                if activeRecords.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "doc.text").font(.system(size: 38)).foregroundStyle(.tertiary)
                        Text("No active minutes").font(.title3.weight(.semibold))
                        Text("Signed minutes are filed under Finalized in Dashboard.").font(.callout).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 26)
                }
                ForEach(activeRecords) { record in
                    AdaptiveControlBar {
                        HStack(spacing: 14) { recordSummary(record); Spacer(); recordActions(record) }
                    } compact: {
                        VStack(alignment: .leading, spacing: 12) { recordSummary(record); recordActions(record) }
                    }
                    .padding(16).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
                }
            }.padding(22)
        }
    }
    private func signedMinutesNotice(_ record: MinutesRecord) -> some View {
        HStack(spacing: 16) {
            Image(systemName: "checkmark.seal.fill").font(.title2).foregroundStyle(SignTheme.gold)
            VStack(alignment: .leading, spacing: 4) {
                Text(["owner", "secretary", "assistant_secretary"].contains(model.user?.role ?? "") && record.status == "ready_for_distribution"
                     ? "WM review complete, ready to send to the Craft"
                     : "Meeting minutes are available to view").font(.headline).foregroundStyle(SignTheme.navy)
                Text("\(MinutesDateText.minutesTitle(record.draft.meetingDate)) is signed and filed under Finalized in Dashboard.").font(.callout).foregroundStyle(.secondary)
            }
        }
    }
    private var signedMinutesButton: some View {
        Button("View signed minutes") { showingHistory = true }.buttonStyle(.borderedProminent)
    }
    private var sourceFileControls: some View {
        HStack {
            Button("Choose file…", systemImage: "doc.badge.plus") {
                let panel = NSOpenPanel(); panel.allowedContentTypes = [.plainText, .pdf, UTType(filenameExtension: "docx") ?? .data]; panel.allowsMultipleSelection = false
                if panel.runModal() == .OK, let url = panel.url { workspace.selectSourceFile(url) }
            }
            if let file = workspace.fileURL { Text(workspace.sourceFileName.isEmpty ? file.lastPathComponent : workspace.sourceFileName).lineLimit(1); Button("Remove file") { workspace.sourceFileName = ""; workspace.fileURL = nil } }
        }
    }
    private var createMinutesButton: some View {
        Button("Create draft minutes") { Task { await workspace.generate() } }.buttonStyle(.borderedProminent).disabled(!workspace.meetingDetails.isComplete || (workspace.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && workspace.fileURL == nil))
    }
    private var handoffMinutesButton: some View {
        Button("Send to Adrian and McDuffie") { Task { await workspace.handoff() } }
            .disabled(workspace.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && workspace.fileURL == nil)
    }
    private func mayReview(_ record: MinutesRecord) -> Bool {
        model.user?.role == "owner" || record.preparerUserId == model.user?.id || (record.preparerUserId == nil && record.createdByUserId == model.user?.id)
    }
    private func mayDelete(_ record: MinutesRecord) -> Bool {
        guard ["awaiting_preparer", "draft"].contains(record.status) else { return false }
        return model.user?.role == "owner" || record.preparerUserId == model.user?.id || (record.preparerUserId == nil && record.createdByUserId == model.user?.id)
    }
    @ViewBuilder private func recordSummary(_ record: MinutesRecord) -> some View {
        HStack(spacing: 14) {
            Image(systemName: record.status == "awaiting_preparer" ? "tray.and.arrow.down.fill" : "doc.text").font(.title2).foregroundStyle(SignTheme.navy)
            VStack(alignment: .leading, spacing: 5) {
                Text(record.status == "awaiting_preparer" ? "Meeting source awaiting a preparer" : MinutesDateText.minutesTitle(record.draft.meetingDate)).font(.headline)
                if record.status == "awaiting_preparer" {
                    Text("Uploaded by \(record.sourceUploadedBy ?? record.createdBy). Adrian Reese or William McDuffie may claim it.").font(.caption).foregroundStyle(.secondary)
                } else if record.status == "organizing" {
                    Text("Claimed by \(record.preparer ?? record.createdBy). The organized draft is being created.").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Prepared by \(record.preparer ?? record.createdBy)").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    @ViewBuilder private func recordActions(_ record: MinutesRecord) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { recordActionControls(record) }
            VStack(alignment: .leading, spacing: 8) { recordActionControls(record) }
        }
    }
    @ViewBuilder private func recordActionControls(_ record: MinutesRecord) -> some View {
        Text(minutesStatusLabel(record.status)).font(.caption).foregroundStyle(.secondary)
        if record.status == "awaiting_preparer", ["secretary", "assistant_secretary"].contains(model.user?.role ?? "") {
            Button("Enter meeting details") {
                claimMeetingDetails = MinutesMeetingDetails()
                workspace.message = ""
                claimingRecord = record
            }.buttonStyle(.borderedProminent)
        } else if !["awaiting_preparer", "organizing"].contains(record.status) {
            Button(mayReview(record) ? "Review" : "View PDF") {
                if mayReview(record) { workspace.open(record) } else { readonlyRecord = record }
            }
        }
        if mayDelete(record) { Button("Delete", role: .destructive) { deleting = record } }
    }
    private var editor: some View {
        AdaptiveWorkspaceSplit(primaryTitle: "Minutes entries", secondaryTitle: "Document preview", compactPane: $editorPane) {
            Form {
                Section {
                    GenerationStatusView(status: workspace.generationStatus)
                    HStack {
                        Text(workspace.draft?.sourceType == "compiled_notes" ? "Compiled meeting notes" : "Meeting transcript").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Spacer()
                        if workspace.selected?.status == "draft" { Button("Reorganize source") { confirmReorganize = true } }
                    }
                    if !attendanceReminders.isEmpty {
                        DisclosureGroup("Review reminders") { ForEach(attendanceReminders, id: \.self) { Text($0).font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 3) } }
                    }
                    if let changes = workspace.selected?.masterChanges, !changes.isEmpty {
                        GroupBox("Worshipful Master's corrections") {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(changes, id: \.self) { change in
                                    DisclosureGroup(change.field) {
                                        VStack(alignment: .leading, spacing: 8) {
                                            Text("Submitted").font(.caption.weight(.semibold))
                                            Text(change.before.isEmpty ? "(blank)" : change.before).textSelection(.enabled)
                                            Divider()
                                            Text("Reviewed").font(.caption.weight(.semibold))
                                            Text(change.after.isEmpty ? "(removed)" : change.after).textSelection(.enabled)
                                        }.font(.callout).padding(8)
                                    }
                                }
                            }.padding(10)
                        }
                    }
                    metadata.disabled(!editable)
                    attendance
                    ForEach(workspace.draft?.sections.indices ?? 0..<0, id: \.self) { i in
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Section heading", text: Binding(get: { workspace.draft?.sections[i].heading ?? "" }, set: { workspace.draft?.sections[i].heading = $0 })).font(.headline)
                            TextEditor(text: Binding(get: { workspace.draft?.sections[i].body ?? "" }, set: { workspace.draft?.sections[i].body = $0 })).font(.body).frame(minHeight: 160).padding(6)
                            if editable { Button("Remove section", role: .destructive) { workspace.draft?.sections.remove(at: i) }.font(.caption) }
                        }.padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8)).disabled(!editable)
                    }
                    if editable { Button("Add section") { workspace.draft?.sections.append(MinutesSection(heading: "Meeting Business", body: "")) } }
                    if !(workspace.draft?.sensitiveReview.isEmpty ?? true) {
                        DisclosureGroup("Private officer review") { ForEach(workspace.draft?.sensitiveReview ?? [], id: \.self) { Text($0).font(.caption) } }
                    }
                    workflow
                }
            }.formStyle(.grouped)
        } secondary: {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Text("Document preview").font(.headline); Spacer(); Button("Save PDF") { if let pdf = workspace.pdf { saveDocument(pdf, name: "Meeting Minutes.pdf", type: .pdf) } }.disabled(workspace.pdf == nil || workspace.previewMessage != "Preview matches the current fields.") }
                Text(workspace.previewMessage).font(.caption).foregroundStyle(.secondary)
                LodgeDocumentPreview(data: workspace.pdf)
            }.padding(14)
        }
    }
    @ViewBuilder private var attendance: some View {
        if preparingAttendance {
            GroupBox("Required attendance review") {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Required before submission", systemImage: attendanceReady ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                        .font(.caption.weight(.bold)).foregroundStyle(attendanceReady ? Color.green : SignTheme.gold)
                    Text("Confirm every officer's attendance and both other-Brother lists. For an excused, absent or late-arriving officer, record who covered the station or confirm that it remained vacant.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    attendanceFields
                }.padding(10)
            }.disabled(!editable)
        } else {
            GroupBox("Recorded attendance") {
                VStack(alignment: .leading, spacing: 14) {
                    if workspace.selected?.status == "draft" {
                        Text("The Secretary's Office is completing attendance. You can look over the recorded entries and make a correction if needed.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("Recorded by \(workspace.selected?.preparer ?? workspace.selected?.createdBy ?? "the preparing officer"). You do not need to confirm attendance again.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    attendanceSummary
                    if editable {
                        DisclosureGroup("Change attendance", isExpanded: $changingAttendance) {
                            attendanceFields.padding(.top, 10)
                        }
                    }
                }.padding(10)
            }
        }
    }
    private var attendanceFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Officers present, excused, absent or arriving late").font(.headline).foregroundStyle(SignTheme.navy)
            ForEach(workspace.draft?.officerAttendance.indices ?? 0..<0, id: \.self) { i in officerAttendanceEditor(i) }
            if preparingAttendance {
                Toggle("I reviewed the complete officer roll, including station coverage and late arrivals.", isOn: attendanceConfirmation(\.officerRoll))
            }
            Divider()
            namesEditor("Other Brothers present", binding: attendanceNames(\.present, confirmation: \.otherPresent))
            if preparingAttendance {
                Toggle("I confirmed this list, including if no other Brothers were present.", isOn: attendanceConfirmation(\.otherPresent))
            }
            namesEditor("Other Brothers excused", binding: attendanceNames(\.excused, confirmation: \.otherExcused))
            if preparingAttendance {
                Toggle("I confirmed this list, including if no other Brothers were excused.", isOn: attendanceConfirmation(\.otherExcused))
            }
            Divider()
            namesEditor("Visitors, if any", binding: names(\.visitors))
            if editable {
                Button("Add officer or pro tem") {
                    workspace.draft?.officerAttendance.append(MinutesAttendance(name: "", title: "", status: "not_recorded"))
                    resetOfficerConfirmation()
                }
            }
        }
    }
    private var attendanceSummary: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(workspace.draft?.officerAttendance.indices ?? 0..<0, id: \.self) { i in
                if let row = workspace.draft?.officerAttendance[i] {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .top, spacing: 14) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(row.title.isEmpty ? "Officer" : row.title).font(.caption).foregroundStyle(.secondary)
                                Text(row.name.isEmpty ? "Name not recorded" : row.name).font(.body.weight(.medium))
                            }
                            Spacer(minLength: 8)
                            Text(MinutesAttendanceWorkflow.statusLabel(row.status, preparing: false))
                                .font(.callout.weight(.semibold)).foregroundStyle(SignTheme.navy)
                        }
                        if let coverage = MinutesAttendanceWorkflow.coverageSummary(row) {
                            Text(coverage).font(.caption).foregroundStyle(.secondary)
                        }
                    }.fixedSize(horizontal: false, vertical: true)
                }
            }
            Divider()
            attendanceSummaryNames("Other Brothers present", values: workspace.draft?.present ?? [])
            attendanceSummaryNames("Other Brothers excused", values: workspace.draft?.excused ?? [])
            attendanceSummaryNames("Visitors", values: workspace.draft?.visitors ?? [])
        }
    }
    private func attendanceSummaryNames(_ label: String, values: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(values.isEmpty ? "None listed." : values.joined(separator: ", "))
                .font(.callout).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func officerText(_ index: Int, key: WritableKeyPath<MinutesAttendance, String>) -> Binding<String> {
        Binding(get: { workspace.draft?.officerAttendance[index][keyPath: key] ?? "" }, set: { value in
            workspace.draft?.officerAttendance[index][keyPath: key] = value
            resetOfficerConfirmation()
        })
    }
    @ViewBuilder private func officerAttendanceEditor(_ index: Int) -> some View {
        if let row = workspace.draft?.officerAttendance[index] {
            VStack(alignment: .leading, spacing: 10) {
                Text(row.title.isEmpty ? "Officer or acting officer" : row.title)
                    .font(.subheadline.weight(.semibold)).foregroundStyle(SignTheme.navy)
                    .fixedSize(horizontal: false, vertical: true)
                TextField("Officer name", text: officerText(index, key: \.name))
                    .accessibilityLabel("Officer name for \(row.title)")
                TextField("Office", text: officerText(index, key: \.title))
                    .font(.caption)
                Picker("Attendance", selection: Binding(get: { workspace.draft?.officerAttendance[index].status ?? "not_recorded" }, set: { value in
                    workspace.draft?.officerAttendance[index].setStatus(value)
                    resetOfficerConfirmation()
                })) {
                    Text(MinutesAttendanceWorkflow.statusLabel("not_recorded", preparing: preparingAttendance)).tag("not_recorded")
                    Text("Present").tag("present")
                    Text("Excused").tag("excused")
                    Text("Absent").tag("absent")
                    Text("Arrived later").tag("arrived_late")
                }.frame(maxWidth: .infinity, alignment: .leading)
                if (row.requiresStationCoverage && stationCoverageRequired) || row.hasStationCoverageValues {
                    if !row.requiresStationCoverage && row.hasStationCoverageValues {
                        Text("This attendance status conflicts with the station coverage. Confirm a later arrival, or clear the coverage below.")
                            .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        Button("Clear conflicting coverage") {
                            workspace.draft?.officerAttendance[index].setCoverage(nil)
                            resetOfficerConfirmation()
                        }
                    }
                    stationCoverageEditor(index, row: row)
                }
            }
            .textFieldStyle(.roundedBorder)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        }
    }
    private func assistantCoverage(for row: MinutesAttendance) -> (role: String, name: String)? {
        guard let role = row.assistantRole else { return nil }
        let candidates = (workspace.draft?.officerAttendance ?? []).filter {
            $0.title.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare(role) == .orderedSame
        }
        guard candidates.count == 1, let assistant = candidates.first,
              !assistant.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return (role, assistant.name)
    }
    private func stationCoverageEditor(_ index: Int, row: MinutesAttendance) -> some View {
        let assistant = assistantCoverage(for: row)
        return VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text("Station coverage").font(.caption.weight(.semibold))
            if let issue = MinutesAttendanceWorkflow.assistantCoverageIssue(row, officers: workspace.draft?.officerAttendance ?? []) {
                Text(issue).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            Picker("Who covered the station?", selection: Binding(get: {
                let current = workspace.draft?.officerAttendance[index]
                return current?.actingRole == row.assistantRole && current?.actingRole != nil ? "assistant" : (current?.stationCoverage ?? "")
            }, set: { value in
                if value == "assistant", let assistant {
                    workspace.draft?.officerAttendance[index].selectAssistant(role: assistant.role, name: assistant.name)
                } else {
                    workspace.draft?.officerAttendance[index].setCoverage(value.isEmpty ? nil : value)
                    workspace.draft?.officerAttendance[index].actingRole = nil
                }
                resetOfficerConfirmation()
            })) {
                Text("Choose coverage").tag("")
                if let role = row.assistantRole {
                    Text("The \(role) covered the station").tag("assistant").disabled(assistant == nil)
                }
                Text("Another Brother served").tag("filled")
                Text("Station remained vacant").tag("vacant")
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let role = row.assistantRole, assistant == nil {
                Text("Record the \(role)'s name in the officer roll to select that assistant, or enter another covering Brother.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if row.stationCoverage == "filled" {
                if let role = row.actingRole, role == row.assistantRole {
                    Text("\(role): \(row.actingName ?? "Name not recorded")")
                        .font(.callout).fixedSize(horizontal: false, vertical: true)
                } else {
                    TextField("Brother who filled the station", text: Binding(get: { workspace.draft?.officerAttendance[index].actingName ?? "" }, set: { value in
                        workspace.draft?.officerAttendance[index].actingName = value.isEmpty ? nil : value
                        workspace.draft?.officerAttendance[index].actingRole = nil
                        resetOfficerConfirmation()
                    }))
                }
                Text("Did that Brother serve for the whole meeting?").font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                Picker("Whole meeting", selection: Binding(get: { workspace.draft?.officerAttendance[index].actingWholeMeeting.map { $0 ? "yes" : "no" } ?? "" }, set: { value in
                    workspace.draft?.officerAttendance[index].setWholeMeeting(value.isEmpty ? nil : value == "yes")
                    resetOfficerConfirmation()
                })) {
                    Text("Choose an answer").tag("")
                    Text("Yes, the whole meeting").tag("yes")
                    Text("No, the regular officer arrived").tag("no")
                }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                Text("Selecting No records that the regular officer arrived and took the station.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private var metadata: some View {
        GroupBox("Meeting details") {
            VStack(alignment: .leading, spacing: 12) {
                MinutesDateField(title: "Meeting date", value: text(\.meetingDate), preservingDetails: false)
                Picker("Meeting type", selection: Binding(get: { workspace.draft?.meetingType == "Stated Communication" ? "Stated Communication" : "Other" }, set: { workspace.draft?.meetingType = $0 == "Other" ? "" : $0 })) {
                    Text("Stated Communication").tag("Stated Communication"); Text("Other").tag("Other")
                }
                if workspace.draft?.meetingType != "Stated Communication" { TextField("Type the meeting name", text: Binding(get: { workspace.draft?.meetingType ?? "" }, set: { workspace.draft?.meetingType = $0 })) }
                Picker("Degree", selection: text(\.degree)) {
                    Text("Needs review").tag("")
                    ForEach(["First Degree", "Second Degree", "Third Degree", "Round Table"], id: \.self) { Text($0).tag($0) }
                }
                HStack { TextField("Opening time", text: text(\.openingTime)); TextField("Closing time", text: text(\.closingTime)) }
                Text("Enter both actual times, including AM or PM, before submission. Explicit 24-hour times such as 19:30 are also accepted.").font(.caption).foregroundStyle(.secondary)
                TextField("Presiding officer", text: text(\.presiding))
                Picker("Quorum", selection: text(\.quorum)) { Text("Needs review").tag(""); Text("Yes").tag("Yes"); Text("No").tag("No") }
                MinutesDateField(title: "Next meeting date", value: text(\.nextMeeting), preservingDetails: true)
                Divider()
                Text("Prayer and closing").font(.headline).foregroundStyle(SignTheme.navy)
                Text("Confirm the Chaplain's closing prayer for this meeting. The closing section uses the closing time above.").font(.caption).foregroundStyle(.secondary)
                prayerPicker("Chaplain gave the closing prayer", key: \.closingPrayerGiven)
                if preparingAttendance && !meetingDetailsReady, let draft = workspace.draft {
                    Text(MinutesMeetingDetails(draft: draft).completionMessage).font(.caption).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.textFieldStyle(.roundedBorder).padding(10)
        }
    }
    private func prayerPicker(_ label: String, key: WritableKeyPath<MinutesDraft, Bool?>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption)
            Picker(label, selection: Binding(get: { workspace.draft?[keyPath: key].map { $0 ? "yes" : "no" } ?? "" }, set: { workspace.draft?[keyPath: key] = $0.isEmpty ? nil : $0 == "yes" })) {
                Text("Needs confirmation").tag(""); Text("Yes").tag("yes"); Text("No").tag("no")
            }.labelsHidden()
        }
    }
    private func namesEditor(_ label: String, binding: Binding<String>) -> some View {
        VStack(alignment: .leading) { Text(label).font(.subheadline.weight(.medium)); TextEditor(text: binding).font(.body).frame(height: 65).padding(4) }
    }
    private func actionLabel(_ action: String) -> String {
        ["preparer-attest": "Attest and send to the Worshipful Master", "master-attest": "Review, sign and publish to officers", "mark-distributed": "Record distribution", "reopen": "Reopen for corrections", "lodge-approval": "Record formal Lodge approval"][action] ?? action
    }
    private var workflow: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Record actions").font(.headline)
            Button("Download saved Word record") { Task { await workspace.downloadWord() } }.disabled(workspace.dirty)
            if let record = workspace.selected {
                if preparingAttendance && model.user?.can("minutes.prepare") == true {
                    Button(actionLabel("preparer-attest")) { pendingAction = "preparer-attest" }.disabled(workspace.dirty || !attendanceReady || !meetingDetailsReady)
                }
                if model.user?.role == "owner" && record.status == "awaiting_master_attestation" {
                    Button(actionLabel("master-attest")) { pendingAction = "master-attest" }.disabled(workspace.dirty)
                }
                if ["owner", "secretary", "assistant_secretary"].contains(model.user?.role ?? "") && record.status == "ready_for_distribution" {
                    Button(actionLabel("mark-distributed")) { pendingAction = "mark-distributed" }
                }
                if model.user?.role == "owner" && !["draft", "approved_by_lodge"].contains(record.status) { Button(actionLabel("reopen")) { pendingAction = "reopen" } }
                if ["owner", "secretary", "assistant_secretary"].contains(model.user?.role ?? "") && ["ready_for_distribution", "distributed"].contains(record.status) {
                    TextField("Lodge approval date (YYYY-MM-DD)", text: $approvalDate)
                    TextField("Corrections adopted, if any", text: $approvalNote)
                    Button(actionLabel("lodge-approval")) { pendingAction = "lodge-approval" }.disabled(approvalDate.isEmpty)
                }
            }
        }.buttonStyle(.bordered)
    }
}

private struct MinutesMeetingDetailsFields: View {
    @Binding var details: MinutesMeetingDetails
    @State private var enteringOtherType = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            MinutesDateField(title: "Meeting date", value: $details.meetingDate, preservingDetails: false)
            Picker("Meeting type", selection: Binding(get: {
                if enteringOtherType || (!details.meetingType.isEmpty && details.meetingType != "Stated Communication") { return "Other" }
                return details.meetingType
            }, set: { value in
                enteringOtherType = value == "Other"
                details.meetingType = value == "Stated Communication" ? value : ""
            })) {
                Text("Choose meeting type").tag("")
                Text("Stated Communication").tag("Stated Communication")
                Text("Other").tag("Other")
            }
            if enteringOtherType || (!details.meetingType.isEmpty && details.meetingType != "Stated Communication") {
                TextField("Type the meeting name", text: $details.meetingType)
            }
            Picker("Degree", selection: $details.degree) {
                Text("Choose degree").tag("")
                ForEach(["First Degree", "Second Degree", "Third Degree", "Round Table"], id: \.self) { Text($0).tag($0) }
            }
            HStack {
                TextField("Opening time", text: $details.openingTime)
                TextField("Closing time", text: $details.closingTime)
            }
            Text("Use actual times with AM or PM, such as 7:30 PM. Explicit 24-hour times such as 19:30 are also accepted.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("Presiding officer", text: $details.presiding)
            Picker("Quorum", selection: $details.quorum) {
                Text("Choose quorum").tag(""); Text("Yes").tag("Yes"); Text("No").tag("No")
            }
            MinutesDateField(title: "Next meeting date", value: $details.nextMeeting, preservingDetails: false)
        }.textFieldStyle(.roundedBorder)
    }
}

private struct MinutesDateField: View {
    let title: String
    @Binding var value: String
    let preservingDetails: Bool
    @State private var choosingDate = false
    @State private var pendingDate = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption)
            HStack {
                TextField("Weekday, Month day, year", text: Binding(
                    get: { MinutesDateText.display(value) },
                    set: { value = $0 }
                ))
                .labelsHidden()
                .accessibilityLabel(title)
                Button {
                    pendingDate = MinutesDateText.match(value)?.date ?? Date()
                    choosingDate = true
                } label: { Image(systemName: "calendar") }
                    .accessibilityLabel("Choose \(title.lowercased())")
                    .help("Choose \(title.lowercased())")
                    .popover(isPresented: $choosingDate) {
                        VStack(alignment: .leading, spacing: 14) {
                            Text(title).font(.headline)
                            DatePicker("Date", selection: $pendingDate, displayedComponents: .date)
                                .datePickerStyle(.graphical)
                                .environment(\.calendar, MinutesDateText.calendar)
                                .environment(\.timeZone, MinutesDateText.calendar.timeZone)
                            HStack {
                                Button("Cancel") { choosingDate = false }
                                Spacer()
                                Button("Use date") {
                                    value = MinutesDateText.replacingDate(in: value, with: pendingDate, preservingDetails: preservingDetails)
                                    choosingDate = false
                                }.buttonStyle(.borderedProminent)
                            }
                        }.padding(18).frame(width: 310)
                    }
            }
        }
    }
}
