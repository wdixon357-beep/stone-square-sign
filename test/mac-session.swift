import Foundation

final class SessionFixture: URLProtocol {
    static var status = 503
    static var offline = false
    static var payload = "{\"error\":\"fixture response\"}"
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if Self.offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct SessionTests {
    @MainActor static func main() async throws {
        let savedAddress = UserDefaults.standard.object(forKey: "server-address")
        UserDefaults.standard.set("http://untrusted.example.invalid", forKey: "server-address")
        defer {
            if let savedAddress { UserDefaults.standard.set(savedAddress, forKey: "server-address") }
            else { UserDefaults.standard.removeObject(forKey: "server-address") }
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionFixture.self]
        let session = URLSession(configuration: config)
        let model = AppModel(session: session, savedSessionToken: "test-only-not-a-real-token")
        precondition(model.serverAddress == defaultServerAddress)
        precondition(model.baseURL?.absoluteString == "https://stone-square-sign.onrender.com")
        print("PASS: release sessions ignore stored service overrides and pin the approved HTTPS origin")
        await model.restoreSession()
        precondition(model.hasSavedSession && model.user == nil && model.sessionConnectionError != nil && !model.restoringSession)
        print("PASS: HTTP 503 preserves saved login and shows reconnect state")
        SessionFixture.offline = true
        await model.restoreSession()
        precondition(model.hasSavedSession && model.sessionConnectionError != nil)
        print("PASS: offline launch preserves saved login")
        SessionFixture.offline = false
        SessionFixture.status = 401
        do {
            let _: MeResponse = try await model.request("/api/auth/me")
            preconditionFailure("401 must fail")
        } catch ClientError.unauthorized { print("PASS: explicit credential rejection remains distinguishable from outages") }
        SessionFixture.status = 200
        SessionFixture.payload = #"{"user":{"id":9999,"email":"session-qa@example.org","name":"QA Member","role":"member","hasSignature":false},"session":{"lifetimeDays":90,"expiresAt":"2026-12-11T12:00:00.000Z"},"documents":[]}"#
        await model.restoreSession()
        precondition(model.user?.id == 9999 && model.signInSession?.lifetimeDays == 90 && model.showSignInNotice)
        precondition(model.signInSession?.title.contains("90 days") == true)
        print("PASS: restored Mac account displays the service's 90-day sign-in notice")
        model.showSignInNotice = false
        precondition(model.signInSession?.lifetimeDays == 90 && !model.showSignInNotice)
        print("PASS: dismissing the Mac notice retains sign-in details for Settings")
        let legacy = try JSONDecoder().decode(MeResponse.self, from: Data(#"{"user":{"id":9999,"email":"session-qa@example.org","name":"QA Member","role":"member","hasSignature":false}}"#.utf8))
        precondition(legacy.session == nil)
        print("PASS: Mac remains compatible with services that do not yet return session details")
        session.invalidateAndCancel()
    }
}
