import Foundation

struct User: Codable, Identifiable, Equatable {
    let id: Int
    let email: String
    let name: String
    let role: String
    let hasSignature: Bool

    var roleLabel: String {
        switch role {
        case "owner": return "Worshipful Master / Administrator"
        case "secretary": return "Secretary"
        case "assistant_secretary": return "Assistant Secretary"
        case "viewer": return "Lodge Viewer"
        default: return "Signer"
        }
    }
}

struct Signer: Codable, Identifiable {
    let id: Int
    let userId: Int?
    let signerRole: String
    let signerName: String
    let signedAt: String?
}

struct LodgeDocument: Codable, Identifiable {
    let id: String
    let title: String?
    let originalName: String
    let status: String
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
    let ownerName: String?
    let ownerEmail: String?
    let signers: [Signer]
    let needsSignature: Bool
    /* Optional because a viewer's copy of a document deliberately leaves them out. */
    let templateKind: String?
    let submittedAt: String?
    let submittedTo: String?
    let submittedError: String?

    var displayTitle: String { title?.isEmpty == false ? title! : originalName }
    var isComplete: Bool { status == "completed" }
    var isRescinded: Bool { status == "rescinded" }
    var isTerminal: Bool { isComplete || isRescinded }
    var isDispensation: Bool { templateKind == "dispensation_v1" }
    /* A signed dispensation is not finished until the District Deputy has it. */
    var awaitsDistrictDeputy: Bool { isComplete && isDispensation && submittedAt == nil }
}

struct Officer: Codable, Identifiable {
    var id: String { email }
    let role: String
    let name: String
    let email: String
}

struct AuthResponse: Codable { let token: String; let user: User }
struct MeResponse: Codable { let user: User }
struct DocumentsResponse: Codable { let documents: [LodgeDocument] }
struct OfficersResponse: Codable { let officers: [Officer] }
struct InviteResponse: Codable { let inviteUrl: String; let emailSent: Bool; let expiresAt: String }
struct SignatureResponse: Codable { let message: String; let user: User }
struct MessageResponse: Codable { let message: String }
struct EmptyResponse: Codable { let ok: Bool }
struct UploadResponse: Codable { let document: UploadedDocument }
struct UploadedDocument: Codable { let id: String }
struct APIError: Codable { let error: String }
struct VersionResponse: Codable { let version: String }

struct CandidateRecord: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var category: String
    var phone: String
    var email: String
    var status: String
    var owner: String
    var lastContacted: String
    var nextStep: String
    var targetDate: String
    var instructor: String
    var notes: String
    var source: String
    var updatedAt: String?
    var updatedBy: String?

    static func blank(category: String) -> CandidateRecord {
        CandidateRecord(
            id: "", name: "", category: category, phone: "", email: "",
            status: "New", owner: "", lastContacted: "", nextStep: "",
            targetDate: "", instructor: "", notes: "", source: "Manual entry",
            updatedAt: nil, updatedBy: nil
        )
    }
}

struct CandidateRecordsResponse: Codable { let records: [CandidateRecord] }
struct SubmissionProfile: Codable, Identifiable {
    var id: String { role }
    let role: String
    let name: String
    let address: String
}
struct SubmissionProfilesResponse: Codable { let profiles: [SubmissionProfile] }
struct ParsedDispensationFields: Codable {
    let title: String
    let requestDate: String
    let signerRole: String
    let requestDetails: String
    let eventDate: String
    let eventTime: String
    let locationName: String
    let streetAddress: String
    let cityState: String
    let worshipfulMasterAddress: String
    let secretaryAddress: String
}
struct ParsedDispensationResponse: Codable {
    let fields: ParsedDispensationFields
    let warnings: [String]
}
struct LocationMatch: Codable, Identifiable {
    let displayName: String
    let streetAddress: String
    let cityState: String
    var id: String { "\(displayName)|\(streetAddress)|\(cityState)" }
}
struct LocationSearchResponse: Codable { let matches: [LocationMatch] }

enum AppSection: Hashable { case home, documents, candidateTracker, createDispensation, access, dues, profile, settings }

// MARK: - Dues
// Mirrors the /api/dues payload. Restricted server side to the Worshipful Master,
// the Secretary and the Assistant Secretary; the sidebar hides it for anyone else so
// no locked door is dangled in front of a viewer.

struct DuesPayment: Codable, Hashable {
    let dateISO: String
    let amountCents: Int
    let campaign: String
    let matchedVia: String
}

struct DuesRow: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let title: String?
    let assessedCents: Int
    let paidCents: Int
    let remainingCents: Int
    let creditCents: Int
    let status: String
    let payments: [DuesPayment]
    let lastPaymentISO: String?
}

struct DuesUnmatched: Codable, Identifiable, Hashable {
    var id: String { "\(dateISO)-\(buyerEmail)-\(amountCents)" }
    let dateISO: String
    let amountCents: Int
    let buyerName: String
    let buyerEmail: String
}

struct DuesStaleCampaign: Codable, Hashable { let count: Int; let totalCents: Int }

struct DuesTotals: Codable, Hashable {
    let assessedCents: Int
    let collectedCents: Int
    let outstandingCents: Int
    let paidCount: Int
    let partialCount: Int
    let unpaidCount: Int
}

struct DuesLedger: Codable {
    let duesYear: String
    let rateCents: Int
    let rows: [DuesRow]
    let unmatched: [DuesUnmatched]
    let staleCampaign: DuesStaleCampaign?
    let totals: DuesTotals
}

func lodgeMoney(_ cents: Int) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    return formatter.string(from: NSNumber(value: Double(cents) / 100)) ?? "$0.00"
}


/* The note to the District Deputy, composed by the server so the copy it sends itself and the
 * draft the Master opens in his own mail client are word for word the same. */
struct SubmissionDraft: Codable {
    let to: String
    let name: String
    let filename: String
    let subject: String
    let body: String
    let alreadySent: String?
}

struct SubmissionDraftResponse: Codable { let draft: SubmissionDraft }
