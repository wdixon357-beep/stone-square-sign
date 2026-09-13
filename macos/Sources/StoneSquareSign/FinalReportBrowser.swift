import SwiftUI
import PDFKit

struct FinalReportBrowserView: View {
    enum Kind: String { case minutes, treasury
        var title: String { self == .minutes ? "Meeting Minutes" : "Treasurer Reports" }
    }
    struct Record: Decodable, Identifiable {
        struct Draft: Decodable { let meetingDate: String?; let periodEnd: String? }
        let id: String; let status: String; let createdBy: String; let draft: Draft
        var label: String { draft.meetingDate ?? draft.periodEnd ?? "Finalized report" }
    }
    private struct MinutesList: Decodable { let minutes: [Record] }
    private struct TreasuryList: Decodable { let reports: [Record] }
    @EnvironmentObject private var model: AppModel
    let kind: Kind
    @State private var records: [Record] = []
    @State private var selectedID: String?
    @State private var pdf: Data?
    @State private var message = ""
    @State private var loading = false
    @StateObject private var transport = MinutesWorkspace()
    var initialSelection: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: kind.title, subtitle: "Read finalized Lodge records", symbol: "doc.text") {
                Button("Refresh") { Task { await refresh() } }.disabled(loading)
                Button("Save PDF") { if let pdf { saveDocument(pdf, name: "\(kind.title).pdf", type: .pdf) } }.disabled(pdf == nil)
            }
            HSplitView {
                List(records, selection: $selectedID) { record in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(record.label).font(.headline)
                        Text(record.createdBy).font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 5).tag(record.id)
                }.frame(minWidth: 230, idealWidth: 300, maxWidth: 400)
                if pdf != nil { LodgeDocumentPreview(data: pdf) }
                else { ContentUnavailableView(records.isEmpty ? "No finalized reports available" : "Choose a report", systemImage: "doc.text").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }
            if loading { ProgressView().padding(8) }
            if !message.isEmpty { Text(message).font(.callout).padding(12) }
        }
        .task(id: kind) { transport.configure(model); await refresh(); selectedID = initialSelection }
        .onChange(of: selectedID) { _, id in pdf = nil; if let id { Task { await open(id) } } }
    }
    private func refresh() async {
        loading = true; defer { loading = false }
        do {
            let bytes = try await transport.request("/api/\(kind.rawValue)")
            let decoder = JSONDecoder()
            records = kind == .minutes ? try decoder.decode(MinutesList.self, from: bytes).minutes : try decoder.decode(TreasuryList.self, from: bytes).reports
            records = records.filter { ["ready_for_distribution", "distributed", "approved_by_lodge"].contains($0.status) }
            if !records.contains(where: { $0.id == selectedID }) { selectedID = nil; pdf = nil }
            message = ""
        } catch { message = error.localizedDescription }
    }
    private func open(_ id: String) async {
        do {
            let bytes = try await transport.request("/api/\(kind.rawValue)/\(id)/pdf")
            guard selectedID == id else { return }
            guard PDFDocument(data: bytes) != nil else { throw ClientError.invalidResponse }
            pdf = bytes; message = ""
        } catch { if selectedID == id { message = error.localizedDescription } }
    }
}
