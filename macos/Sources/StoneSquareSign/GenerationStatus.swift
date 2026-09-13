import Foundation
import SwiftUI

struct GenerationStatus: Decodable, Equatable {
    let configured: Bool
    let model: String?
    let monthlyLimitDollars: Double?
    let committedDollars: Double?
    let reservedDollars: Double?
    let remainingDollars: Double?

    var explanation: String {
        configured
            ? "Terra enabled. Creating or reorganizing a draft sends the source text to OpenAI for your review."
            : "Local organizer active. Terra setup is pending."
    }

    func explanation(forOwner: Bool) -> String {
        forOwner ? explanation : "Review the organized draft against your source before using it."
    }

    func allowance(forOwner: Bool) -> String? {
        guard forOwner, let remainingDollars, let monthlyLimitDollars else { return nil }
        let format = NumberFormatter()
        format.numberStyle = .currency
        format.locale = Locale(identifier: "en_US")
        format.currencyCode = "USD"
        guard let remaining = format.string(from: NSNumber(value: remainingDollars)),
              let limit = format.string(from: NSNumber(value: monthlyLimitDollars)) else { return nil }
        return "Estimated monthly allowance: \(remaining) remaining of \(limit)."
    }

    @MainActor static func load(using transport: MinutesWorkspace) async -> GenerationStatus? {
        do { return try JSONDecoder().decode(GenerationStatus.self, from: await transport.request("/api/generation/status")) }
        catch { return nil }
    }
}

struct GenerationStatusView: View {
    @EnvironmentObject var model: AppModel
    let status: GenerationStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(status?.explanation(forOwner: model.user?.role == "owner") ?? (model.user?.role == "owner" ? "Generation status unavailable." : "Review the draft against your source before using it."))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let allowance = status?.allowance(forOwner: model.user?.role == "owner") {
                Text(allowance).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
