import AppKit
import SwiftUI
import PDFKit

struct FinalReportBrowserView: View {
    enum Kind: String { case minutes, treasury
        var title: String { self == .minutes ? "Meeting Minutes" : "Treasurer Reports" }
    }
    struct Record: Decodable, Identifiable {
        struct Draft: Decodable {
            struct Account: Decodable { let id: String; let name: String }
            struct Transaction: Decodable {
                let date: String; let account: String; let kind: String
                let description: String; let amount: String?; let reference: String; let postedDateConfirmed: Bool?
            }
            let meetingDate: String?; let periodStart: String?; let periodEnd: String?
            let accounts: [Account]?; let transactions: [Transaction]?
        }
        let id: String; let status: String; let createdBy: String; let draft: Draft; let submittedDraft: Draft?
        var label: String { draft.meetingDate ?? draft.periodEnd ?? "Finalized report" }
        var signedDraft: Draft { submittedDraft ?? draft }
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
    private func transactionType(_ kind: String) -> String {
        switch kind {
        case "receipt": return "Receipt"
        case "payment": return "Disbursement"
        case "transfer_in": return "Transfer in"
        case "transfer_out": return "Transfer out"
        default: return "Type not provided"
        }
    }
    private func transactionAmount(_ transaction: Record.Draft.Transaction) -> String {
        guard let value = transaction.amount?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return "Amount not provided" }
        let unsigned = value.trimmingCharacters(in: CharacterSet(charactersIn: "+-$− "))
        let direction = ["payment", "transfer_out"].contains(transaction.kind) ? "−" : "+"
        return "\(direction)$\(unsigned)"
    }
    @ViewBuilder private var treasuryActivity: some View {
        if kind == .treasury, let record = selectedCurrentRecord {
            let draft = record.signedDraft
            let entries = (draft.transactions ?? []).filter { transaction in
                transaction.postedDateConfirmed == true && !transaction.date.isEmpty
                    && (draft.periodStart.map { transaction.date >= $0 } ?? true)
                    && (draft.periodEnd.map { transaction.date <= $0 } ?? true)
            }.enumerated().sorted {
                $0.element.date == $1.element.date ? $0.offset < $1.offset : $0.element.date < $1.element.date
            }.map(\.element)
            let accountNames = (draft.accounts ?? []).reduce(into: [String: String]()) { names, account in
                names[account.id] = account.name
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Transactions in this signed report").font(.headline)
                    Spacer(minLength: 8)
                    Text("\(entries.count)").font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(SignTheme.gold.opacity(0.2), in: Capsule())
                }
                if entries.isEmpty {
                    Text("This signed report has no itemized transactions. The totals alone do not show whether bank activity occurred.")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(entries.indices, id: \.self) { index in
                                let entry = entries[index]
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                                        Text(entry.date.isEmpty ? "Date not provided" : LodgeCalendarDates.displayDate(entry.date))
                                            .font(.subheadline.weight(.semibold))
                                        Spacer(minLength: 8)
                                        Text(transactionAmount(entry)).font(.subheadline.monospacedDigit().weight(.semibold))
                                    }
                                    Text(entry.description.isEmpty ? "Description not provided" : entry.description)
                                        .font(.body).fixedSize(horizontal: false, vertical: true)
                                    Text("\(accountNames[entry.account] ?? "Account not provided") · \(transactionType(entry.kind))")
                                        .font(.caption).foregroundStyle(.secondary)
                                    if !entry.reference.isEmpty {
                                        Text("Reference: \(entry.reference)").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 8)
                                if index < entries.count - 1 { Divider() }
                            }
                        }
                    }
                    .frame(maxHeight: 190)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        }
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
                VStack(spacing: 8) {
                    treasuryActivity
                    if pdf != nil { LodgeDocumentPreview(data: pdf) }
                    else { ContentUnavailableView(records.isEmpty && archives.isEmpty ? "No reports available" : "Choose a report", systemImage: "doc.text").frame(maxWidth: .infinity, maxHeight: .infinity) }
                }
                .padding(8)
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
