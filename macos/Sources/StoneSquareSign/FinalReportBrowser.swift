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
    struct ArchiveRecord: Decodable, Identifiable {
        let id: String; let title: String; let recordDate: String?
    }
    private struct MinutesList: Decodable { let minutes: [Record] }
    private struct TreasuryList: Decodable { let reports: [Record] }
    private struct ArchiveList: Decodable { let records: [ArchiveRecord] }
    @EnvironmentObject private var model: AppModel
    let kind: Kind
    @State private var records: [Record] = []
    @State private var archives: [ArchiveRecord] = []
    @State private var selectedID: String?
    @State private var pdf: Data?
    @State private var message = ""
    @State private var loading = false
    @StateObject private var transport = MinutesWorkspace()
    var initialSelection: String? = nil
    var onClose: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: kind.title, subtitle: "Read finalized Lodge records", symbol: "doc.text") {
                if selectedID != nil { Button("Close report") { selectedID = nil; pdf = nil } }
                if let onClose { Button("Done") { onClose() } }
                Button("Refresh") { Task { await refresh() } }.disabled(loading)
                Button("Save PDF") { if let pdf { saveDocument(pdf, name: "\(kind.title).pdf", type: .pdf) } }.disabled(pdf == nil)
            }
            HSplitView {
                List(selection: $selectedID) {
                    Section("Finalized in Dashboard") { ForEach(records) { record in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(record.label).font(.headline)
                            Text(record.createdBy).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5).tag("current:\(record.id)")
                    } }
                    Section("Historical Lodge archive") { ForEach(archives) { record in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(record.title).font(.headline)
                            Text("Historical Lodge archive").font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5).tag("archive:\(record.id)")
                    } }
                }.frame(minWidth: 230, idealWidth: 300, maxWidth: 400)
                if pdf != nil { LodgeDocumentPreview(data: pdf) }
                else { ContentUnavailableView(records.isEmpty && archives.isEmpty ? "No reports available" : "Choose a report", systemImage: "doc.text").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }
            if loading { ProgressView().padding(8) }
            if !message.isEmpty { Text(message).font(.callout).padding(12) }
        }
        .task(id: kind) { transport.configure(model); await refresh(); if let initialSelection { selectedID = "current:\(initialSelection)" } }
        .onChange(of: model.minutesRecordsRevision) { _, _ in if kind == .minutes { Task { await refresh() } } }
        .onChange(of: selectedID) { _, id in pdf = nil; if let id { Task { await open(id) } } }
    }
    private func refresh() async {
        loading = true; defer { loading = false }
        do {
            async let currentBytes = transport.request("/api/\(kind.rawValue)")
            async let archiveBytes = transport.request("/api/archives/\(kind.rawValue)")
            let decoder = JSONDecoder()
            let bytes = try await currentBytes
            records = kind == .minutes ? try decoder.decode(MinutesList.self, from: bytes).minutes : try decoder.decode(TreasuryList.self, from: bytes).reports
            records = records.filter { ["ready_for_distribution", "distributed", "approved_by_lodge"].contains($0.status) }
            archives = try decoder.decode(ArchiveList.self, from: await archiveBytes).records
            if let selectedID, selectedID.hasPrefix("current:"), !records.contains(where: { "current:\($0.id)" == selectedID }) { self.selectedID = nil; pdf = nil }
            if let selectedID, selectedID.hasPrefix("archive:"), !archives.contains(where: { "archive:\($0.id)" == selectedID }) { self.selectedID = nil; pdf = nil }
            message = ""
        } catch { message = error.localizedDescription }
    }
    private func open(_ id: String) async {
        do {
            let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { throw ClientError.invalidResponse }
            let endpoint = parts[0] == "archive" ? "/api/archives/\(kind.rawValue)/\(parts[1])/pdf" : "/api/\(kind.rawValue)/\(parts[1])/pdf"
            let bytes = try await transport.request(endpoint)
            guard selectedID == id else { return }
            guard PDFDocument(data: bytes) != nil else { throw ClientError.invalidResponse }
            pdf = bytes; message = ""
        } catch { if selectedID == id { message = error.localizedDescription } }
    }
}
