import AppKit
import Foundation

import LocalAuthentication
import Security

/// The hosted service. This used to default to localhost, which only worked while a
/// server happened to be running on this Mac and left the app dead for everyone else.
let defaultServerAddress = "https://stone-square-sign.onrender.com"

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

private struct TrackerHandoffResponse: Decodable {
    let url: String
}

enum TokenStore {
    private static var fileURL: URL? {
        guard let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else { return nil }
        let directory = applicationSupport.appendingPathComponent("Stone Square Sign", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        return directory.appendingPathComponent("session", isDirectory: false)
    }

    static func save(_ token: String) {
        guard let fileURL else { return }
        try? Data(token.utf8).write(to: fileURL, options: [.atomic, .completeFileProtection])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    static func load() -> String? {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
}

enum BiometricCredentialError: LocalizedError {
    case unavailable
    case storage(OSStatus)
    case missing

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Touch ID is not available on this Mac."
        case .storage: return "The secure Keychain login could not be saved."
        case .missing: return "No Touch ID login is saved. Sign in with your password and enable it again."
        }
    }
}

enum BiometricCredentialStore {
    private static let service = "com.dstechnology.stonesquare.sign.biometric.v2"
    private static let legacyService = "com.dstechnology.stonesquare.sign.biometric.v1"
    private static let account = "session-token"

    static var isAvailable: Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }

    static func save(_ token: String) throws {
        delete(service: service)
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .biometryCurrentSet,
            &accessError
        ) else {
            throw BiometricCredentialError.storage(errSecParam)
        }
        var query = baseQuery(service: service)
        query[kSecAttrAccessControl as String] = accessControl
        query[kSecValueData as String] = Data(token.utf8)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw BiometricCredentialError.storage(status) }
    }

    static func load() async throws -> String {
        let context = LAContext()
        context.localizedCancelTitle = "Use Password"
        let authenticated = try await context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: "Sign in to Stone Square Sign"
        )
        guard authenticated else { throw BiometricCredentialError.unavailable }
        do {
            return try read(service: service, context: context)
        } catch BiometricCredentialError.missing {
            // Existing installations stored the token in the v1 item. Read it only
            // after successful Touch ID, then migrate it to a biometry-bound item.
            let token = try read(service: legacyService, context: context)
            do {
                try save(token)
                delete(service: legacyService)
            } catch {
                // Preserve the authenticated legacy item when migration cannot be
                // completed so an existing owner is not locked out mid-upgrade.
            }
            return token
        }
    }

    private static func read(service: String, context: LAContext) throws -> String {
        var query = baseQuery(service: service)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = context
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { throw BiometricCredentialError.missing }
        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw BiometricCredentialError.storage(status)
        }
        return token
    }

    static func delete() {
        delete(service: service)
        delete(service: legacyService)
    }

    private static func delete(service: String) {
        SecItemDelete(baseQuery(service: service) as CFDictionary)
    }

    private static func baseQuery(service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var user: User?
    @Published var documents: [LodgeDocument] = []
    @Published var officers: [Officer] = []
    @Published var pendingInvitations: [PendingInvitation] = []
    @Published var submissionProfiles: [SubmissionProfile] = []
    @Published var candidateRecords: [CandidateRecord] = []
    @Published var candidateTrackerLoading = false
    @Published var isBusy = false
    @Published var isLive = false
    @Published var dues: DuesLedger?
    @Published var duesLoading = false
    @Published var duesError: String?
    @Published var availableUpdateVersion: String?
    @Published var biometricLoginEnabled: Bool
    @Published var biometricLoginAvailable: Bool
    @Published var message = ""
    @Published var isError = false
    @Published var requestedSection: AppSection?
    @Published var serverAddress: String {
        didSet { UserDefaults.standard.set(serverAddress, forKey: "server-address") }
    }

    private var token: String?
    private var liveTask: Task<Void, Never>?
    private var updateTask: Task<Void, Never>?
    private var candidateTrackerAuthenticated = false
    private var dismissedUpdateVersion = UserDefaults.standard.string(forKey: "dismissed-update-version")
    private let candidateTrackerBaseURL = URL(string: "https://tracker.stonesquare22pha.org/")!
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init() {
        serverAddress = UserDefaults.standard.string(forKey: "server-address") ?? defaultServerAddress
        biometricLoginEnabled = UserDefaults.standard.bool(forKey: "biometric-login-enabled")
        biometricLoginAvailable = BiometricCredentialStore.isAvailable
        /* Always restore the session. Throwing it away when Touch ID is on meant every quit
         * became a fresh sign in, and the Keychain read that was supposed to replace it fails
         * whenever the app is rebuilt, because an ad hoc signature changes every build and the
         * Keychain no longer recognises the app that owns the item. Touch ID is now a convenience
         * on top of a session that persists, not the only way back in. */
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

    /// Dues. The server refuses anyone who is not the Worshipful Master or a Secretary,
    /// so a failure here is reported rather than swallowed; a silent empty ledger would
    /// read as "nobody owes anything", which is the worst possible wrong answer.
    @MainActor
    func loadDues() async {
        duesError = nil
        duesLoading = true
        defer { duesLoading = false }
        do {
            dues = try await request("/api/dues")
        } catch ClientError.server(let message) {
            duesError = message
        } catch {
            duesError = error.localizedDescription
        }
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
            try self.saveLogin(response.token)
            self.user = response.user
            await self.refresh(silent: true)
            self.startLiveQueue()
        }
    }

    func signInWithBiometrics() async {
        await perform {
            guard self.biometricLoginEnabled else { throw BiometricCredentialError.missing }
            do {
                self.token = try await BiometricCredentialStore.load()
            } catch {
                /* Usually the app was rebuilt and the Keychain no longer trusts the new
                 * signature, which is what produces the "enter your login keychain password"
                 * box. Clear the dead item so it stops asking on every launch. */
                BiometricCredentialStore.delete()
                self.biometricLoginEnabled = false
                UserDefaults.standard.set(false, forKey: "biometric-login-enabled")
                throw ClientError.server(
                    "Touch ID could not be used and has been switched off. Sign in with your password, then turn Touch ID back on in Service Settings.")
            }
            let response: MeResponse = try await self.request("/api/auth/me")
            self.user = response.user
            await self.refresh(silent: true)
            self.startLiveQueue()
        }
    }

    func setBiometricLogin(enabled: Bool) async {
        await perform {
            if enabled {
                guard self.biometricLoginAvailable else { throw BiometricCredentialError.unavailable }
                guard let token = self.token else { throw BiometricCredentialError.missing }
                try BiometricCredentialStore.save(token)
                self.biometricLoginEnabled = true
                UserDefaults.standard.set(true, forKey: "biometric-login-enabled")
                self.message = "Touch ID and Keychain login are enabled."
            } else {
                if let token = self.token { TokenStore.save(token) }
                BiometricCredentialStore.delete()
                self.biometricLoginEnabled = false
                UserDefaults.standard.set(false, forKey: "biometric-login-enabled")
                self.message = "Touch ID and Keychain login are disabled."
            }
        }
    }

    func createOwner(name: String, email: String, password: String) async {
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "name": name, "email": email, "password": password,
            ])
            let response: AuthResponse = try await self.request("/api/auth/register", method: "POST", body: body)
            self.token = response.token
            try self.saveLogin(response.token)
            self.user = response.user
            await self.refresh(silent: true)
            self.startLiveQueue()
        }
    }

    func requestReset(email: String) async {
        await perform {
            let body = try JSONSerialization.data(withJSONObject: ["email": email])
            let response: MessageResponse = try await self.request("/api/auth/forgot-password", method: "POST", body: body)
            self.message = response.message
        }
    }

    func resetPassword(email: String, code: String, password: String) async {
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "email": email, "code": code, "newPassword": password,
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
                pendingInvitations = officerResponse.pending ?? []
                let profileResponse: SubmissionProfilesResponse = try await request("/api/submission-profiles")
                submissionProfiles = profileResponse.profiles
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

    func startUpdateChecks() {
        updateTask?.cancel()
        updateTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.checkForUpdate()
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
    }

    func checkForUpdate() async {
        do {
            let response: VersionResponse = try await request("/api/version")
            let currentVersion = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "0"
            let isNewer = response.version.compare(currentVersion, options: .numeric) == .orderedDescending
            availableUpdateVersion = isNewer && response.version != dismissedUpdateVersion
                ? response.version
                : nil
        } catch {
            // The normal connection status already reports service interruptions.
        }
    }

    func dismissAvailableUpdate() {
        guard let version = availableUpdateVersion else { return }
        dismissedUpdateVersion = version
        UserDefaults.standard.set(version, forKey: "dismissed-update-version")
        availableUpdateVersion = nil
        message = "Update notice dismissed. Install only a signed and notarized Stone Square Sign release."
        isError = false
    }

    func upload(url: URL) async {
        guard user?.role == "owner" else {
            message = "This account has status-only document access."
            isError = true
            return
        }
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

    /* Opens a document already waiting on one Secretary to the other one as well.
     * Needed for anything sent before the Master could choose, and for the case where
     * the man it went to is away and the Lodge needs it signed today. */
    func offerToBothSecretaries(documentId: String) async -> Bool {
        guard user?.role == "owner" else {
            message = "This account cannot change who may sign a document."
            isError = true
            return false
        }
        var success = false
        await perform {
            let response: MessageResponse = try await self.request(
                "/api/documents/\(documentId)/offer-to-both", method: "POST", body: Data("{}".utf8))
            self.message = response.message
            await self.refresh(silent: true)
            success = true
        }
        return success
    }

    /* Sends, or re-sends, a completed dispensation to the District Deputy for review. */
    func submitToDistrictDeputy(documentId: String, resend: Bool = false) async -> Bool {
        guard user?.role == "owner" else {
            message = "This account cannot submit documents."
            isError = true
            return false
        }
        var success = false
        await perform {
            let body = try JSONSerialization.data(withJSONObject: ["resend": resend])
            let response: MessageResponse = try await self.request(
                "/api/documents/\(documentId)/submit", method: "POST", body: body)
            self.message = response.message
            await self.refresh(silent: true)
            success = true
        }
        return success
    }

    func createDispensation(
        title: String,
        requestDate: String,
        signerRoles: [String],
        requestDetails: String,
        eventDate: String,
        eventTime: String,
        locationName: String,
        streetAddress: String,
        cityState: String,
        worshipfulMasterAddress: String,
        personalInfoConfirmed: Bool
    ) async -> Bool {
        guard user?.role == "owner" else {
            message = "This account cannot create dispensations."
            isError = true
            return false
        }
        var success = false
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "title": title,
                "requestDate": requestDate,
                "signerRoles": signerRoles,
                "requestDetails": requestDetails,
                "eventDate": eventDate,
                "eventTime": eventTime,
                "locationName": locationName,
                "streetAddress": streetAddress,
                "cityState": cityState,
                "worshipfulMasterAddress": worshipfulMasterAddress,
                "personalInfoConfirmed": personalInfoConfirmed,
            ])
            let _: UploadResponse = try await self.request("/api/dispensations", method: "POST", body: body)
            self.message = "Dispensation created from the official template and added to the queue."
            await self.refresh(silent: true)
            success = true
        }
        return success
    }

    func previewDispensation(
        title: String,
        requestDate: String,
        signerRoles: [String],
        requestDetails: String,
        eventDate: String,
        eventTime: String,
        locationName: String,
        streetAddress: String,
        cityState: String,
        worshipfulMasterAddress: String,
        personalInfoConfirmed: Bool
    ) async -> Data? {
        var previewData: Data?
        await perform {
            guard let baseURL = self.baseURL,
                  let url = URL(string: "/api/dispensations/preview", relativeTo: baseURL) else {
                throw ClientError.invalidServer
            }
            let body = try JSONSerialization.data(withJSONObject: [
                "title": title,
                "requestDate": requestDate,
                "signerRoles": signerRoles,
                "requestDetails": requestDetails,
                "eventDate": eventDate,
                "eventTime": eventTime,
                "locationName": locationName,
                "streetAddress": streetAddress,
                "cityState": cityState,
                "worshipfulMasterAddress": worshipfulMasterAddress,
                "personalInfoConfirmed": personalInfoConfirmed,
            ])
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token = self.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                throw ClientError.server(object?["error"] as? String ?? "The PDF preview could not be created.")
            }
            previewData = data
        }
        return previewData
    }

    func parseDispensationText(_ text: String) async -> ParsedDispensationResponse? {
        var result: ParsedDispensationResponse?
        await perform {
            let body = try JSONSerialization.data(withJSONObject: ["text": text])
            result = try await self.request("/api/dispensations/parse", method: "POST", body: body)
        }
        return result
    }

    func searchLocation(name: String, cityState: String) async -> LocationMatch? {
        var match: LocationMatch?
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "locationName": name,
                "cityState": cityState,
            ])
            let response: LocationSearchResponse = try await self.request(
                "/api/locations/search", method: "POST", body: body
            )
            guard let first = response.matches.first else {
                throw ClientError.server("No matching address was found. Add a city or ZIP code and try again.")
            }
            match = first
        }
        return match
    }

    func candidateTrackerSignInURL() async -> URL? {
        do {
            let response: TrackerHandoffResponse = try await request(
                "/api/tracker/handoff",
                method: "POST"
            )
            guard let url = URL(string: response.url) else {
                throw ClientError.invalidResponse
            }
            return url
        } catch {
            show(error)
            return nil
        }
    }

    func loadCandidateRecords(silent: Bool = false) async {
        if silent && candidateTrackerLoading { return }
        if !silent { candidateTrackerLoading = true }
        defer { if !silent { candidateTrackerLoading = false } }
        do {
            let data = try await candidateTrackerRequest(path: "/api/records")
            candidateRecords = try decoder.decode(CandidateRecordsResponse.self, from: data).records
        } catch {
            if !silent { show(error) }
        }
    }

    func saveCandidateRecord(_ record: CandidateRecord, isNew: Bool) async -> Bool {
        guard user?.role == "owner" else {
            message = "Candidate Tracker is read only for this account."
            isError = true
            return false
        }
        var saved = false
        candidateTrackerLoading = true
        defer { candidateTrackerLoading = false }
        do {
            let body = try JSONEncoder().encode(record)
            _ = try await candidateTrackerRequest(
                path: "/api/records",
                method: isNew ? "POST" : "PATCH",
                body: body
            )
            let refreshed = try await candidateTrackerRequest(path: "/api/records")
            candidateRecords = try decoder.decode(CandidateRecordsResponse.self, from: refreshed).records
            message = isNew ? "Candidate record added." : "Candidate record updated."
            isError = false
            saved = true
        } catch {
            show(error)
        }
        return saved
    }

    private func candidateTrackerRequest(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        mayRetry: Bool = true
    ) async throws -> Data {
        if !candidateTrackerAuthenticated {
            guard let signInURL = await candidateTrackerSignInURL() else {
                throw ClientError.server(message.isEmpty ? "Candidate Tracker sign-in could not be completed." : message)
            }
            let (_, response) = try await URLSession.shared.data(from: signInURL)
            guard let http = response as? HTTPURLResponse, (200..<400).contains(http.statusCode) else {
                throw ClientError.server("Candidate Tracker sign-in could not be completed.")
            }
            candidateTrackerAuthenticated = true
        }
        guard let url = URL(string: path, relativeTo: candidateTrackerBaseURL) else {
            throw ClientError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        if http.statusCode == 401, mayRetry {
            candidateTrackerAuthenticated = false
            return try await candidateTrackerRequest(path: path, method: method, body: body, mayRetry: false)
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIError.self, from: data)
            throw ClientError.server(error?.error ?? "Candidate Tracker request failed.")
        }
        return data
    }

    func invite(name: String, email: String, role: String) async -> InviteResponse? {
        var result: InviteResponse?
        await perform {
            let body = try JSONSerialization.data(withJSONObject: [
                "name": name, "email": email, "role": role,
            ])
            result = try await self.request("/api/officers/invite", method: "POST", body: body)
            self.message = result?.emailSent == true ? "Invitation emailed." : "Invitation created. Copy the private link."
        }
        return result
    }

    func revokeAccess(email: String) async {
        await perform {
            let body = try JSONSerialization.data(withJSONObject: ["email": email])
            let response: MessageResponse = try await self.request(
                "/api/officers/revoke",
                method: "POST",
                body: body
            )
            self.message = response.message
            await self.refresh(silent: true)
        }
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

    func sign(document: LodgeDocument, officerAddress: String) async -> Bool {
        guard user?.role != "viewer" else {
            message = "This account has status-only document access."
            isError = true
            return false
        }
        var success = false
        await perform {
            let body = try JSONSerialization.data(withJSONObject: ["consent": true, "officerAddress": officerAddress])
            let response: MessageResponse = try await self.request(
                "/api/documents/\(document.id)/sign", method: "POST", body: body
            )
            self.message = response.message
            success = true
            await self.refresh(silent: true)
        }
        return success
    }

    func pdfData(document: LodgeDocument) async throws -> Data {
        guard user?.role != "viewer" else {
            throw ClientError.server("This account has status-only document access.")
        }
        guard let baseURL,
              let url = URL(string: "/api/documents/\(document.id)/file", relativeTo: baseURL) else {
            throw ClientError.invalidServer
        }
        var request = URLRequest(url: url)
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ClientError.server("The PDF could not be loaded.")
        }
        return data
    }

    /* Hands a completed dispensation to the Master's own mail client as a draft, with the executed
     * PDF genuinely attached.
     *
     * The web page cannot do this: mailto has no attachment field anywhere in the URL scheme, so
     * the browser can only download the file and let him drag it in. A native app can use the
     * macOS share sheet, which carries the file itself. If the share sheet is unavailable we fall
     * back to the browser's behaviour rather than failing, so the Master always gets somewhere.
     */
    @discardableResult
    func draftToDistrictDeputy(document: LodgeDocument) async -> Bool {
        guard user?.role == "owner" else {
            message = "This account cannot submit documents."
            isError = true
            return false
        }
        var success = false
        await perform {
            let response: SubmissionDraftResponse = try await self.request(
                "/api/documents/\(document.id)/submission-draft")
            let draft = response.draft
            let pdf = try await self.pdfData(document: document)
            let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(draft.filename)
            try pdf.write(to: fileURL, options: .atomic)

            await MainActor.run {
                let service = NSSharingService(named: .composeEmail)
                service?.recipients = [draft.to]
                service?.subject = draft.subject
                let items: [Any] = [draft.body, fileURL]
                if service?.canPerform(withItems: items) == true {
                    service?.perform(withItems: items)
                    self.message = "Draft opened for \(draft.name) with \(draft.filename) attached. Review it and send."
                } else {
                    /* No share sheet available. Put the PDF somewhere he can find it and open the
                     * note anyway, so he is one drag from sending rather than stuck. */
                    let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                    let saved = downloads?.appendingPathComponent(draft.filename)
                    if let saved { try? pdf.write(to: saved, options: .atomic) }
                    var components = URLComponents()
                    components.scheme = "mailto"
                    components.path = draft.to
                    components.queryItems = [
                        URLQueryItem(name: "subject", value: draft.subject),
                        URLQueryItem(name: "body", value: draft.body),
                    ]
                    if let mailto = components.url { NSWorkspace.shared.open(mailto) }
                    self.message = "\(draft.filename) is in your Downloads and the note is open. Drag the PDF in and send."
                }
            }
            success = true
        }
        return success
    }

    /* Where a seat stands. Mirrors the same three way test the web page makes, so the two
     * clients never tell the Master different things about the same man. */
    func seatState(role: String) -> OfficerSeatState {
        if officers.contains(where: { $0.role == role }) { return .active }
        if pendingInvitations.contains(where: { $0.role == role }) { return .pending }
        return .none
    }

    func seatName(role: String, fallback: String) -> String {
        officers.first { $0.role == role }?.name
            ?? pendingInvitations.first { $0.role == role }?.name
            ?? fallback
    }

    func signOut(localOnly: Bool = false) {
        liveTask?.cancel()
        isLive = false
        if !localOnly {
            Task { let _: EmptyResponse? = try? await request("/api/auth/logout", method: "POST") }
        }
        token = nil
        TokenStore.delete()
        BiometricCredentialStore.delete()
        biometricLoginEnabled = false
        UserDefaults.standard.set(false, forKey: "biometric-login-enabled")
        user = nil
        documents = []
        officers = []
        pendingInvitations = []
        submissionProfiles = []
        candidateRecords = []
        candidateTrackerAuthenticated = false
    }

    private func saveLogin(_ token: String) throws {
        /* The file copy is what survives a quit. The Keychain copy is what Touch ID unlocks.
         * Keeping both means force quitting the app does not sign him out. */
        TokenStore.save(token)
        if biometricLoginEnabled {
            try BiometricCredentialStore.save(token)
        }
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
