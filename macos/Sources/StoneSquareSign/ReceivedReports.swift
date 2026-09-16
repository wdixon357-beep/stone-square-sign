import Foundation
import SwiftUI

private struct ReceivedReport: Codable, Identifiable {
    let id: String
    let externalId: String
    let type: String
    let title: String
    let filename: String
    let preparedBy: String
    let office: String
    let emailed: Bool
    let source: String
    let submittedAt: String
    let receivedAt: String
}

private struct ReceivedReportsPayload: Codable { let reports: [ReceivedReport] }

@MainActor
private final class ReceivedReportsModel: ObservableObject {
    @Published var reports: [ReceivedReport] = []
    @Published var selectedID: String?
    @Published var pdf: Data?
    @Published var busy = false
    @Published var error = ""
    private weak var appModel: AppModel?

    func configure(_ model: AppModel) { appModel = model }

    func load() async {
        guard let appModel else { return }
        busy = true
        defer { busy = false }
        do {
            let payload: ReceivedReportsPayload = try await appModel.request("/api/officer-reports")
            reports = payload.reports
            error = ""
        } catch { self.error = error.localizedDescription }
    }

    func open(_ report: ReceivedReport) async {
        guard let appModel, let base = appModel.baseURL, let token = appModel.webSessionToken,
              let url = URL(string: "/api/officer-reports/\(report.id)/pdf", relativeTo: base) else { return }
        busy = true
        defer { busy = false }
        do {
            var request = URLRequest(url: url)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("mac", forHTTPHeaderField: "X-Stone-Square-Client")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  data.starts(with: Data("%PDF-".utf8)) else { throw ClientError.invalidResponse }
            selectedID = report.id
            pdf = data
            error = ""
        } catch { self.error = error.localizedDescription }
    }

    func close() { selectedID = nil; pdf = nil }
}

struct ReceivedReportsView: View {
    @EnvironmentObject private var appModel: AppModel
    @StateObject private var model = ReceivedReportsModel()

    var body: some View {
        VStack(spacing: 0) {
            NativeWorkspaceHeader(title: "Received Reports", subtitle: "Reports submitted to the Worshipful Master", symbol: "tray.full.fill") {
                if model.selectedID != nil { Button("Close preview") { model.close() } }
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.load() } }
            }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).padding() }
            GeometryReader { available in
                if available.size.width < 760 {
                    Group {
                        if model.pdf != nil { reportPreview }
                        else { reportList }
                    }
                    .frame(width: available.size.width, height: available.size.height)
                    .clipped()
                } else {
                    HStack(spacing: 0) {
                        reportList.frame(width: min(max(available.size.width * 0.32, 260), 380))
                        Divider()
                        reportPreview.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .frame(width: available.size.width, height: available.size.height)
                    .clipped()
                }
            }
            if model.busy { ProgressView().padding(.bottom, 12) }
        }
        .task { model.configure(appModel); await model.load() }
    }

    private var reportList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(model.reports) { report in
                    Button { Task { await model.open(report) } } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(report.title).font(.headline).lineLimit(2)
                            Text("\(report.preparedBy), \(report.office)").font(.callout).foregroundStyle(.secondary).lineLimit(2)
                            Text(LodgeDateTime.display(report.submittedAt)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .background(model.selectedID == report.id ? Color.accentColor.opacity(0.16) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(12)
        }
    }

    @ViewBuilder private var reportPreview: some View {
        if model.pdf != nil {
            LodgeDocumentPreview(data: model.pdf)
        } else {
            ContentUnavailableView(model.reports.isEmpty ? "No reports received" : "Choose a report", systemImage: "doc.richtext", description: Text(model.reports.isEmpty ? "Submitted Lodge reports will appear here." : "The PDF will open inside the Dashboard."))
        }
    }
}
