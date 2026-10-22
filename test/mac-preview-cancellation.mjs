import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const client = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/APIClient.swift', import.meta.url), 'utf8');
const models = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/Models.swift', import.meta.url), 'utf8');
const minutes = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/MeetingMinutes.swift', import.meta.url), 'utf8');
const actualTransport = client.slice(0, client.indexOf('private struct TrackerHandoffResponse:'));
const actualError = models.slice(models.indexOf('struct APIError:'), models.indexOf('struct VersionResponse:'));
const preview = minutes.slice(minutes.indexOf('    func updatePreview()'), minutes.indexOf('    func downloadWord()'));
assert.match(client, /cancellationPolicy: ReliableCancellationPolicy = \.reportFailure/, 'Ordinary requests retain their audit policy');
assert.match(client, /request\.url\?\.path == endpoint/, 'A caller cannot relabel a mutation as a preview');
assert.match(client, /request\.httpMethod\?\.uppercased\(\) == "POST"/, 'Only the exact preview method may opt in');
assert.match(preview, /cancellationPolicy: \.supersededMinutesPreview/, 'Only the debounced minutes preview explicitly opts in');
assert.match(preview, /!\(error is CancellationError\)/, 'Expected preview cancellation stays out of local error presentation');
assert.equal((minutes.match(/cancellationPolicy: \.supersededMinutesPreview/g) || []).length, 1, 'Saving, generation, claiming and signing never opt in');
assert.equal((client.match(/if expectsCancellation \{ try Task\.checkCancellation\(\) \}/g) || []).length, 2, 'Expected cancellation is checked before transport and after a successful await');
if (process.platform !== 'darwin') {
  console.log('PASS: bounded native preview cancellation policy; compiled transport checks run on macOS.');
  process.exit(0);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-preview-cancel-'));
try {
  const source = path.join(scratch, 'preview-cancel.swift');
  const binary = path.join(scratch, 'preview-cancel-fixture');
  fs.writeFileSync(source, `${actualTransport}\nimport SwiftUI\n${actualError}\n
final class PreviewCancellationFixture: URLProtocol {
    static var mode = "hold"
    static var requests = 0
    static var intercepted: [(method: String, path: String)] = []
    static var reports: [[String: Any]] = []
    static var held: [PreviewCancellationFixture] = []
    static let lock = NSLock()
    static func heldCount() -> Int { lock.lock(); defer { lock.unlock() }; return held.count }
    static func releaseSuccess() {
        lock.lock(); let pending = held; held = []; lock.unlock()
        for fixture in pending { fixture.complete(status: 200, data: Data("%PDF synthetic preview".utf8)) }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private func body() -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 2048)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
        return data
    }
    private func complete(status: Int, data: Data) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func startLoading() {
        // This protocol handles every fake production-host and audit request.
        // The executable never loads the app session or contacts the network.
        precondition(request.url?.host == "stone-square-sign.onrender.com")
        if request.url?.path == "/api/activity/incidents" {
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer SYNTHETIC-PREVIEW-TOKEN")
            let report = try! JSONSerialization.jsonObject(with: body()) as! [String: Any]
            Self.lock.lock(); Self.reports.append(report); Self.lock.unlock()
            complete(status: 200, data: Data("{}".utf8)); return
        }
        Self.lock.lock(); Self.requests += 1; Self.intercepted.append((request.httpMethod ?? "GET", request.url!.path)); let mode = Self.mode
        if mode == "hold" { Self.held.append(self) }
        Self.lock.unlock()
        switch mode {
        case "hold": return
        case "cancel": client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
        case "offline": client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        case "timeout": client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
        case "server": complete(status: 502, data: Data(#"{"error":"Synthetic current preview failure","incidentReference":"SS22-PREVIEW-SERVER"}"#.utf8))
        default: complete(status: 200, data: Data("%PDF synthetic preview".utf8))
        }
    }
    override func stopLoading() { Self.lock.lock(); Self.held.removeAll { $0 === self }; Self.lock.unlock() }
}
extension ReliableTransport {
    static func waitForPreviewFixtureDelivery() async { await deliveryTask?.value }
    static func seedPreviewFixtureQuarantine() {
        queue(PendingIncident(reference: "SS22-OTHER-ACCOUNT", path: "/api/minutes/OTHER/preview", method: "POST", status: 0, state: "open", category: "network_error", context: "other-account"))
        queue(PendingIncident(reference: "SS22-UNKNOWN-ACCOUNT", path: "/api/minutes/UNKNOWN/preview", method: "POST", status: 0, state: "open", category: "network_error"))
    }
    static func previewFixtureQuarantine() -> [String] { queued().filter { $0.context == nil || $0.context == "other-account" }.map { $0.reference } }
    static func recognizesPreviewFixtureCancellation(_ error: Error) -> Bool { isExpectedCancellation(error) }
}
@main struct PreviewCancellationTests {
    @MainActor static func main() async throws {
        let key = "ss22-pending-incidents-v1"
        // This temporary standalone executable has a separate defaults domain.
        UserDefaults.standard.removeObject(forKey: key)
        defer { UserDefaults.standard.removeObject(forKey: key) }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [PreviewCancellationFixture.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let token = "SYNTHETIC-PREVIEW-TOKEN", path = "/api/minutes/QA-PREVIEW/preview"
        let center = ReliabilityCenter.shared
        let context = ReliableTransport.contextFingerprint(url: URL(string: "https://stone-square-sign.onrender.com"), token: token)!
        center.resetSession(context: context)
        ReliableTransport.seedPreviewFixtureQuarantine()
        let quarantined = ReliableTransport.previewFixtureQuarantine()
        let retainedQueue = UserDefaults.standard.data(forKey: key)
        func perform(_ endpoint: String = "/api/minutes/QA-PREVIEW/preview", method: String = "POST", policy: ReliableCancellationPolicy = .supersededMinutesPreview) async throws -> (Data, HTTPURLResponse) {
            var request = URLRequest(url: URL(string: "https://stone-square-sign.onrender.com" + endpoint)!)
            request.httpMethod = method
            if !["GET", "HEAD"].contains(method.uppercased()) { request.httpBody = Data(#"{"draft":"synthetic"}"#.utf8) }
            return try await ReliableTransport.perform(session: session, request: request, path: endpoint, token: token, cancellationPolicy: policy)
        }
        func waitForHeld() async throws {
            for _ in 0..<1000 { if PreviewCancellationFixture.heldCount() > 0 { return }; try await Task.sleep(for: .milliseconds(1)) }
            preconditionFailure("The isolated preview did not reach the held transport")
        }
        func expectCancellation(_ task: Task<(Data, HTTPURLResponse), Error>) async {
            do { _ = try await task.value; preconditionFailure("Expected preview cancellation") }
            catch is CancellationError { }
            catch { preconditionFailure("Unexpected cancellation presentation: " + error.localizedDescription) }
            await ReliableTransport.waitForPreviewFixtureDelivery()
        }
        center.failed(reference: "SS22-PRIOR-PREVIEW", path: path, method: "POST")
        let priorNotice = center.notice!.id
        PreviewCancellationFixture.mode = "hold"
        let cancelled = Task { try await perform() }
        try await waitForHeld(); cancelled.cancel(); await expectCancellation(cancelled)
        precondition(center.notice?.id == priorNotice && center.notice?.recovered == false, "Cancelled preview cannot clear or recover a retained prior failure")
        precondition(PreviewCancellationFixture.reports.isEmpty && UserDefaults.standard.data(forKey: key) == retainedQueue, "Debounce cancellation creates no false foreground incident, network-error report or queue mutation")
        print("PASS: a held minutes preview cancellation leaves prior notices and retained audit bytes exact")

        let completedThenCancelled = Task { try await perform() }
        try await waitForHeld(); PreviewCancellationFixture.releaseSuccess(); completedThenCancelled.cancel()
        await expectCancellation(completedThenCancelled)
        precondition(center.notice?.id == priorNotice && PreviewCancellationFixture.reports.isEmpty, "A superseded success cannot mark prior incidents recovered or present stale bytes")
        print("PASS: cancellation at successful transport completion does not report false recovery")

        let preCancelled = Task { try await perform() }; preCancelled.cancel(); await expectCancellation(preCancelled)
        precondition(PreviewCancellationFixture.reports.isEmpty && UserDefaults.standard.data(forKey: key) == retainedQueue)
        PreviewCancellationFixture.mode = "cancel"
        do { _ = try await perform(); preconditionFailure("Expected URL cancellation") } catch is CancellationError { }
        precondition(PreviewCancellationFixture.reports.isEmpty && center.notice?.id == priorNotice)
        precondition(ReliableTransport.recognizesPreviewFixtureCancellation(CancellationError()))
        precondition(ReliableTransport.recognizesPreviewFixtureCancellation(URLError(.cancelled)))
        precondition(ReliableTransport.recognizesPreviewFixtureCancellation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
        precondition(!ReliableTransport.recognizesPreviewFixtureCancellation(URLError(.timedOut)))
        print("PASS: pre-start Task cancellation, CancellationError and canonical URL cancellation are recognized only by the opted-in preview path")

        for mode in ["offline", "timeout", "server"] {
            center.resetSession(context: context); PreviewCancellationFixture.mode = mode
            let count = PreviewCancellationFixture.reports.count, calls = PreviewCancellationFixture.requests
            do { let (_, response) = try await perform(); precondition(mode == "server" && response.statusCode == 502) }
            catch { precondition(mode != "server" && !(error is CancellationError)) }
            await ReliableTransport.waitForPreviewFixtureDelivery()
            let reports = Array(PreviewCancellationFixture.reports.dropFirst(count))
            precondition(reports.count == 1 && reports[0]["state"] as? String == "open", "Current preview failure remains audited: " + mode)
            precondition(reports[0]["category"] as? String == (mode == "server" ? "service_response" : "network_error"))
            precondition(center.notice?.recovered == false && center.notice?.background == false, "Current preview failure remains visible")
            precondition(PreviewCancellationFixture.requests == calls + 1, "Preview POST is never retried")
            precondition(ReliableTransport.previewFixtureQuarantine() == quarantined, "Unknown and other-account audit records remain retained")
        }
        print("PASS: genuine current preview offline, timeout and server errors remain visible and audited without POST retries")

        center.resetSession(context: context); PreviewCancellationFixture.mode = "cancel"
        for (endpoint, method, policy) in [("/api/minutes/QA-PREVIEW", "PUT", ReliableCancellationPolicy.supersededMinutesPreview), ("/api/minutes/QA-PREVIEW/master-attest", "POST", ReliableCancellationPolicy.supersededMinutesPreview), (path, "POST", ReliableCancellationPolicy.reportFailure)] {
            let count = PreviewCancellationFixture.reports.count
            do { _ = try await perform(endpoint, method: method, policy: policy); preconditionFailure("Expected audited normal cancellation") }
            catch { precondition(!(error is CancellationError), "Mutation and ordinary callers do not acquire cancellation suppression") }
            await ReliableTransport.waitForPreviewFixtureDelivery()
            precondition(PreviewCancellationFixture.reports.count == count + 1 && center.notice?.recovered == false)
            precondition(PreviewCancellationFixture.reports.last?["category"] as? String == "network_error")
        }
        let getCount = PreviewCancellationFixture.reports.count, getCalls = PreviewCancellationFixture.requests
        let interceptedGets = PreviewCancellationFixture.intercepted.filter { $0.method == "GET" && $0.path == path }.count
        do { _ = try await perform(path, method: "GET", policy: .supersededMinutesPreview); preconditionFailure("Expected ordinary GET cancellation failure") }
        catch { precondition(!(error is CancellationError), "GET preview requests cannot acquire expected-cancellation suppression") }
        await ReliableTransport.waitForPreviewFixtureDelivery()
        precondition(PreviewCancellationFixture.requests == getCalls + 2, "The method fence preserves the existing single safe-read retry")
        precondition(PreviewCancellationFixture.intercepted.filter { $0.method == "GET" && $0.path == path }.count == interceptedGets + 2, "Both GET attempts reach the isolated canonical-cancellation fixture")
        precondition(PreviewCancellationFixture.reports.count == getCount + 1 && PreviewCancellationFixture.reports.last?["category"] as? String == "network_error")
        precondition(center.notice?.recovered == false && center.notice?.background == false, "GET cancellation retains its visible ordinary failure")
        print("PASS: GET preview opt-in remains an ordinary visible/audited request with its existing safe-read retry")
        let mislabeledCount = PreviewCancellationFixture.reports.count
        var mislabeled = URLRequest(url: URL(string: "https://stone-square-sign.onrender.com/api/minutes/QA-PREVIEW/master-attest")!)
        mislabeled.httpMethod = "POST"
        do { _ = try await ReliableTransport.perform(session: session, request: mislabeled, path: path, token: token, cancellationPolicy: .supersededMinutesPreview); preconditionFailure("Expected audited mislabeled mutation") }
        catch { precondition(!(error is CancellationError), "The caller path cannot relabel a mutation URL as a preview") }
        await ReliableTransport.waitForPreviewFixtureDelivery()
        precondition(PreviewCancellationFixture.reports.count == mislabeledCount + 1)
        PreviewCancellationFixture.mode = "hold"
        let count = PreviewCancellationFixture.reports.count
        let mutation = Task { try await perform("/api/minutes/QA-PREVIEW", method: "PUT", policy: .supersededMinutesPreview) }
        try await waitForHeld(); mutation.cancel()
        do { _ = try await mutation.value; preconditionFailure("Expected uncertain mutation outcome") }
        catch { precondition(!(error is CancellationError), "A cancelled business write must retain its uncertain-outcome diagnostic") }
        await ReliableTransport.waitForPreviewFixtureDelivery()
        precondition(PreviewCancellationFixture.reports.count == count + 1 && PreviewCancellationFixture.reports.last?["category"] as? String == "network_error")
        precondition(ReliableTransport.previewFixtureQuarantine() == quarantined)
        print("PASS: business mutation cancellation, wrong-path opt-in and ordinary caller cancellation retain foreground failure and durable audit")
    }
}
`);
  const build = spawnSync('swiftc', ['-parse-as-library', source, '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  process.stdout.write(run.stdout);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
