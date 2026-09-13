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
    let description: String; let status: String; let note: String?
    let decidedAt: String?; let decidedBy: String?; let revision: BuildingRevision
    let requesterNotified: Bool
    var statusLabel: String { ["pending": "Pending", "approved": "Approved", "denied": "Declined"][status] ?? status.capitalized }
}
struct BuildingRequestsResponse: Decodable { let requests: [BuildingRequest]; let canDecide: Bool }
private struct BuildingDecisionBody: Encodable { let decision: String; let note: String; let revision: BuildingRevision }
private struct BuildingDecisionResponse: Decodable { let request: BuildingRequest }

@MainActor final class BuildingRequestsWorkspace: ObservableObject {
    @Published var requests: [BuildingRequest] = []
    @Published var canDecide = false
    @Published var busy = false
    @Published var message = ""
    @discardableResult func load(using model: AppModel) async -> Bool {
        busy = true; defer { busy = false }
        do {
            let result: BuildingRequestsResponse = try await model.request("/api/building/requests")
            requests = result.requests; canDecide = result.canDecide; message = ""
            return true
        } catch { message = error.localizedDescription; return false }
    }
    func decide(_ request: BuildingRequest, decision: String, note: String, using model: AppModel) async -> Bool {
        guard !busy, canDecide, model.user?.can("building.decide") == true, request.status == "pending",
              ["approved", "denied"].contains(decision), note.count <= 3000, requests.first(where: { $0.id == request.id })?.revision == request.revision else { return false }
        busy = true; defer { busy = false }
        do {
            let body = try JSONEncoder().encode(BuildingDecisionBody(decision: decision, note: note, revision: request.revision))
            let result: BuildingDecisionResponse = try await model.request("/api/building/requests/\(routeID(request.id))/decision", method: "POST", body: body)
            if let index = requests.firstIndex(where: { $0.id == result.request.id }) { requests[index] = result.request }
            message = result.request.requesterNotified ? "Decision recorded and requester notified." : "Decision recorded. The requester notification has not been confirmed."
            return true
        } catch ClientError.conflict {
            let refreshed = await load(using: model)
            message = refreshed ? "This request changed. Review the latest details before deciding again." : "This request changed. Refresh it before deciding again."
            return false
        } catch { message = error.localizedDescription; return false }
    }
}

struct BuildingRequestsView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var workspace = BuildingRequestsWorkspace()
    @State private var selectedID: String?
    @State private var filter = "all"
    @State private var note = ""
    @State private var decision: String?
    private var selected: BuildingRequest? { workspace.requests.first { $0.id == selectedID } }
    private var visible: [BuildingRequest] { workspace.requests.filter { filter == "all" || $0.status == filter } }
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Building Requests", subtitle: "Requests to use the Lodge building", symbol: "building.2") {
                Button("Refresh") { Task { await workspace.load(using: model) } }.disabled(workspace.busy)
            }
            HSplitView {
                VStack {
                    Picker("Status", selection: $filter) { Text("All").tag("all"); Text("Pending").tag("pending"); Text("Approved").tag("approved"); Text("Declined").tag("denied") }.padding(12)
                    List(visible, selection: $selectedID) { request in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(request.organization).font(.headline)
                            Text("\(request.date) · \(request.statusLabel)").font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5).tag(request.id)
                    }
                }.frame(minWidth: 230, idealWidth: 310, maxWidth: 400)
                if let request = selected {
                    Form {
                        Section(request.organization) {
                            LabeledContent("Status", value: request.statusLabel)
                            LabeledContent("Date", value: request.date)
                            LabeledContent("Time", value: [request.start, request.end].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " to "))
                            LabeledContent("Requested spaces", value: request.spaces.joined(separator: ", "))
                            LabeledContent("Contact", value: [request.contactName, request.contact].filter { !$0.isEmpty }.joined(separator: " · "))
                            Text(request.description).textSelection(.enabled)
                        }
                        if let existing = request.note, !existing.isEmpty { Section("Recorded note") { Text(existing).textSelection(.enabled) } }
                        if let person = request.decidedBy, !person.isEmpty { LabeledContent("Decision recorded by", value: person) }
                        if request.status == "pending", workspace.canDecide, model.user?.can("building.decide") == true {
                            Section("Decision") {
                                TextField("Note to the requester", text: $note, axis: .vertical).lineLimit(3...8)
                                if note.count > 3000 { Text("Keep the note within 3,000 characters.").font(.caption) }
                                HStack { Button("Approve") { decision = "approved" }.buttonStyle(.borderedProminent); Button("Decline") { decision = "denied" } }.disabled(note.count > 3000)
                            }
                        }
                    }.formStyle(.grouped)
                } else { ContentUnavailableView(visible.isEmpty ? "No requests available" : "Choose a request", systemImage: "building.2").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }.disabled(workspace.busy)
            if workspace.busy { ProgressView().padding(8) }
            if !workspace.message.isEmpty { Text(workspace.message).font(.callout).padding(12) }
        }
        .task { await workspace.load(using: model) }
        .onChange(of: selectedID) { _, _ in note = "" }
        .updateDraftGuard(active: !note.isEmpty || workspace.busy, reason: "Finish your building request note before updating.")
        .alert(decision == "approved" ? "Approve this building request?" : "Decline this building request?", isPresented: Binding(get: { decision != nil }, set: { if !$0 { decision = nil } })) {
            Button("Confirm decision") {
                if let request = selected, let decision { Task { if await workspace.decide(request, decision: decision, note: note, using: model) { note = "" } } }
                decision = nil
            }
            Button("Cancel", role: .cancel) { decision = nil }
        } message: { Text("This records your decision and sends the existing portal's decision notification to the requester.") }
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
    private var visible: [LodgeCalendarEvent] { workspace.events.filter { scope == "month" || $0.includes(day: LodgeCalendarDates.key(day)) } }
    private var selected: LodgeCalendarEvent? { visible.first { $0.id == selectedID } }
    private var rangeKey: String { LodgeCalendarDates.range(day).0 }
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Lodge Calendar", subtitle: "Lodge and community events · Eastern Time", symbol: "calendar") {
                Button("Refresh") { Task { await workspace.load(date: day, using: model) } }.disabled(workspace.busy)
                if model.user?.can("calendar.manage") == true { Button("Add event") { editing = CalendarEditorSelection(event: nil, day: LodgeCalendarDates.key(day)) }.buttonStyle(.borderedProminent).disabled(workspace.busy) }
            }
            HStack(spacing: 14) {
                Button { moveMonth(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous month")
                DatePicker("Date", selection: $day, displayedComponents: .date).datePickerStyle(.field).environment(\.timeZone, LodgeCalendarDates.calendar.timeZone)
                Button { moveMonth(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next month")
                Button("Today") { day = Date() }
                Spacer()
                Picker("Agenda", selection: $scope) { Text("Month").tag("month"); Text("Selected day").tag("day") }.pickerStyle(.segmented).frame(width: 250)
            }.padding(16).disabled(workspace.busy)
            Divider()
            HSplitView {
                List(visible, selection: $selectedID) { event in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(event.title).font(.headline)
                        Text([event.startDate, event.timeLabel].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        Text(event.category.capitalized).font(.caption2).foregroundStyle(.secondary)
                    }.padding(.vertical, 6).tag(event.id)
                }.frame(minWidth: 260, idealWidth: 350, maxWidth: 460)
                if let event = selected {
                    Form {
                        Section(event.title) {
                            LabeledContent("Starts", value: [event.startDate, event.startTime ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                            LabeledContent("Ends", value: [event.endDate, event.endTime ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
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
        .sheet(item: $editing) { selection in LodgeCalendarEditor(workspace: workspace, event: selection.event, day: selection.day, visibleDate: day).environmentObject(model) }
        .alert("Remove this calendar event?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Remove event", role: .destructive) { if let event = deleting { Task { await workspace.remove(event, date: day, using: model) } }; deleting = nil }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: { Text("The event will be removed from the Lodge calendar.") }
        .updateDraftGuard(active: workspace.busy, reason: "Wait for the calendar operation to finish before updating.")
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
    init(workspace: LodgeCalendarWorkspace, event: LodgeCalendarEvent?, day: String, visibleDate: Date) {
        self.workspace = workspace; self.event = event; self.visibleDate = visibleDate
        _draft = State(initialValue: event.map(LodgeEventDraft.init) ?? LodgeEventDraft(day: day))
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
                Button("Cancel", role: .cancel) { dismiss() }.disabled(workspace.busy)
                Spacer()
                Button("Save event") { Task { if await workspace.save(draft, event: event, date: visibleDate, using: model) { dismiss() } } }
                    .buttonStyle(.borderedProminent).disabled(!draft.valid || workspace.busy)
            }.padding(18)
        }.frame(width: 650, height: 620)
        .interactiveDismissDisabled(workspace.busy)
        .updateDraftGuard(reason: "Finish or cancel your calendar event changes before updating.")
    }
}
