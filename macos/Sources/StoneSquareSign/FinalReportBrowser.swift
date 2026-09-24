import AppKit
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
    @State private var browserPane = 0
    @StateObject private var transport = MinutesWorkspace()
    var initialSelection: String? = nil
    var onClose: (() -> Void)? = nil
    private var selectedCurrentRecord: Record? {
        guard let selectedID, selectedID.hasPrefix("current:") else { return nil }
        return records.first { "current:\($0.id)" == selectedID }
    }
    private var mayRecordDistribution: Bool {
        kind == .minutes && selectedCurrentRecord?.status == "ready_for_distribution"
            && ["owner", "secretary", "assistant_secretary"].contains(model.user?.role ?? "")
    }
    private func displayLabel(_ record: Record) -> String {
        kind == .minutes ? MinutesDateText.minutesTitle(record.draft.meetingDate) : record.label
    }

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: kind.title, subtitle: "Read finalized and historical Lodge records", symbol: "doc.text") {
                if selectedID != nil { Button("Close report") { selectedID = nil; pdf = nil } }
                if let onClose { Button("Done") { onClose() } }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    reportActions
                    Spacer(minLength: 0)
                }
                VStack(alignment: .leading, spacing: 10) { reportActions }
            }
            .padding(.horizontal, 18).padding(.vertical, 10)
            if kind == .minutes, let newest = records.first {
                HStack(spacing: 16) {
                    Image(systemName: "checkmark.seal.fill").font(.title2).foregroundStyle(SignTheme.gold)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(["owner", "secretary", "assistant_secretary"].contains(model.user?.role ?? "") && newest.status == "ready_for_distribution"
                             ? "WM review complete, ready to send to the Craft"
                             : "Meeting minutes are available to view").font(.headline).foregroundStyle(SignTheme.navy)
                        Text("\(displayLabel(newest)) is signed and filed below.").font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("View signed minutes") { selectedID = "current:\(newest.id)" }.buttonStyle(.borderedProminent)
                }
                .padding(16)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(SignTheme.gold.opacity(0.7), lineWidth: 1))
                .padding(.horizontal, 18).padding(.top, 14)
            }
            AdaptiveWorkspaceSplit(primaryTitle: "Reports", secondaryTitle: "Document preview", compactPane: $browserPane) {
                List(selection: $selectedID) {
                    Section("Finalized in Dashboard") { ForEach(records) { record in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(displayLabel(record)).font(.headline).fixedSize(horizontal: false, vertical: true)
                            Text(kind == .minutes ? "Signed Lodge record · Prepared by \(record.createdBy)" : record.createdBy).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5).tag("current:\(record.id)")
                    } }
                    Section("Imported Lodge archive") { ForEach(archives) { record in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(record.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                            Text("Historical Lodge archive").font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5).tag("archive:\(record.id)")
                    } }
                }
            } secondary: {
                if pdf != nil { LodgeDocumentPreview(data: pdf) }
                else { ContentUnavailableView(records.isEmpty && archives.isEmpty ? "No reports available" : "Choose a report", systemImage: "doc.text").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }
            if loading { ProgressView().padding(8) }
            if !message.isEmpty { Text(message).font(.callout).padding(12) }
        }
        .task(id: kind) { transport.configure(model); await refresh(); if let initialSelection { selectedID = "current:\(initialSelection)" } }
        .onChange(of: model.minutesRecordsRevision) { _, _ in if kind == .minutes { Task { await refresh() } } }
        .onChange(of: model.treasuryRecordsRevision) { _, _ in if kind == .treasury { Task { await refresh() } } }
        .onChange(of: selectedID) { _, id in pdf = nil; if let id { browserPane = 1; Task { await open(id) } } }
    }
    @ViewBuilder private var reportActions: some View {
        Button("Refresh") { Task { await refresh() } }.disabled(loading)
        Button(kind == .minutes ? "Save PDF for email" : "Save PDF") { if let pdf { saveDocument(pdf, name: "\(selectedCurrentRecord.map(displayLabel) ?? kind.title).pdf", type: .pdf) } }.disabled(pdf == nil)
        if kind == .minutes {
            Button("Share signed PDF") { if let pdf { shareMinutesPDF(pdf, name: selectedCurrentRecord.map(displayLabel) ?? "Meeting Minutes") } }.disabled(pdf == nil)
        }
        if mayRecordDistribution { Button("Mark as sent to the Craft") { Task { await markDistributed() } }.disabled(loading) }
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
    private func markDistributed() async {
        guard let record = selectedCurrentRecord else { return }
        let confirmation = NSAlert()
        confirmation.messageText = "Mark these minutes as sent to the Craft?"
        confirmation.informativeText = "Use this only after the signed PDF has actually been distributed."
        confirmation.addButton(withTitle: "Mark as sent")
        confirmation.addButton(withTitle: "Cancel")
        guard confirmation.runModal() == .alertFirstButtonReturn else { return }
        loading = true; defer { loading = false }
        do {
            _ = try await transport.request("/api/minutes/\(record.id)/mark-distributed", method: "POST", body: Data("{}".utf8))
            await refresh()
            message = "Distribution to the Craft has been recorded."
        } catch { message = error.localizedDescription }
    }
}

@MainActor
private func shareMinutesPDF(_ data: Data, name: String) {
    let safeName = name.replacingOccurrences(of: "/", with: "-")
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(safeName).pdf")
    do {
        try data.write(to: url, options: .atomic)
        guard let view = NSApp.keyWindow?.contentView else { throw ClientError.invalidResponse }
        NSSharingServicePicker(items: [url]).show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    } catch {
        let alert = NSAlert(); alert.messageText = "The signed PDF could not be shared."; alert.informativeText = error.localizedDescription; alert.runModal()
    }
}
