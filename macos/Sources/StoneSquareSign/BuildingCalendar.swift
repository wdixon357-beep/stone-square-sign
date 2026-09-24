import SwiftUI
import Foundation

// Revisions may be an opaque portal token or a numeric sequence. Preserve their wire type.
enum BuildingRevision: Codable, Equatable {
    case text(String), number(Int)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let number = try? value.decode(Int.self) { self = .number(number) }
        else { self = .text(try value.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self { case .text(let text): try value.encode(text); case .number(let number): try value.encode(number) }
    }
}
struct BuildingRequest: Decodable, Identifiable {
    let id: String; let organization: String; let contactName: String; let contact: String
    let date: String; let start: String?; let end: String?; let spaces: [String]
    let bathroomAccess: Bool?
    let description: String; let status: String; let note: String?
    let decidedAt: String?; let decidedBy: String?; let revision: BuildingRevision
    let requesterNotified: Bool
    let ownerOnly: Bool?; let agreementStatus: String?; let agreementText: String?; let coordinator: BuildingCoordinator?
    let attestationRoles: [String]?; let attestedBy: BuildingAttestedBy?
    let statusOnly: Bool?
    let filedCompletedAt: String?; let filedCompletedBy: String?
    var eligibleAttestationRoles: [String] { attestationRoles ?? ["secretary"] }
    func mayAttest(role: String?) -> Bool { role.map { ["secretary", "assistant_secretary"].contains($0) && eligibleAttestationRoles.contains($0) } ?? false }
    var statusLabel: String {
        if filedCompletedAt != nil { return "Filed as completed" }
        if agreementStatus == "awaiting_secretary_attestation" {
            return eligibleAttestationRoles.contains("assistant_secretary")
                ? "Awaiting Secretary or Assistant Secretary attestation"
                : "Awaiting Secretary attestation"
        }
        if agreementStatus == "fully_executed" { return "Agreement complete" }
        return ["pending": "Pending", "approved": "Approved", "denied": "Declined"][status] ?? status.capitalized
    }
}
struct BuildingCoordinator: Decodable { let name: String; let title: String?; let email: String }
struct BuildingAttestedBy: Decodable { let name: String; let title: String; let at: String }
struct BuildingRequestsResponse: Decodable { let requests: [BuildingRequest]; let canDecide: Bool }
struct BuildingAuthorization: Encodable { let date: String; let record: String; let fee: String; let insurance: String; let conditions: String }
private struct BuildingDecisionBody: Encodable { let decision: String; let note: String; let revision: BuildingRevision; let authorization: BuildingAuthorization? }
private struct BuildingAttestationBody: Encodable { let revision: BuildingRevision }
private struct BuildingFileCompletedBody: Encodable { let revision: BuildingRevision }
private struct BuildingDecisionResponse: Decodable { let request: BuildingRequest }

@MainActor final class BuildingRequestsWorkspace: ObservableObject {
    @Published var requests: [BuildingRequest] = []
    @Published var canDecide = false
    @Published var busy = false
    @Published var messageIsWarning = false
    @Published var message = "" { didSet { messageIsWarning = false } }
    @discardableResult func load(using model: AppModel) async -> Bool {
        guard model.user?.can("building.view") == true else { requests = []; canDecide = false; return false }
        busy = true; defer { busy = false }
        do {
            let result: BuildingRequestsResponse = try await model.request("/api/building/requests")
            requests = result.requests; canDecide = result.canDecide; message = ""
            return true
        } catch { message = error.localizedDescription; return false }
    }
    func decide(_ request: BuildingRequest, decision: String, note: String, authorization: BuildingAuthorization? = nil, using model: AppModel) async -> Bool {
        guard !busy, canDecide, model.user?.can("building.decide") == true, request.status == "pending",
              ["approved", "denied"].contains(decision), note.count <= 3000, requests.first(where: { $0.id == request.id })?.revision == request.revision else { return false }
        busy = true; defer { busy = false }
        do {
            let body = try JSONEncoder().encode(BuildingDecisionBody(decision: decision, note: note, revision: request.revision, authorization: authorization))
            let result: BuildingDecisionResponse = try await model.request("/api/building/requests/\(routeID(request.id))/decision", method: "POST", body: body)
            if let index = requests.firstIndex(where: { $0.id == result.request.id }) { requests[index] = result.request }
            message = result.request.requesterNotified ? "Decision recorded and requester notified." : "Decision recorded. The requester notification has not been confirmed."
            messageIsWarning = !result.request.requesterNotified
            await model.refreshBuildingAlerts()
            return true
        } catch ClientError.conflict {
            let refreshed = await load(using: model)
            message = refreshed ? "This request changed. Review the latest details before deciding again." : "This request changed. Refresh it before deciding again."
            return false
        } catch { message = error.localizedDescription; return false }
    }
    func attest(_ request: BuildingRequest, using model: AppModel) async -> Bool {
        guard !busy, request.mayAttest(role: model.user?.role), request.status == "approved", request.agreementStatus == "awaiting_secretary_attestation",
              requests.first(where: { $0.id == request.id })?.revision == request.revision else { return false }
        busy = true; defer { busy = false }
        do {
            let body = try JSONEncoder().encode(BuildingAttestationBody(revision: request.revision))
            let result: BuildingDecisionResponse = try await model.request("/api/building/requests/\(routeID(request.id))/attest", method: "POST", body: body)
            if let index = requests.firstIndex(where: { $0.id == result.request.id }) { requests[index] = result.request }
            message = result.request.requesterNotified
                ? "Attestation recorded. The organization was notified and payment access is available."
                : "Attestation recorded. The organization's notification has not been confirmed."
            messageIsWarning = !result.request.requesterNotified
            await model.refreshBuildingAlerts()
            return true
        } catch ClientError.conflict {
            _ = await load(using: model); message = "This agreement changed. Review the current agreement before attesting again."; return false
        } catch { message = error.localizedDescription; return false }
    }
    func fileCompleted(_ request: BuildingRequest, using model: AppModel) async -> Bool {
        guard !busy, model.user?.role == "owner", request.status == "approved",
              request.agreementStatus == "fully_executed", request.filedCompletedAt == nil,
              requests.first(where: { $0.id == request.id })?.revision == request.revision else { return false }
        busy = true; defer { busy = false }
        do {
            let body = try JSONEncoder().encode(BuildingFileCompletedBody(revision: request.revision))
            let result: BuildingDecisionResponse = try await model.request("/api/building/requests/\(routeID(request.id))/file-completed", method: "POST", body: body)
            if let index = requests.firstIndex(where: { $0.id == result.request.id }) { requests[index] = result.request }
            message = "Agreement filed as completed."
            await model.refreshBuildingAlerts()
            return true
        } catch ClientError.conflict {
            _ = await load(using: model)
            message = "This agreement changed. Review the current record before filing again."
            return false
        } catch { message = error.localizedDescription; return false }
    }
}

struct BuildingRequestsView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var workspace = BuildingRequestsWorkspace()
    @StateObject private var newRequest = NewBuildingRequestWorkspace()
    @State private var showingNewRequest = false
    @State private var selectedID: String?
    @State private var filter = "all"
    @State private var note = ""
    @State private var decision: String?
    @State private var authorizationDate = Date()
    @State private var authorizationRecord = ""
    @State private var approvedFee = ""
    @State private var insuranceDecision = ""
    @State private var authorizationConditions = ""
    @State private var attestationPending = false
    @State private var filingPending = false
    @State private var requestPane = 0
    private var selected: BuildingRequest? { workspace.requests.first { $0.id == selectedID } }
    private var visible: [BuildingRequest] { workspace.requests.filter { filter == "all" || $0.status == filter } }
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Building Requests", subtitle: "Requests to use the Lodge building", symbol: "building.2") {
                if model.user?.can("building.view") == true { Button("Refresh") { Task { await workspace.load(using: model) } }.disabled(workspace.busy) }
                if model.user?.can("building.request") == true { Button("New Building Request") { showingNewRequest = true }.buttonStyle(.borderedProminent) }
            }
            if model.user?.can("building.view") == true { AdaptiveWorkspaceSplit(primaryTitle: "Requests", secondaryTitle: "Request details", compactPane: $requestPane) {
                VStack {
                    Picker("Status", selection: $filter) { Text("All").tag("all"); Text("Pending").tag("pending"); Text("Approved").tag("approved"); Text("Declined").tag("denied") }.padding(12)
                    List(visible, selection: $selectedID) { request in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(request.organization).font(.headline)
                            Text("\(LodgeCalendarDates.displayDate(request.date)) · \(request.statusLabel)").font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5).tag(request.id)
                    }
                }
            } secondary: {
                if let request = selected {
                    Form {
                        if request.statusOnly == true {
                            Section("Secretary attestation status") {
                                Text("Secretary McDuffie is named on this signed agreement. You can follow its status here. A revised agreement accepted by the organization would be needed before the Assistant Secretary could attest.")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Section(request.organization) {
                            LabeledContent("Status", value: request.statusLabel)
                            LabeledContent("Date", value: LodgeCalendarDates.displayDate(request.date))
                            if request.statusOnly != true {
                            LabeledContent("Time", value: [LodgeCalendarDates.displayTime(request.start), LodgeCalendarDates.displayTime(request.end)].filter { !$0.isEmpty }.joined(separator: " to "))
                            LabeledContent("Requested spaces", value: request.spaces.joined(separator: ", "))
                            if request.spaces == ["Front yard"] { LabeledContent("Restroom access", value: request.bathroomAccess == true ? "Yes" : "No") }
                            LabeledContent("Contact", value: [request.contactName, request.contact].filter { !$0.isEmpty }.joined(separator: " · "))
                            if let coordinator = request.coordinator { LabeledContent("Request coordinator", value: "\(coordinator.name) · \(coordinator.email)") }
                            Text(request.description).textSelection(.enabled)
                            }
                        }
                        if let agreement = request.agreementText, !agreement.isEmpty {
                            Section("Building Use Agreement") {
                                DisclosureGroup("View full agreement") { Text(agreement).textSelection(.enabled).font(.system(.body, design: .serif)).padding(.vertical, 8) }
                            }
                        }
                        if let existing = request.note, !existing.isEmpty { Section("Recorded note") { Text(existing).textSelection(.enabled) } }
                        if let person = request.decidedBy, !person.isEmpty { LabeledContent("Decision recorded by", value: person) }
                        if let attestedBy = request.attestedBy { LabeledContent("Attested by", value: "\(attestedBy.name), \(attestedBy.title)") }
                        if let filedAt = request.filedCompletedAt {
                            LabeledContent("Filed as completed", value: filedAt)
                            if let filedBy = request.filedCompletedBy { LabeledContent("Filed by", value: filedBy) }
                        }
                        if request.status == "pending", workspace.canDecide, model.user?.can("building.decide") == true {
                            Section("Decision") {
                                TextField("Note to the requester", text: $note, axis: .vertical).lineLimit(3...8)
                                if note.count > 3000 { Text("Keep the note within 3,000 characters.").font(.caption) }
                                if request.ownerOnly == true {
                                    DatePicker("Authorization date", selection: $authorizationDate, displayedComponents: .date)
                                    TextField("Minutes or resolution reference", text: $authorizationRecord)
                                    TextField("Approved fee", text: $approvedFee)
                                    Picker("Insurance", selection: $insuranceDecision) { Text("Choose").tag(""); Text("Required").tag("required"); Text("Waived").tag("waived") }
                                    LabeledContent("Security deposit", value: "No security deposit is required")
                                    TextField("Conditions", text: $authorizationConditions, axis: .vertical).lineLimit(2...6)
                                    Text("Approval applies your saved signature. The officer designated in this agreement must attest before payment access is released.").font(.caption).foregroundStyle(.secondary)
                                }
                                HStack {
                                    Button("Approve") { decision = "approved" }.buttonStyle(.borderedProminent)
                                        .disabled(note.count > 3000 || (request.ownerOnly == true && (authorizationRecord.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || approvedFee.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || insuranceDecision.isEmpty)))
                                    Button("Decline") { decision = "denied" }.disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || note.count > 3000)
                                }
                            }
                        }
                        if request.agreementStatus == "awaiting_secretary_attestation", request.mayAttest(role: model.user?.role) {
                            Section("Officer attestation") {
                                Text("Review the complete approved agreement before applying your own saved signature as \(model.user?.role == "assistant_secretary" ? "Assistant Secretary" : "Secretary").")
                                Button("Attest agreement") { attestationPending = true }.buttonStyle(.borderedProminent)
                            }
                        }
                        if request.status == "approved", request.agreementStatus == "fully_executed",
                           request.filedCompletedAt == nil, model.user?.role == "owner" {
                            Section("Final filing") {
                                Text("The agreement has the required signatures and is ready for your final filing.")
                                Button("File as completed") { filingPending = true }.buttonStyle(.borderedProminent)
                            }
                        }
                    }.formStyle(.grouped)
                } else { ContentUnavailableView(visible.isEmpty ? "No requests available" : "Choose a request", systemImage: "building.2").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }.disabled(workspace.busy)
            } else { ContentUnavailableView("Request building use", systemImage: "building.2", description: Text("Use New Building Request to choose dates and spaces, check availability, and submit your request for review.")).frame(maxWidth: .infinity, maxHeight: .infinity) }
            if workspace.busy { ProgressView().padding(8) }
            if !workspace.message.isEmpty {
                Group {
                    if workspace.messageIsWarning { Label(workspace.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    else { Text(workspace.message) }
                }.font(.callout).padding(12)
            }
        }
        .task {
            _ = await workspace.load(using: model)
            openRequestedBuildingRecord()
        }
        .onChange(of: model.requestedBuildingRequestID) { _, _ in openRequestedBuildingRecord() }
        .sheet(isPresented: $showingNewRequest) { NewBuildingRequestView(workspace: newRequest).environmentObject(model) }
        .onChange(of: selectedID) { _, id in note = ""; authorizationRecord = ""; approvedFee = ""; insuranceDecision = ""; authorizationConditions = ""; if id != nil { requestPane = 1 } }
        .updateDraftGuard(active: !note.isEmpty || workspace.busy || newRequest.hasUnsubmittedChanges || newRequest.busy, reason: "Finish your building request draft before updating.")
        .alert(decision == "approved" ? "Approve this building request?" : "Decline this building request?", isPresented: Binding(get: { decision != nil }, set: { if !$0 { decision = nil } })) {
            Button("Confirm decision") {
                if let request = selected, let decision {
                    let authorization = request.ownerOnly == true && decision == "approved" ? BuildingAuthorization(date: LodgeCalendarDates.key(authorizationDate), record: authorizationRecord, fee: approvedFee, insurance: insuranceDecision, conditions: authorizationConditions) : nil
                    Task { if await workspace.decide(request, decision: decision, note: note, authorization: authorization, using: model) { note = "" } }
                }
                decision = nil
            }
            Button("Cancel", role: .cancel) { decision = nil }
        } message: { Text("This records your decision and sends the existing portal's decision notification to the requester.") }
        .alert("Attest this Building Use Agreement?", isPresented: $attestationPending) {
            Button("Attest") { if let request = selected { Task { _ = await workspace.attest(request, using: model) } } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("Your saved \(model.user?.role == "assistant_secretary" ? "Assistant Secretary" : "Secretary") signature will be applied. The organization will receive its decision and payment access once the workflow confirms completion.") }
        .alert("File this agreement as completed?", isPresented: $filingPending) {
            Button("File as completed") { if let request = selected { Task { _ = await workspace.fileCompleted(request, using: model) } } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("This records the fully signed agreement as filed and removes the filing reminder.") }
    }
    private func openRequestedBuildingRecord() {
        guard let id = model.requestedBuildingRequestID,
              workspace.requests.contains(where: { $0.id == id }) else { return }
        filter = "all"
        selectedID = id
        model.requestedBuildingRequestID = nil
    }
}

private func routeID(_ id: String) -> String { id.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id }

struct LodgeCalendarEvent: Codable, Identifiable {
    let id: String; let title: String; let startDate: String; let endDate: String
    let startTime: String?; let endTime: String?; let allDay: Bool
    let location: String; let description: String; let category: String; let status: String
    let source: String; let editable: Bool; let sourceUrl: String?
    var revision: String? = nil
    func includes(day: String) -> Bool { startDate <= day && (endDate.isEmpty ? startDate : endDate) >= day }
    var timeLabel: String { allDay ? "All day" : [startTime, endTime].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " to ") }
}
struct LodgeCalendarResponse: Decodable { let events: [LodgeCalendarEvent]; let warnings: [String]; let timezone: String }
struct LodgeEventDraft: Encodable, Equatable {
    var title = ""; var startDate = ""; var endDate = ""; var startTime = ""; var endTime = ""
    var allDay = false; var location = ""; var description = ""; var category = "lodge"; var revision: String?
    var status = "scheduled"; var source = "Lodge calendar"; var sourceUrl = ""
    init(day: String) { startDate = day; endDate = day }
    init(_ event: LodgeCalendarEvent) {
        title = event.title; startDate = event.startDate; endDate = event.endDate
        startTime = event.startTime ?? ""; endTime = event.endTime ?? ""; allDay = event.allDay
        location = event.location; description = event.description; category = event.category; revision = event.revision
        status = event.status; source = event.source; sourceUrl = event.sourceUrl ?? ""
    }
    var valid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.count <= 200 && location.count <= 500 && description.count <= 10000 && sourceUrl.count <= 2000
            && ["lodge", "jurisdiction", "community"].contains(category) && ["scheduled", "tentative", "cancelled"].contains(status)
            && LodgeCalendarDates.valid(startDate) && LodgeCalendarDates.valid(endDate) && endDate >= startDate
            && (allDay || (endTime.isEmpty || !startTime.isEmpty) && (startDate != endDate || startTime.isEmpty || endTime.isEmpty || endTime > startTime))
            && (allDay || [startTime, endTime].allSatisfy { $0.isEmpty || $0.range(of: #"^([01][0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil })
    }
}
enum LodgeCalendarDates {
    static var calendar: Calendar { var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "America/New_York")!; return calendar }
    static func key(_ date: Date) -> String { let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = calendar.timeZone; formatter.dateFormat = "yyyy-MM-dd"; return formatter.string(from: date) }
    static func valid(_ value: String) -> Bool { let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = calendar.timeZone; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false; guard value.count == 10, let date = formatter.date(from: value) else { return false }; return key(date) == value }
    static func range(_ date: Date) -> (String, String) { let interval = calendar.dateInterval(of: .month, for: date)!; return (key(interval.start), key(calendar.date(byAdding: .day, value: -1, to: interval.end)!)) }
    static func displayDate(_ value: String) -> String {
        let input = DateFormatter(); input.locale = Locale(identifier: "en_US_POSIX"); input.timeZone = calendar.timeZone; input.dateFormat = "yyyy-MM-dd"; input.isLenient = false
        guard let date = input.date(from: value) else { return value }
        let output = DateFormatter(); output.locale = Locale(identifier: "en_US"); output.timeZone = calendar.timeZone; output.dateFormat = "MMM d, yyyy"
        return output.string(from: date)
    }
    static func displayTime(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "" }
        let input = DateFormatter(); input.locale = Locale(identifier: "en_US_POSIX"); input.timeZone = calendar.timeZone; input.dateFormat = "HH:mm"; input.isLenient = false
        guard let date = input.date(from: value) else { return value }
        let output = DateFormatter(); output.locale = Locale(identifier: "en_US"); output.timeZone = calendar.timeZone; output.dateFormat = "h:mm a"
        return output.string(from: date)
    }
}
private struct CalendarMutationResponse: Decodable { let ok: Bool? }

@MainActor final class LodgeCalendarWorkspace: ObservableObject {
    @Published var events: [LodgeCalendarEvent] = []
    @Published var warnings: [String] = []
    @Published var message = ""
    @Published var busy = false
    private var loadRevision = 0
    private var requestedRange = ""
    @discardableResult func load(date: Date, using model: AppModel) async -> Bool {
        loadRevision += 1; let revision = loadRevision
        busy = true; defer { if revision == loadRevision { busy = false } }
        let (from, to) = LodgeCalendarDates.range(date)
        if requestedRange != from + to { events = []; warnings = []; requestedRange = from + to }
        do {
            let result: LodgeCalendarResponse = try await model.request("/api/lodge-calendar?from=\(from)&to=\(to)")
            guard revision == loadRevision else { return false }
            events = result.events.sorted { ($0.startDate, $0.startTime ?? "", $0.title) < ($1.startDate, $1.startTime ?? "", $1.title) }
            warnings = result.warnings; message = ""
            return true
        } catch { if revision == loadRevision { message = error.localizedDescription }; return false }
    }
    func save(_ draft: LodgeEventDraft, event: LodgeCalendarEvent?, date: Date, using model: AppModel) async -> Bool {
        guard !busy, draft.valid, model.user?.can("calendar.manage") == true, event == nil || event?.editable == true else { return false }
        busy = true; defer { busy = false }
        do {
            var body = draft
            if body.allDay { body.startTime = ""; body.endTime = "" }
            let _: CalendarMutationResponse = try await model.request(event.map { "/api/lodge-calendar/\(routeID($0.id))" } ?? "/api/lodge-calendar", method: event == nil ? "POST" : "PUT", body: JSONEncoder().encode(body))
            let refreshed = await load(date: date, using: model)
            message = refreshed ? "Event saved." : "Event saved. Refresh the calendar to see the latest events."
            return true
        } catch ClientError.conflict {
            _ = await load(date: date, using: model)
            message = "This event changed. Your edits remain open. Close the editor and reopen the event to review its latest details."
            return false
        } catch { message = error.localizedDescription; return false }
    }
    func remove(_ event: LodgeCalendarEvent, date: Date, using model: AppModel) async {
        guard !busy, event.editable, model.user?.can("calendar.manage") == true else { return }
        busy = true; defer { busy = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: event.revision.map { ["revision": $0] } ?? [:])
            let _: CalendarMutationResponse = try await model.request("/api/lodge-calendar/\(routeID(event.id))", method: "DELETE", body: body)
            let refreshed = await load(date: date, using: model)
            message = refreshed ? "Event removed." : "Event removed. Refresh the calendar to see the latest events."
        } catch ClientError.conflict { _ = await load(date: date, using: model); message = "This event changed. Review its latest details before removing it." }
        catch { message = error.localizedDescription }
    }
}

private struct CalendarEditorSelection: Identifiable { let id = UUID(); let event: LodgeCalendarEvent?; let day: String }
struct LodgeCalendarView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var workspace = LodgeCalendarWorkspace()
    @State private var day = Date()
    @State private var scope = "month"
    @State private var selectedID: String?
    @State private var editing: CalendarEditorSelection?
    @State private var deleting: LodgeCalendarEvent?
    @State private var calendarPane = 0
    private var visible: [LodgeCalendarEvent] { workspace.events.filter { scope == "month" || $0.includes(day: LodgeCalendarDates.key(day)) } }
    private var selected: LodgeCalendarEvent? { visible.first { $0.id == selectedID } }
    private var rangeKey: String { LodgeCalendarDates.range(day).0 }
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Lodge Calendar", subtitle: "Lodge and community events · Eastern Time", symbol: "calendar") {
                Button("Refresh") { Task { await workspace.load(date: day, using: model) } }.disabled(workspace.busy)
                if model.user?.can("calendar.manage") == true { Button("Add event") { editing = CalendarEditorSelection(event: nil, day: LodgeCalendarDates.key(day)) }.buttonStyle(.borderedProminent).disabled(workspace.busy) }
            }
            AdaptiveControlBar {
                HStack(spacing: 14) {
                    calendarNavigation
                    Spacer()
                    scopePicker.frame(width: 250)
                }
            } compact: {
                VStack(alignment: .leading, spacing: 10) {
                    calendarNavigation
                    scopePicker
                }
            }.padding(16).disabled(workspace.busy)
            Divider()
            AdaptiveWorkspaceSplit(primaryTitle: "Events", secondaryTitle: "Event details", compactPane: $calendarPane) {
                List(visible, selection: $selectedID) { event in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(event.title).font(.headline)
                        Text([LodgeCalendarDates.displayDate(event.startDate), event.allDay ? "All day" : [LodgeCalendarDates.displayTime(event.startTime), LodgeCalendarDates.displayTime(event.endTime)].filter { !$0.isEmpty }.joined(separator: " to ")].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        Text(event.category.capitalized).font(.caption2).foregroundStyle(.secondary)
                    }.padding(.vertical, 6).tag(event.id)
                }
            } secondary: {
                if let event = selected {
                    Form {
                        Section(event.title) {
                            LabeledContent("Starts", value: [LodgeCalendarDates.displayDate(event.startDate), LodgeCalendarDates.displayTime(event.startTime)].filter { !$0.isEmpty }.joined(separator: " · "))
                            LabeledContent("Ends", value: [LodgeCalendarDates.displayDate(event.endDate), LodgeCalendarDates.displayTime(event.endTime)].filter { !$0.isEmpty }.joined(separator: " · "))
                            if event.allDay { Text("All-day event") }
                            if !event.location.isEmpty { LabeledContent("Location", value: event.location) }
                            LabeledContent("Category", value: event.category.capitalized)
                            LabeledContent("Status", value: event.status.replacingOccurrences(of: "_", with: " ").capitalized)
                            Text(event.description).textSelection(.enabled)
                            LabeledContent("Source", value: event.source)
                            if let source = event.sourceUrl, let url = URL(string: source), ["https", "http"].contains(url.scheme?.lowercased() ?? "") { Link("Open source", destination: url) }
                        }
                        if event.editable, model.user?.can("calendar.manage") == true {
                            HStack {
                                Button("Edit event") { editing = CalendarEditorSelection(event: event, day: LodgeCalendarDates.key(day)) }
                                Button("Remove event", role: .destructive) { deleting = event }
                            }
                        }
                    }.formStyle(.grouped)
                } else { ContentUnavailableView(visible.isEmpty ? "No events in this period" : "Choose an event", systemImage: "calendar").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }.disabled(workspace.busy)
            if workspace.busy { ProgressView().padding(8) }
            ForEach(Array(workspace.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14) }
            if !workspace.message.isEmpty { Text(workspace.message).font(.callout).padding(12) }
        }
        .task(id: rangeKey) { await workspace.load(date: day, using: model) }
        .onChange(of: selectedID) { _, id in if id != nil { calendarPane = 1 } }
        .sheet(item: $editing) { selection in LodgeCalendarEditor(workspace: workspace, event: selection.event, day: selection.day, visibleDate: day).environmentObject(model) }
        .alert("Remove this calendar event?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Remove event", role: .destructive) { if let event = deleting { Task { await workspace.remove(event, date: day, using: model) } }; deleting = nil }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: { Text("The event will be removed from the Lodge calendar.") }
        .updateDraftGuard(active: workspace.busy, reason: "Wait for the calendar operation to finish before updating.")
    }
    private var calendarNavigation: some View {
        HStack(spacing: 10) {
            Button { moveMonth(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous month")
            DatePicker("Date", selection: $day, displayedComponents: .date).datePickerStyle(.field).environment(\.timeZone, LodgeCalendarDates.calendar.timeZone)
            Button { moveMonth(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next month")
            Button("Today") { day = Date() }
        }
    }
    private var scopePicker: some View {
        Picker("Agenda", selection: $scope) { Text("Month").tag("month"); Text("Selected day").tag("day") }.pickerStyle(.segmented)
    }
    private func moveMonth(_ offset: Int) { if let next = LodgeCalendarDates.calendar.date(byAdding: .month, value: offset, to: day) { day = next } }
}

private struct LodgeCalendarEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var workspace: LodgeCalendarWorkspace
    let event: LodgeCalendarEvent?
    let visibleDate: Date
    @State private var draft: LodgeEventDraft
    private let initialDraft: LodgeEventDraft
    @State private var confirmingCancel = false
    init(workspace: LodgeCalendarWorkspace, event: LodgeCalendarEvent?, day: String, visibleDate: Date) {
        self.workspace = workspace; self.event = event; self.visibleDate = visibleDate
        let startingDraft = event.map(LodgeEventDraft.init) ?? LodgeEventDraft(day: day)
        initialDraft = startingDraft
        _draft = State(initialValue: startingDraft)
    }
    var body: some View {
        VStack(spacing: 0) {
            Text(event == nil ? "Add calendar event" : "Edit calendar event").font(.title2.weight(.semibold)).padding(20)
            Form {
                TextField("Title", text: $draft.title)
                TextField("Start date (YYYY-MM-DD)", text: $draft.startDate)
                TextField("End date (YYYY-MM-DD)", text: $draft.endDate)
                Text("For one-day events, use the same start and end date.").font(.caption).foregroundStyle(.secondary)
                Toggle("All day", isOn: $draft.allDay).toggleStyle(.checkbox)
                if !draft.allDay {
                    TextField("Start time (HH:MM, optional)", text: $draft.startTime)
                    TextField("End time (HH:MM, optional)", text: $draft.endTime)
                }
                TextField("Location", text: $draft.location)
                Picker("Category", selection: $draft.category) { ForEach(["lodge", "jurisdiction", "community"], id: \.self) { Text($0.capitalized).tag($0) } }
                Picker("Status", selection: $draft.status) { ForEach(["scheduled", "tentative", "cancelled"], id: \.self) { Text($0.capitalized).tag($0) } }
                TextField("Information link (optional)", text: $draft.sourceUrl)
                TextField("Description", text: $draft.description, axis: .vertical).lineLimit(4...10)
                Text("Dates and times use Eastern Time.").font(.caption).foregroundStyle(.secondary)
                if !workspace.message.isEmpty { Text(workspace.message).font(.callout) }
            }.formStyle(.grouped).disabled(workspace.busy)
            HStack {
                Button("Cancel", role: .cancel) {
                    if draft != initialDraft { confirmingCancel = true }
                    else { dismiss() }
                }.disabled(workspace.busy)
                Spacer()
                Button("Save event") { Task { if await workspace.save(draft, event: event, date: visibleDate, using: model) { dismiss() } } }
                    .buttonStyle(.borderedProminent).disabled(!draft.valid || workspace.busy)
            }.padding(18)
        }.frame(minWidth: 500, idealWidth: 650, minHeight: 520, idealHeight: 620)
        .interactiveDismissDisabled(workspace.busy || draft != initialDraft)
        .updateDraftGuard(active: draft != initialDraft || workspace.busy, reason: "Finish or cancel your calendar event changes before updating.")
        .alert("Discard calendar event changes?", isPresented: $confirmingCancel) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: { Text("The changes in this editor have not been saved.") }
    }
}

struct BuildingBooking: Codable, Equatable, Identifiable {
    var id = UUID()
    var date = LodgeCalendarDates.key(Date())
    var start = "09:00"
    var end = "10:00"
    var dateSelection: Date {
        get { Self.formatter("yyyy-MM-dd").date(from: date) ?? Date() }
        set { date = LodgeCalendarDates.key(newValue) }
    }
    var startSelection: Date {
        get { Self.formatter("yyyy-MM-dd HH:mm").date(from: "2000-01-01 " + start)! }
        set { start = Self.formatter("HH:mm").string(from: newValue) }
    }
    var endSelection: Date {
        get { Self.formatter("yyyy-MM-dd HH:mm").date(from: "2000-01-01 " + end)! }
        set { end = Self.formatter("HH:mm").string(from: newValue) }
    }
    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = LodgeCalendarDates.calendar.timeZone; formatter.dateFormat = format
        return formatter
    }
    enum CodingKeys: String, CodingKey { case date, start, end }
    var valid: Bool { LodgeCalendarDates.valid(date) && Self.validTime(start) && Self.validTime(end) && end > start }
    static func validTime(_ value: String) -> Bool { value.range(of: #"^([01][0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil }
}
struct NewBuildingRequestDraft: Encodable, Equatable {
    static let availableSpaces = ["Lodge building", "Back yard", "Front yard"]
    var bookings = [BuildingBooking()]
    var spaces: [String] = []
    var bathroomAccess: Bool?
    var phone = ""
    var details = ""
    var submissionId = UUID().uuidString
    enum CodingKeys: String, CodingKey { case bookings, spaces, bathroomAccess, phone, details = "purpose", submissionId }
    var validationMessage: String? {
        guard (1...12).contains(bookings.count), bookings.allSatisfy(\.valid) else { return "Enter 1 to 12 dates with valid start and end times. Use HH:MM in Eastern Time." }
        guard Set(bookings.map { $0.date }).count == bookings.count else { return "List each date only once." }
        guard bookings.allSatisfy({ $0.date >= LodgeCalendarDates.key(Date()) }) else { return "Choose today or an upcoming date." }
        guard phone.count <= 40, details.count <= 1000 else { return "Use no more than 40 characters for the phone number and 1,000 for event details." }
        guard !spaces.isEmpty, spaces.allSatisfy(Self.availableSpaces.contains) else { return "Choose at least one space." }
        if spaces == ["Front yard"], bathroomAccess == nil { return "Choose whether you will need restroom access." }
        guard !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Describe the event and how the space will be used." }
        return nil
    }
    var availabilityKey: Data? {
        struct Schedule: Encodable { let bookings: [BuildingBooking]; let spaces: [String] }
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        return try? encoder.encode(Schedule(bookings: bookings, spaces: spaces.sorted()))
    }
}
struct BuildingBusyEntry: Decodable, Identifiable {
    var id: String { [date, start ?? "", end ?? "", label, status ?? ""].joined(separator: "|") }
    let date: String; let start: String?; let end: String?; let label: String; let status: String?; let allDay: Bool?
    var active: Bool { !["denied", "declined", "cancelled", "canceled"].contains(status?.lowercased() ?? "") }
    var knownTimes: Bool { allDay == true || (BuildingBooking.validTime(start ?? "") && BuildingBooking.validTime(end ?? "") && (end ?? "") > (start ?? "")) }
    func overlaps(_ booking: BuildingBooking) -> Bool {
        guard active, date == booking.date else { return false }
        if allDay == true { return true }
        guard knownTimes, let start, let end else { return false }
        return start < booking.end && end > booking.start
    }
}
struct BuildingAvailabilityResponse: Decodable { let busy: [BuildingBusyEntry]; let warning: String? }
struct BuildingSubmissionReceipt: Decodable {
    let ok: Bool; let ref: String?; let refs: [String]?; let wmNotified: Bool
    var references: [String] { if let refs, !refs.isEmpty { return refs }; return ref.map { [$0] } ?? [] }
}

@MainActor final class NewBuildingRequestWorkspace: ObservableObject {
    @Published var draft = NewBuildingRequestDraft()
    @Published var busy = false
    @Published var messageIsWarning = false
    @Published var message = "" { didSet { messageIsWarning = false } }
    @Published var availability: [BuildingBusyEntry] = []
    @Published var availabilityWarning = ""
    @Published var warningAcknowledged = false
    @Published var receipt: BuildingSubmissionReceipt?
    @Published private(set) var retryPending = false
    private var pendingBody: Data?
    private var baseline: NewBuildingRequestDraft
    private var checkedKey: Data?
    init() { let initial = NewBuildingRequestDraft(); draft = initial; baseline = initial }
    var hasUnsubmittedChanges: Bool { receipt == nil && draft != baseline }
    var availabilityCurrent: Bool { checkedKey != nil && checkedKey == draft.availabilityKey }
    var conflicts: [BuildingBusyEntry] { availability.filter { entry in draft.bookings.contains { entry.overlaps($0) } } }
    var canSubmit: Bool { !busy && receipt == nil && (retryPending || (draft.validationMessage == nil && availabilityCurrent && conflicts.isEmpty && (availabilityWarning.isEmpty || warningAcknowledged))) }
    func startNew() { pendingBody = nil; retryPending = false; draft = NewBuildingRequestDraft(); baseline = draft; checkedKey = nil; receipt = nil; message = ""; availability = []; availabilityWarning = ""; warningAcknowledged = false }
    func checkAvailability(using model: AppModel) async {
        guard !busy, !retryPending, model.user?.can("building.request") == true, !draft.bookings.isEmpty, draft.bookings.allSatisfy(\.valid), let key = draft.availabilityKey else { return }
        let dates = draft.bookings.map(\.date).sorted()
        busy = true; defer { busy = false }
        warningAcknowledged = false; availabilityWarning = ""; availability = []; checkedKey = nil; message = ""
        do {
            let result: BuildingAvailabilityResponse = try await model.request("/api/building/availability?from=\(dates.first!)&to=\(dates.last!)")
            guard key == draft.availabilityKey else { return }
            availability = result.busy
            var warnings = [result.warning ?? ""].filter { !$0.isEmpty }
            if result.busy.contains(where: { $0.active && dates.contains($0.date) && !$0.knownTimes }) { warnings.append("Some calendar entries have incomplete times. Availability needs further review.") }
            availabilityWarning = warnings.joined(separator: " "); checkedKey = key
        } catch {
            guard key == draft.availabilityKey else { return }
            availabilityWarning = "Availability could not be confirmed. \(error.localizedDescription)"; checkedKey = key
        }
    }
    func submit(using model: AppModel) async -> Bool {
        guard canSubmit, model.user?.can("building.request") == true else { return false }
        busy = true; defer { busy = false }
        do {
            if pendingBody == nil {
                var payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
                payload["acknowledgeAvailabilityWarning"] = !availabilityWarning.isEmpty && warningAcknowledged
                pendingBody = try JSONSerialization.data(withJSONObject: payload)
            }
            let result: BuildingSubmissionReceipt = try await model.request("/api/building/requests", method: "POST", body: pendingBody)
            guard result.ok, !result.references.isEmpty else { throw ClientError.invalidResponse }
            retryPending = false; pendingBody = nil; receipt = result
            message = result.wmNotified
                ? "Request submitted for review. This is not an approved reservation."
                : "Request submitted for review, but notification to the Worshipful Master has not been confirmed."
            messageIsWarning = !result.wmNotified
            return true
        } catch ClientError.rejected(let detail) { pendingBody = nil; retryPending = false; checkedKey = nil; message = detail; return false }
        catch ClientError.conflict(let detail) {
            if detail.contains("The building calendar shows") {
                pendingBody = nil; retryPending = false; checkedKey = nil
            } else { retryPending = pendingBody != nil }
            message = detail; return false
        }
        catch { retryPending = pendingBody != nil; message = "Submission could not be confirmed. Retry this same request to recover its receipt. " + error.localizedDescription; return false }
    }
}

private struct NewBuildingRequestView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var workspace: NewBuildingRequestWorkspace
    @State private var confirmingSubmit = false
    @State private var confirmingClose = false
    var body: some View {
        VStack(spacing: 0) {
            Text("New Building Request").font(.title2.weight(.semibold)).padding(20)
            if let receipt = workspace.receipt {
                VStack(alignment: .leading, spacing: 16) {
                    Label("Submitted for review", systemImage: "checkmark.circle").font(.title3)
                    Text("Your request is pending. Building use has not been approved.")
                    ForEach(receipt.references, id: \.self) { Text("Reference: \($0)").textSelection(.enabled) }
                    if receipt.wmNotified {
                        Label("The Worshipful Master was notified.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Label("Notification to the Worshipful Master has not been confirmed.", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                    HStack { Button("Start another request") { workspace.startNew() }; Spacer(); Button("Done") { dismiss() }.buttonStyle(.borderedProminent) }
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                Form {
                    Section("Lodge request") {
                        LabeledContent("Organization", value: "Stone Square Lodge No. 22")
                        LabeledContent("Requested by", value: model.user?.name ?? "")
                        TextField("Contact phone (optional)", text: $workspace.draft.phone)
                        TextField("Event details", text: $workspace.draft.details, axis: .vertical).lineLimit(4...8)
                    }
                    Section("Requested dates and times") {
                        ForEach($workspace.draft.bookings) { $booking in
                            HStack(alignment: .bottom, spacing: 20) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Date").font(.caption).foregroundStyle(.secondary)
                                    DatePicker("Requested date", selection: $booking.dateSelection, displayedComponents: .date).labelsHidden().datePickerStyle(.compact)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Start time").font(.caption).foregroundStyle(.secondary)
                                    DatePicker("Start time", selection: $booking.startSelection, displayedComponents: .hourAndMinute).labelsHidden().datePickerStyle(.compact)
                                }
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("End time").font(.caption).foregroundStyle(.secondary)
                                    DatePicker("End time", selection: $booking.endSelection, displayedComponents: .hourAndMinute).labelsHidden().datePickerStyle(.compact)
                                }
                                Button { workspace.draft.bookings.removeAll { $0.id == booking.id } } label: { Image(systemName: "minus.circle") }.disabled(workspace.draft.bookings.count == 1).accessibilityLabel("Remove requested date")
                            }
                        }
                        Button("Add date") { workspace.draft.bookings.append(BuildingBooking()) }.disabled(workspace.draft.bookings.count >= 12)
                        Text("Include setup and cleanup time. All dates and times are Eastern Time.").font(.caption).foregroundStyle(.secondary)
                    }
                    Section("Spaces") {
                        ForEach(NewBuildingRequestDraft.availableSpaces, id: \.self) { space in
                            Toggle(space, isOn: Binding(get: { workspace.draft.spaces.contains(space) }, set: { selected in
                                if selected { workspace.draft.spaces.append(space) } else { workspace.draft.spaces.removeAll { $0 == space } }
                                if workspace.draft.spaces != ["Front yard"] { workspace.draft.bathroomAccess = nil }
                            })).toggleStyle(.checkbox)
                        }
                        if workspace.draft.spaces == ["Front yard"] {
                            Picker("Will you need access to the restroom?", selection: $workspace.draft.bathroomAccess) {
                                Text("Choose").tag(nil as Bool?)
                                Text("Yes").tag(true as Bool?)
                                Text("No").tag(false as Bool?)
                            }
                        }
                    }
                    Section("Availability review") {
                        Button("Check availability") { Task { await workspace.checkAvailability(using: model) } }.disabled(!workspace.draft.bookings.allSatisfy(\.valid))
                        if workspace.availabilityCurrent {
                            if workspace.conflicts.isEmpty && workspace.availabilityWarning.isEmpty { Text("No known overlapping bookings were found. The request still requires approval.").font(.callout) }
                            else if !workspace.conflicts.isEmpty {
                                Text("Choose another date or time. These bookings overlap your request:").foregroundStyle(.red)
                                ForEach(Array(workspace.conflicts.enumerated()), id: \.offset) { _, entry in Text("\(LodgeCalendarDates.displayDate(entry.date)) · \(entry.label) · \(entry.allDay == true ? "All day" : [LodgeCalendarDates.displayTime(entry.start), LodgeCalendarDates.displayTime(entry.end)].filter { !$0.isEmpty }.joined(separator: " to "))") }
                            }
                            if !workspace.availabilityWarning.isEmpty {
                                Text(workspace.availabilityWarning).foregroundStyle(.orange)
                                Toggle("I understand availability is incomplete and needs further review.", isOn: $workspace.warningAcknowledged).toggleStyle(.checkbox)
                            }
                        } else { Text("Check availability after choosing your dates, times and spaces.").font(.caption).foregroundStyle(.secondary) }
                    }
                    if let validation = workspace.draft.validationMessage { Text(validation).font(.caption).foregroundStyle(.secondary) }
                    if !workspace.message.isEmpty { Text(workspace.message).foregroundStyle(.red) }
                }.formStyle(.grouped).disabled(workspace.busy || workspace.retryPending)
                HStack {
                    Button("Close") {
                        if workspace.hasUnsubmittedChanges { confirmingClose = true }
                        else { dismiss() }
                    }.disabled(workspace.busy)
                    Spacer()
                    if workspace.busy { ProgressView().controlSize(.small) }
                    Button(workspace.retryPending ? "Retry same request" : "Submit request") { confirmingSubmit = true }.buttonStyle(.borderedProminent).disabled(!workspace.canSubmit)
                }.padding(18)
            }
        }.frame(minWidth: 560, idealWidth: 790, minHeight: 600, idealHeight: 760)
        .environment(\.timeZone, LodgeCalendarDates.calendar.timeZone)
        .environment(\.calendar, LodgeCalendarDates.calendar)
        .interactiveDismissDisabled(workspace.busy || workspace.hasUnsubmittedChanges)
        .alert("Submit this building request?", isPresented: $confirmingSubmit) {
            Button("Submit request") { Task { _ = await workspace.submit(using: model) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(workspace.availabilityWarning.isEmpty ? "This sends your requested dates and details for review and sends the request notifications. It does not approve building use." : "Availability could not be fully confirmed. You have acknowledged that further review is needed. This sends your request and its notifications; it does not approve building use.") }
        .alert("Discard this building request draft?", isPresented: $confirmingClose) {
            Button("Discard draft", role: .destructive) { workspace.startNew(); dismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: { Text("Your entered dates, spaces and event details have not been submitted.") }
    }
}
