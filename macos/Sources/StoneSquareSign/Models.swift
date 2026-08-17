import Foundation

struct User: Codable, Identifiable, Equatable {
    let id: Int
    let email: String
    let name: String
    let role: String
    let phone: String?
    let hasSignature: Bool

    var roleLabel: String {
        switch role {
        case "owner": return "Document Owner"
        case "secretary": return "Secretary"
        case "assistant_secretary": return "Assistant Secretary"
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

    var displayTitle: String { title?.isEmpty == false ? title! : originalName }
    var isComplete: Bool { status == "completed" }
}

struct Officer: Codable, Identifiable {
    var id: String { role }
    let role: String
    let name: String
    let email: String
    let phone: String?
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

enum AppSection: Hashable { case documents, access, profile, settings }
