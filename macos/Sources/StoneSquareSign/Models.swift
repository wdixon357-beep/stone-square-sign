import Foundation

enum LodgeDateTime {
    static func display(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "Not recorded" }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        guard let date = fractional.date(from: value) ?? standard.date(from: value) else { return value }
        let output = DateFormatter()
        output.locale = Locale(identifier: "en_US")
        output.timeZone = TimeZone(identifier: "America/New_York")
        output.dateFormat = "EEEE, MMMM d, yyyy 'at' h:mm a z"
        return output.string(from: date)
    }
}

struct User: Codable, Identifiable, Equatable {
    let id: Int
    let email: String
    let name: String
    let role: String
    let hasSignature: Bool
    var treasuryAccess: String? = nil
    var permissions: [String]? = nil
    func can(_ capability: String) -> Bool {
        if role == "owner" { return true }
        if let permissions { return permissions.contains(capability) }
        // Compatibility with older sessions; a server-supplied list always takes precedence.
        var defaults = ["reports.create", "minutes.view", "treasury.view", "signature.manage", "settings.manage"]
        switch role {
        case "secretary": defaults += ["minutes.prepare", "treasury.prepare", "treasury.upload", "dues.self", "dues.ledger", "dues.manage", "suggestions.create", "documents.status", "documents.sign", "candidates.view"]
        case "assistant_secretary": defaults += ["minutes.prepare", "treasury.prepare", "dues.self", "dues.ledger", "dues.manage", "suggestions.create", "documents.status", "documents.sign", "candidates.view"]
        case "treasurer": defaults = ["reports.create", "minutes.view", "treasury.view", "treasury.prepare", "treasury.upload", "dues.self", "suggestions.create", "signature.manage", "settings.manage"]
        case "assistant_treasurer", "treasury_preparer": defaults = ["reports.create", "minutes.view", "treasury.view", "treasury.prepare", "dues.self", "suggestions.create", "signature.manage", "settings.manage"]
        case "warden": defaults += ["dues.self", "dues.ledger", "suggestions.create", "documents.status", "candidates.view", "proposals.create"]
        case "member": defaults = ["reports.create", "minutes.view", "treasury.view", "dues.self", "suggestions.create", "settings.manage"]
        case "officer": break
        default: break
        }
        if role != "member" { defaults += ["calendar.view", "building.request"] }
        if ["secretary", "assistant_secretary", "warden"].contains(role) { defaults.append("building.view") }
        return defaults.contains(capability)
    }
    var canSign: Bool { can("signature.manage") }
    var canUseTreasury: Bool { can("treasury.view") || can("treasury.prepare") || can("treasury.upload") }
    var canReadMinutes: Bool { can("minutes.view") || can("minutes.prepare") }
    var canReadDues: Bool { can("dues.ledger") }
    var canReadApprovals: Bool { ["owner", "secretary", "assistant_secretary", "viewer"].contains(role) && can("documents.status") }
    var canPrepareCorrespondence: Bool { ["owner", "secretary", "assistant_secretary"].contains(role) && can("reports.create") }
    var canProposeDispensation: Bool { can("proposals.create") }
    var showsPersonalProposals: Bool { role != "owner" && canProposeDispensation }
    var proposalWorkspaceTitle: String { role == "owner" ? "Warden Proposals" : "My Dispensation Proposals" }
    func canOpen(_ section: AppSection?) -> Bool {
        switch section {
        case .home, nil: return true
        case .reportGenerator: return can("reports.create")
        case .correspondence: return canPrepareCorrespondence
        case .receivedReports: return role == "owner"
        case .minutes: return canReadMinutes
        case .agenda: return role == "owner"
        case .treasury: return canUseTreasury
        case .dues: return canReadDues
        case .myDues: return can("dues.self")
        case .suggestions: return can("suggestions.create")
        case .documents: return can("documents.status")
        case .approvals: return canReadApprovals
        case .candidateTracker: return can("candidates.view")
        case .proposalReview: return role == "owner" || canProposeDispensation
        case .building: return can("building.request") || can("building.view") || can("building.decide")
        case .lodgeCalendar: return can("calendar.view") || can("calendar.manage")
        case .profile: return canSign
        case .settings: return can("settings.manage")
        case .activity, .access, .memberAccess, .createDispensation: return role == "owner"
        }
    }

    var roleLabel: String { Self.roleLabel(for: role) }

    static func roleLabel(for role: String) -> String {
        switch role {
        case "owner": return "Worshipful Master / Administrator"
        case "secretary": return "Secretary"
        case "assistant_secretary": return "Assistant Secretary"
        case "treasurer": return "Treasurer"
        case "assistant_treasurer": return "Assistant Treasurer"
        case "treasury_preparer": return "Treasury Report Preparer"
        case "member": return "Lodge Member"
        case "warden": return "Warden"
        case "viewer": return "Lodge Viewer"
        case "officer": return "Lodge Officer"
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

struct SignInSession: Codable {
    let lifetimeDays: Int
    let expiresAt: String
    var title: String { "You will stay signed in for \(lifetimeDays) days on this Mac." }
    var explanation: String { "Your sign-in renews automatically when you use this Mac near the end of that period. Sign out when you are finished on a shared device." }
}
struct AuthResponse: Codable { let token: String; let user: User; var session: SignInSession? = nil }
struct MeResponse: Codable { let user: User; var session: SignInSession? = nil }
struct DocumentsResponse: Codable { let documents: [LodgeDocument] }
/* An invitation the Master has created that the officer has not taken up yet. Its own state,
 * distinct from having no invitation at all. */
struct PendingInvitation: Codable, Identifiable {
    var id: String { email }
    let role: String
    let name: String
    let email: String
    let expiresAt: String?
}

struct OfficersResponse: Codable {
    let officers: [Officer]
    let pending: [PendingInvitation]?
}

/* Where a seat stands: nobody invited, invited and waiting, or in and working. */
enum OfficerSeatState { case none, pending, active
    var label: String {
        switch self {
        case .active: return "Active"
        case .pending: return "Pending, invited and not signed in yet"
        case .none: return "Invitation needed"
        }
    }
}
struct InviteResponse: Codable { let inviteUrl: String; let emailSent: Bool; let expiresAt: String }
struct SignatureResponse: Codable { let message: String; let user: User }
struct MessageResponse: Codable { let message: String; var notificationWarnings: [String]? = nil }
struct SetupResponse: Codable { let needsOwnerSetup: Bool; let registrationMode: String; let emailDeliveryReady: Bool }
struct EmptyResponse: Codable { let ok: Bool }
struct UploadResponse: Codable {
    let document: UploadedDocument
    var notificationWarnings: [String]? = nil
}
struct UploadedDocument: Codable { let id: String }
struct APIError: Codable {
    let error: String
    var incidentReference: String? = nil
    var retryable: Bool? = nil
    var retryAfterSeconds: Int? = nil
}
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

enum AppSection: Hashable { case activity, approvals, home, building, lodgeCalendar, reportGenerator, correspondence, receivedReports, minutes, agenda, treasury, documents, candidateTracker, createDispensation, proposalReview, access, memberAccess, dues, myDues, suggestions, profile, settings }

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
    let rosterId: Int?
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

struct DuesPaymentLinks: Codable { let full: String; let custom: String }
struct MyDuesResponse: Codable { let duesYear: String; let rateCents: Int; let row: DuesRow; let paymentLinks: DuesPaymentLinks; let updatedAt: String }
struct SuggestionReceipt: Codable, Identifiable {
    var id: String { referenceCode }
    let referenceCode: String
    let category: String
    let subject: String
    let status: String
    let ownerResponse: String?
    let submittedAt: String
    let updatedAt: String
}
struct SuggestionsResponse: Codable { let suggestions: [SuggestionReceipt] }
struct SuggestionSubmitResponse: Codable { let reference: String; let status: String; let message: String }
struct OwnerSuggestion: Codable, Identifiable {
    let id: Int
    let referenceCode: String
    let category: String
    let subject: String
    let body: String
    let status: String
    let ownerResponse: String?
    let submittedAt: String
    let updatedAt: String
    let submittedBy: String
}
struct OwnerSuggestionsResponse: Codable { let suggestions: [OwnerSuggestion] }
struct MemberAccessRecord: Codable, Identifiable {
    let id:Int; let firstName:String; let lastName:String; let title:String?; let prefix:String?; let emails:[String]
    let userId:Int?; let accountEmail:String?; let accessRevokedAt:String?; let invitationId:Int?; let invitationEmail:String?; let expiresAt:String?
    var displayName:String { "\(prefix ?? "Bro.") \(firstName) \(lastName)" }
}
struct MemberAccessResponse: Codable { let members:[MemberAccessRecord] }

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


/* What the District Deputy decided about a dispensation, and how the decision arrived.
 *
 * Both dispensations the Lodge holds as approved have nothing in the approval block on the form:
 * no tick, no date, no signature. Both were granted by email. So the route matters as much as the
 * verdict, and a missing endorsed copy is said out loud rather than glossed over. */
struct DispensationApproval: Codable, Identifiable {
    let id: String
    let title: String?
    let originalName: String?
    let approvalStatus: String
    let approvedBy: String?
    let approvedOn: String?
    let approvalSource: String?
    let approvalNote: String?
    let hasEndorsedCopy: Bool?

    var displayTitle: String { title?.isEmpty == false ? title! : (originalName ?? "Dispensation") }
    var isApproved: Bool { approvalStatus == "approved" }
    var verdict: String {
        switch approvalStatus {
        case "approved": return "Approved"
        case "disapproved": return "Not approved"
        case "withdrawn": return "Withdrawn"
        default: return "Awaiting a decision"
        }
    }
    var route: String {
        switch approvalSource {
        case "endorsed_pdf": return "endorsed copy returned"
        case "email": return "given by email"
        case "text_message": return "given by text message"
        case "verbal": return "given verbally"
        default: return "route not recorded"
        }
    }
}

// MARK: - Warden proposals
// Xavier White and Jamal Sadler propose a dispensation; the Worshipful Master decides.
// Both clients provide proposal preparation and the Master's review.

struct WardenProposal: Codable, Identifiable {
    let id: String
    let proposerName: String
    let status: String
    let requestDate: String?
    let eventDate: String?
    let requestDetails: String?
    let eventTime: String?
    let locationName: String?
    let streetAddress: String?
    let cityState: String?
    let title: String?
    let proposerNote: String?
    let wmNote: String?
    let createdAt: String?
    let resultingDocumentId: String?
    var document: ProposalDocumentStatus? = nil

    var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        if let d = requestDetails, !d.isEmpty { return String(d.prefix(80)) }
        return "Proposed dispensation"
    }
    var isPending: Bool { status == "pending" || status == "changes_requested" }
    var verdict: String {
        switch status {
        case "approved": return "Approved"
        case "declined": return "Not approved"
        case "changes_requested": return "Sent back for changes"
        default: return "Waiting on the Master"
        }
    }
}

struct ProposalDocumentStatus: Codable {
    let status: String?
    let completedAt: String?
    let submittedAt: String?
    let submittedTo: String?
    let approvalStatus: String?
    let approvedOn: String?
}

struct DispensationProposalDraft: Codable, Equatable {
    var title = ""
    var requestDate = ""
    var eventDate = ""
    var eventTime = ""
    var requestDetails = ""
    var locationName = ""
    var streetAddress = ""
    var cityState = ""
    var proposerNote = ""
    var validationMessage: String? {
        if requestDetails.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Describe what you are requesting." }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        for value in [eventDate, requestDate].filter({ !$0.isEmpty }) {
            guard value.count == 10, let date = formatter.date(from: value), formatter.string(from: date) == value else { return "Enter dates as YYYY-MM-DD." }
        }
        if eventDate.isEmpty { return "Enter the event date." }
        for (label, value, limit) in [("Request details", requestDetails, 600), ("Title", title, 200), ("Event time", eventTime, 40), ("Location", locationName, 120), ("Street address", streetAddress, 120), ("City and state", cityState, 120), ("Note", proposerNote, 2000)] {
            if value.count > limit { return "\(label) must be \(limit) characters or fewer." }
        }
        return nil
    }
    var isReady: Bool { validationMessage == nil }
    var hasContent: Bool { self != Self() }
}

struct ProposalCreatedResponse: Decodable {
    struct Identifier: Decodable { let id: String }
    let proposal: Identifier
    var notificationWarnings: [String]? = nil
}

struct ProposalDecisionResponse: Decodable {
    var ok: Bool? = nil
    var notificationWarnings: [String]? = nil
}

struct ProposalsResponse: Codable { let proposals: [WardenProposal] }

struct ApprovalsResponse: Codable { let approvals: [DispensationApproval] }

struct MinutesReviewAlert: Decodable, Identifiable {
    let id: String
    let title: String
    let submittedBy: String
    var message: String? = nil
    var kind: String? = nil
}
struct MinutesReviewAlertsPayload: Decodable { let alerts: [MinutesReviewAlert] }
struct TreasuryAlert: Decodable, Identifiable {
    let id: String
    let title: String
    let message: String
    let uploadedBy: String
    let createdAt: String
}
struct TreasuryAlertsPayload: Decodable { let alerts: [TreasuryAlert] }
