import AppKit
import Foundation
import Security

enum ClientError: LocalizedError {
    case invalidServer
    case invalidResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidServer: return "Enter a valid signing service address."
        case .invalidResponse: return "The signing service returned an invalid response."
        case .server(let message): return message
        }
    }
}

enum TokenStore {
    private static let service = "com.dstechnology.stonesquare.sign"
    private static let account = "session-token"

    static func save(_ token: String) {
        delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(token.utf8),
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var user: User?
    @Published var documents: [LodgeDocument] = []
    @Published var officers: [Officer] = []
    @Published var isBusy = false
    @Published var isLive = false
    @Published var message = ""
    @Published var isError = false
    @Published var serverAddress: String {
        didSet { UserDefaults.standard.set(serverAddress, forKey: "server-address") }
    }

    private var token: String?
    private var liveTask: Task<Void, Never>?
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init() {
        serverAddress = UserDefaults.standard.string(forKey: "server-address") ?? "http://localhost:3000"
        token = TokenStore.load()
    }

    var baseURL: URL? {
        let cleaned = serverAddress.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: cleaned)
    }

    func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String = "application/json"
    ) async throws -> T {
        guard let baseURL, let url = URL(string: path, relativeTo: baseURL) else {
            throw ClientError.invalidServer
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? decoder.decode(APIError.self, from: data).error)
                ?? "Request failed with status \(http.statusCode)."
            throw ClientError.server(message)
        }
        return try decoder.decode(T.self, from: data)
    }

    func restoreSession() async {
        guard token != nil else { return }
        do {
            let response: MeResponse = try await request("/api/auth/me")
            user = response.user
            await refresh(silent: true)
            startLiveQueue()
        } catch {
            signOut(localOnly: true)
        }
    }

    func signIn(email: String, password: String) async {
        await perform {
            let body = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
            let response: AuthResponse = try await self.request("/api/auth/login", method: "POST", body: body)
            self.token = response.token
            TokenStore.save(response.token)
            self.user = response.user
            await self.refresh(silent: true)
            self.startLiveQueue()
        }
    }

    func createOwner(name: String, email: String, phone: String, password: String) async {
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "name": name, "email": email, "phone": phone, "password": password,
            ])
            let response: AuthResponse = try await self.request("/api/auth/register", method: "POST", body: body)
            self.token = response.token
            TokenStore.save(response.token)
            self.user = response.user
            await self.refresh(silent: true)
            self.startLiveQueue()
        }
    }

    func requestReset(phone: String) async {
        await perform {
            let body = try JSONSerialization.data(withJSONObject: ["phone": phone])
            let response: MessageResponse = try await self.request("/api/auth/forgot-password", method: "POST", body: body)
            self.message = response.message
        }
    }

    func resetPassword(phone: String, code: String, password: String) async {
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "phone": phone, "code": code, "newPassword": password,
            ])
            let response: MessageResponse = try await self.request("/api/auth/reset-password", method: "POST", body: body)
            self.message = response.message
        }
    }

    func refresh(silent: Bool = false) async {
        do {
            let response: DocumentsResponse = try await request("/api/documents")
            documents = response.documents
            if user?.role == "owner" {
                let officerResponse: OfficersResponse = try await request("/api/officers")
                officers = officerResponse.officers
            }
        } catch {
            if !silent { show(error) }
        }
    }

    func startLiveQueue() {
        liveTask?.cancel()
        liveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.token != nil {
                do {
                    guard let baseURL = self.baseURL,
                          let url = URL(string: "/api/events", relativeTo: baseURL) else {
                        throw ClientError.invalidServer
                    }
                    var request = URLRequest(url: url)
                    if let token = self.token {
                        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    }
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        throw ClientError.invalidResponse
                    }
                    self.isLive = true
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if line == "event: queue_changed" || line == "event: profile_changed" {
                            await self.refresh(silent: true)
                        }
                    }
                } catch {
                    self.isLive = false
                    if !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 2_500_000_000)
                    }
                }
            }
        }
    }

    func upload(url: URL) async {
        await perform {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let fileData = try Data(contentsOf: url)
            let boundary = "Boundary-\(UUID().uuidString)"
            var body = Data()
            func add(_ string: String) { body.append(Data(string.utf8)) }
            add("--\(boundary)\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\n\(url.deletingPathExtension().lastPathComponent)\r\n")
            add("--\(boundary)\r\nContent-Disposition: form-data; name=\"document\"; filename=\"\(url.lastPathComponent)\"\r\nContent-Type: application/pdf\r\n\r\n")
            body.append(fileData)
            add("\r\n--\(boundary)--\r\n")
            let _: UploadResponse = try await self.request(
                "/api/documents",
                method: "POST",
                body: body,
                contentType: "multipart/form-data; boundary=\(boundary)"
            )
            self.message = "Dispensation added to the live queue."
            await self.refresh(silent: true)
        }
    }

    func invite(name: String, email: String, phone: String, role: String) async -> InviteResponse? {
        var result: InviteResponse?
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "name": name, "email": email, "phone": phone, "role": role,
            ])
            result = try await self.request("/api/officers/invite", method: "POST", body: body)
            self.message = result?.emailSent == true ? "Invitation emailed." : "Invitation created. Copy the private link."
        }
        return result
    }

    func saveSignature(dataURL: String, type: String, style: String) async -> Bool {
        var success = false
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "signatureData": dataURL, "signatureType": type, "styleName": style,
            ])
            let response: SignatureResponse = try await self.request("/api/profile/signature", method: "PUT", body: body)
            self.user = response.user
            self.message = response.message
            success = true
        }
        return success
    }

    func signatureImage() async throws -> NSImage {
        guard let baseURL, let url = URL(string: "/api/profile/signature", relativeTo: baseURL) else {
            throw ClientError.invalidServer
        }
        var request = URLRequest(url: url)
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let image = NSImage(data: data) else {
            throw ClientError.server("The saved signature could not be loaded.")
        }
        return image
    }

    func sign(document: LodgeDocument) async -> Bool {
        var success = false
        await perform {
            let body = try JSONSerialization.data(withJSONObject: ["consent": true])
            let response: MessageResponse = try await self.request(
                "/api/documents/\(document.id)/sign", method: "POST", body: body
            )
            self.message = response.message
            success = true
            await self.refresh(silent: true)
        }
        return success
    }

    func open(document: LodgeDocument) async {
        await perform {
            guard let baseURL = self.baseURL,
                  let url = URL(string: "/api/documents/\(document.id)/file", relativeTo: baseURL) else {
                throw ClientError.invalidServer
            }
            var request = URLRequest(url: url)
            if let token = self.token {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw ClientError.server("The PDF could not be downloaded.")
            }
            let safeName = document.originalName.replacingOccurrences(of: "/", with: "_")
            let localURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(document.id)-\(safeName)")
            try data.write(to: localURL, options: .atomic)
            NSWorkspace.shared.open(localURL)
        }
    }

    func signOut(localOnly: Bool = false) {
        liveTask?.cancel()
        isLive = false
        if !localOnly {
            Task { let _: EmptyResponse? = try? await request("/api/auth/logout", method: "POST") }
        }
        token = nil
        TokenStore.delete()
        user = nil
        documents = []
        officers = []
    }

    private func perform(_ work: @escaping () async throws -> Void) async {
        isBusy = true
        message = ""
        isError = false
        defer { isBusy = false }
        do { try await work() } catch { show(error) }
    }

    private func show(_ error: Error) {
        message = error.localizedDescription
        isError = true
    }
}
