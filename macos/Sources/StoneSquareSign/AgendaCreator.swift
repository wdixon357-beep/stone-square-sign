import SwiftUI
import PDFKit
import UniformTypeIdentifiers

struct AgendaOfficer: Codable, Equatable, Identifiable {
    var id: String { office + name }
    var office: String
    var name: String
}
struct AgendaItem: Codable, Equatable, Identifiable {
    var id: String
    var heading: String
    var scheduledTime: String
    var body: String
}
struct AgendaDraft: Codable, Equatable {
    var meetingDate: String
    var meetingType: String
    var startTime: String
    var dress: String
    var addressee: String
    var subtitle: String
    var masonicYear: String
    var officers: [AgendaOfficer]
    var sections: [AgendaItem]
}
struct AgendaRecord: Codable, Equatable, Identifiable {
    var id: String
    var meetingDate: String?
    var status: String
    var revision: Int
    var draft: AgendaDraft
    var createdAt: String
    var updatedAt: String
}
struct AgendaListPayload: Decodable { let agendas: [AgendaRecord] }
struct AgendaPayload: Decodable { let agenda: AgendaRecord }
private struct AgendaSavePayload: Encodable { let revision: Int; let draft: AgendaDraft }
private struct AgendaDeletePayload: Encodable { let revision: Int }

@MainActor final class AgendaWorkspace: ObservableObject {
    @Published var records: [AgendaRecord] = []
    @Published var selected: AgendaRecord?
    @Published var draft: AgendaDraft?
    @Published var pdf: Data?
    @Published var message = ""
    @Published var previewMessage = ""
    @Published var busy = false
    @Published var dirty = false
    let transport = MinutesWorkspace()
    private var previewTask: Task<Void, Never>?
    private var generation = 0

    private func savedLabel(_ value: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        guard let date else { return "Draft saved" }
        return "Last saved \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    func configure(_ model: AppModel) { transport.configure(model) }
    func refresh() async {
        do { records = try JSONDecoder().decode(AgendaListPayload.self, from: await transport.request("/api/agendas")).agendas }
        catch { message = error.localizedDescription }
    }
    func create() async {
        busy = true; defer { busy = false }
        do {
            let data = try await transport.request("/api/agendas", method: "POST", body: Data("{}".utf8))
            let record = try JSONDecoder().decode(AgendaPayload.self, from: data).agenda
            await refresh(); open(record); message = "Draft created and saved. You can return to it from the URL or this Mac."
        } catch { message = error.localizedDescription }
    }
    func open(_ record: AgendaRecord) {
        selected = record; draft = record.draft; dirty = false; pdf = nil; message = savedLabel(record.updatedAt); updatePreview()
    }
    func close() { previewTask?.cancel(); generation += 1; selected = nil; draft = nil; pdf = nil; dirty = false }
    func save() async -> Bool {
        guard let selected, let draft else { return false }
        busy = true; defer { busy = false }
        do {
            let data = try await transport.request("/api/agendas/\(selected.id)", method: "PUT", body: JSONEncoder().encode(AgendaSavePayload(revision: selected.revision, draft: draft)))
            let record = try JSONDecoder().decode(AgendaPayload.self, from: data).agenda
            self.selected = record; self.draft = record.draft; dirty = false; await refresh(); message = "Draft saved. \(savedLabel(record.updatedAt)). You can safely leave and continue later."; return true
        } catch { message = error.localizedDescription; return false }
    }
    func remove(_ record: AgendaRecord) async {
        busy = true; defer { busy = false }
        do { _ = try await transport.request("/api/agendas/\(record.id)", method: "DELETE", body: JSONEncoder().encode(AgendaDeletePayload(revision: record.revision))); if selected?.id == record.id { close() }; await refresh(); message = "Agenda deleted." }
        catch { message = error.localizedDescription }
    }
    func changed() { dirty = draft != selected?.draft; if dirty { message = "Unsaved changes" }; updatePreview() }
    func addSection() { draft?.sections.append(AgendaItem(id: UUID().uuidString, heading: "New Agenda Section", scheduledTime: "", body: "")); changed() }
    func removeSection(_ index: Int) { draft?.sections.remove(at: index); changed() }
    func move(_ index: Int, by offset: Int) {
        let target = index + offset; guard target >= 0, target < (draft?.sections.count ?? 0) else { return }
        draft?.sections.swapAt(index, target); changed()
    }
    func updatePreview() {
        previewTask?.cancel(); generation += 1; let expected = generation
        guard let draft, let id = selected?.id else { return }
        previewMessage = "Updating preview…"; pdf = nil
        previewTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(700))
                let bytes = try await transport.request("/api/agendas/\(id)/preview", method: "POST", body: JSONEncoder().encode(["draft": draft]))
                guard !Task.isCancelled, expected == generation, selected?.id == id else { return }
                guard PDFDocument(data: bytes) != nil else { throw ClientError.invalidResponse }
                pdf = bytes; previewMessage = "Preview matches the current fields."
            } catch { if !Task.isCancelled && expected == generation { previewMessage = error.localizedDescription } }
        }
    }
}

struct AgendaCreatorView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var workspace: AgendaWorkspace
    @State private var deleting: AgendaRecord?
    @State private var leave = false
    @State private var editorPane = 0
    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Agenda Creator", subtitle: workspace.selected == nil ? "Create, save, and resume Lodge agenda drafts" : "Build the agenda in stages and save it before leaving", symbol: "list.number") {
                if workspace.selected == nil { Button("Create Agenda Draft") { Task { await workspace.create() } }.buttonStyle(.borderedProminent) }
                else { Button("All Agenda Drafts") { if workspace.dirty { leave = true } else { workspace.close() } }; Button("Save Draft") { Task { _ = await workspace.save() } }.buttonStyle(.borderedProminent).disabled(!workspace.dirty) }
            }
            if workspace.draft == nil { list } else { editor }
            if !workspace.message.isEmpty { Text(workspace.message).font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.bar) }
        }
        .background(Color(nsColor: .windowBackgroundColor)).disabled(workspace.busy)
        .task { workspace.configure(model); await workspace.refresh() }
        .onChange(of: workspace.draft) { old, new in if old != nil && old != new { workspace.changed() } }
        .alert("Delete this agenda draft?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete", role: .destructive) { if let deleting { Task { await workspace.remove(deleting) } } }; Button("Cancel", role: .cancel) {}
        }
        .alert("Leave unsaved agenda changes?", isPresented: $leave) { Button("Leave changes", role: .destructive) { workspace.close() }; Button("Keep editing", role: .cancel) {} }
    }
    private var list: some View {
        List {
            Section("Saved agenda drafts") {
                if workspace.records.isEmpty { ContentUnavailableView("No agenda drafts yet", systemImage: "list.number", description: Text("Create a draft and save your progress as you build the meeting order.")) }
                ForEach(workspace.records) { record in
                    HStack(spacing: 14) {
                        Image(systemName: "list.number").font(.title2).foregroundStyle(SignTheme.gold)
                        VStack(alignment: .leading, spacing: 4) { Text(record.draft.meetingDate.isEmpty ? "Meeting date needs review" : MinutesDateText.display(record.draft.meetingDate)).font(.headline); Text("Draft · \(record.draft.meetingType)").font(.caption).foregroundStyle(.secondary) }
                        Spacer(); Button("Resume Draft") { workspace.open(record) }; Button("Delete Draft", role: .destructive) { deleting = record }
                    }.padding(.vertical, 7)
                }
            }
        }.listStyle(.inset)
    }
    private var editor: some View {
        AdaptiveWorkspaceSplit(primaryTitle: "Agenda entries", secondaryTitle: "Document preview", compactPane: $editorPane) {
            Form {
                Section("Meeting details") {
                    TextField("Meeting date, YYYY-MM-DD", text: binding(\.meetingDate))
                    Picker("Meeting type", selection: binding(\.meetingType)) { Text("Stated Communication").tag("Stated Communication"); Text("Special Communication").tag("Special Communication") }
                    HStack { TextField("Start time", text: binding(\.startTime)); TextField("Dress", text: binding(\.dress)) }
                    TextField("Optional note below the title", text: binding(\.subtitle), axis: .vertical).lineLimit(2...4)
                }
                Section("Order of business") {
                    ForEach(workspace.draft?.sections.indices ?? 0..<0, id: \.self) { index in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text("Section \(index + 1)").font(.headline); Spacer(); Button("Up") { workspace.move(index, by: -1) }.disabled(index == 0); Button("Down") { workspace.move(index, by: 1) }.disabled(index == (workspace.draft?.sections.count ?? 1) - 1); Button("Remove", role: .destructive) { workspace.removeSection(index) } }
                            HStack { TextField("Heading", text: section(index, \.heading)); TextField("Target time", text: section(index, \.scheduledTime)).frame(width: 110) }
                            TextEditor(text: section(index, \.body)).frame(minHeight: 85).padding(5).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                        }.padding(.vertical, 8)
                    }
                    Button("Add section") { workspace.addSection() }
                }
                DisclosureGroup("Officer rail") {
                    Text("Review these names when Lodge offices change.").font(.caption).foregroundStyle(.secondary)
                    ForEach(workspace.draft?.officers.indices ?? 0..<0, id: \.self) { index in HStack { TextField("Office", text: officer(index, \.office)); TextField("Name", text: officer(index, \.name)) } }
                }
            }.formStyle(.grouped)
        } secondary: {
            VStack(alignment: .leading, spacing: 10) {
                HStack { VStack(alignment: .leading) { Text("Document preview").font(.headline); Text(workspace.previewMessage).font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("Save PDF") { if let pdf = workspace.pdf { saveDocument(pdf, name: "Stone Square Agenda.pdf", type: .pdf) } }.disabled(workspace.pdf == nil || workspace.previewMessage != "Preview matches the current fields.") }
                LodgeDocumentPreview(data: workspace.pdf)
            }.padding(14)
        }
    }
    private func binding(_ key: WritableKeyPath<AgendaDraft, String>) -> Binding<String> { Binding(get: { workspace.draft?[keyPath: key] ?? "" }, set: { workspace.draft?[keyPath: key] = $0 }) }
    private func section(_ index: Int, _ key: WritableKeyPath<AgendaItem, String>) -> Binding<String> { Binding(get: { workspace.draft?.sections[index][keyPath: key] ?? "" }, set: { workspace.draft?.sections[index][keyPath: key] = $0 }) }
    private func officer(_ index: Int, _ key: WritableKeyPath<AgendaOfficer, String>) -> Binding<String> { Binding(get: { workspace.draft?.officers[index][keyPath: key] ?? "" }, set: { workspace.draft?.officers[index][keyPath: key] = $0 }) }
}
