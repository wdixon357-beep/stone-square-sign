import Foundation

final class SessionFixture: URLProtocol {
    static var status = 503
    static var offline = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if Self.offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"error\":\"fixture response\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct SessionTests {
    @MainActor static func main() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionFixture.self]
        let session = URLSession(configuration: config)
        let model = AppModel(session: session, savedSessionToken: "test-only-not-a-real-token")
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
        session.invalidateAndCancel()
    }
}
