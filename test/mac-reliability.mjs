import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const client = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/APIClient.swift', import.meta.url), 'utf8');
const models = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/Models.swift', import.meta.url), 'utf8');
const actualTransport = client.slice(0, client.indexOf('private struct TrackerHandoffResponse:'));
const actualError = models.slice(models.indexOf('struct APIError:'), models.indexOf('struct VersionResponse:'));
for (const endpoint of ['/api/building/alerts', '/api/treasury/alerts', '/api/minutes/review-alerts', '/api/minutes/completion-alerts']) {
  assert.ok(client.includes(`request("${endpoint}", presentation: .background)`), `Passive reminders are labeled: ${endpoint}`);
}
const buildingRefresh = client.slice(client.indexOf('func refreshBuildingAlerts()'), client.indexOf('func dismissTreasuryAlert('));
assert.match(buildingRefresh, /catch \{ \/\* Preserve action reminders/, 'Failed refresh retains the existing building alert list');
assert.match(client, /presentation: ReliabilityPresentation = \.foreground/, 'Foreground actions keep the default actionable behavior');
assert.match(client, /"area": ReliabilityCenter\.area\(for: incident\.path\)/, 'Incident audit metadata identifies the affected area');
if (process.platform !== 'darwin') {
  console.log('PASS: native reminder scoping contracts; compiled transport lifecycle checks run on macOS.');
  process.exit(0);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-native-reliability-'));
try {
  const source = path.join(scratch, 'reliability.swift');
  const binary = path.join(scratch, 'native-reliability-fixture');
  fs.writeFileSync(source, `${actualTransport}\nimport SwiftUI\n${actualError}\n
final class ReliabilityFixture: URLProtocol {
    static var buildingStatus = 502
    static var buildingReference = "SS22-TEST-A"
    static var saveStatus = 502
    static var buildingCalls = 0
    static var saveCalls = 0
    static var networkHealthy = false
    static var incidentStatus = 200
    static var heartbeatStatus = 200
    static var heartbeatCalls = 0
    static var reports: [[String: Any]] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private func body() -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
    override func startLoading() {
        // Every request, including fake production-host audit reports, is handled
        // here. No request can reach the network or a live dashboard record.
        precondition(request.url?.host == "stone-square-sign.onrender.com")
        let endpoint = request.url!.path
        var status = 200
        var object: [String: Any] = ["ok":true]
        if endpoint == "/api/activity/incidents" {
            let authorization = request.value(forHTTPHeaderField: "Authorization")
            precondition(["Bearer SYNTHETIC-QA-TOKEN", "Bearer SYNTHETIC-OTHER-TOKEN"].contains(authorization))
            var report = try! JSONSerialization.jsonObject(with: body()) as! [String: Any]
            report["fixtureAuthorization"] = authorization
            status = Self.incidentStatus
            if status == 200 { Self.reports.append(report) }
        } else if endpoint == "/api/building/alerts" {
            Self.buildingCalls += 1; status = Self.buildingStatus
            object = status == 200 ? ["alerts":[]] : ["error":"Synthetic upstream outage", "incidentReference":Self.buildingReference]
        } else if endpoint == "/api/minutes/QA-SAVE" {
            Self.saveCalls += 1; status = Self.saveStatus
            object = status == 200 ? ["ok":true] : ["error":"Synthetic save failure", "incidentReference":"SS22-TEST-FOREGROUND"]
        } else if endpoint == "/api/treasury/alerts" && !Self.networkHealthy {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return
        } else if endpoint == "/api/activity/heartbeat" {
            Self.heartbeatCalls += 1; status = Self.heartbeatStatus
            object = status == 200 ? ["ok":true] : ["error":"Synthetic activity storage outage"]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields:["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: object))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

extension ReliableTransport {
    static func enqueueRetentionFixture(reference: String, context: String?) {
        queue(PendingIncident(reference: reference, path: "/api/building/alerts", method: "GET", status: 0, state: "open", category: "network_error", context: context))
    }
}

@main struct NativeReliabilityTests {
    @MainActor static func main() async throws {
        let pendingKey = "ss22-pending-incidents-v1"
        // This standalone fixture executable has its own defaults domain. It
        // never loads a user session, Keychain credential or production data.
        UserDefaults.standard.removeObject(forKey: pendingKey)
        defer { UserDefaults.standard.removeObject(forKey: pendingKey) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReliabilityFixture.self]
        let session = URLSession(configuration: config)
        let center = ReliabilityCenter.shared
        center.dismiss()
        func perform(_ path: String, method: String = "GET", presentation: ReliabilityPresentation = .background, token: String = "SYNTHETIC-QA-TOKEN") async throws -> HTTPURLResponse {
            var request = URLRequest(url: URL(string: "https://stone-square-sign.onrender.com" + path)!)
            request.httpMethod = method
            return try await ReliableTransport.perform(session: session, request: request, path: path, token: token, presentation: presentation).1
        }
        func reported(_ reference: String, _ state: String) -> Bool {
            ReliabilityFixture.reports.contains { $0["reference"] as? String == reference && $0["state"] as? String == state }
        }
        _ = try await perform("/api/building/alerts")
        precondition(ReliabilityFixture.buildingCalls == 2, "Safe reads retry once")
        precondition(center.notice?.title == "Building Request reminders could not refresh.")
        precondition(center.notice?.path == "/api/building/alerts" && center.notice?.background == true)
        let firstNotice = center.notice!.id
        precondition(reported("SS22-TEST-A", "open"), "The first failure is audited")
        precondition(ReliabilityFixture.reports.last?["area"] as? String == "Building Request reminders")
        ReliabilityFixture.buildingReference = "SS22-TEST-B"
        _ = try await perform("/api/building/alerts")
        precondition(center.notice?.id == firstNotice, "Repeated same-path polling must not replace the banner")
        precondition(reported("SS22-TEST-B", "open"), "Deduplicated presentation must not drop the next failure audit")
        _ = try await perform("/api/minutes")
        precondition(center.notice?.id == firstNotice && center.notice?.recovered == false, "Unrelated success cannot imply recovery")
        ReliabilityFixture.buildingStatus = 200
        _ = try await perform("/api/building/alerts")
        precondition(center.notice?.recovered == true && center.notice?.title == "Building Request reminders refreshed successfully.")
        precondition(reported("SS22-TEST-A", "recovered") && reported("SS22-TEST-B", "recovered"), "Separate-call recovery resolves every tracked failure reference")
        center.dismiss()
        ReliabilityFixture.buildingStatus = 502; ReliabilityFixture.buildingReference = "SS22-TEST-C"
        _ = try await perform("/api/building/alerts")
        precondition(center.notice != nil)
        center.dismiss()
        ReliabilityFixture.buildingReference = "SS22-TEST-D"
        _ = try await perform("/api/building/alerts")
        precondition(center.notice == nil, "Dismissed passive outage must not reopen on every poll")
        precondition(reported("SS22-TEST-C", "open") && reported("SS22-TEST-D", "open"), "Dismissal cannot hide audit records")
        ReliabilityFixture.buildingStatus = 200
        _ = try await perform("/api/building/alerts")
        precondition(center.notice == nil, "Dismissed passive recovery stays quiet")
        precondition(reported("SS22-TEST-C", "recovered") && reported("SS22-TEST-D", "recovered"))
        _ = try await perform("/api/minutes/QA-SAVE", method: "POST", presentation: .foreground)
        precondition(ReliabilityFixture.saveCalls == 1, "Foreground mutations must never retry automatically")
        precondition(center.notice?.title == "This action could not be completed." && center.notice?.background == false)
        let foregroundNotice = center.notice!.id
        ReliabilityFixture.buildingStatus = 502; ReliabilityFixture.buildingReference = "SS22-TEST-E"
        _ = try await perform("/api/building/alerts")
        precondition(center.notice?.id == foregroundNotice, "Passive outages must not displace a failed foreground action")
        ReliabilityFixture.buildingStatus = 200
        _ = try await perform("/api/building/alerts")
        precondition(center.notice?.id == foregroundNotice, "Background recovery cannot clear a foreground failure")
        ReliabilityFixture.saveStatus = 200
        _ = try await perform("/api/minutes/QA-SAVE", method: "POST", presentation: .foreground)
        precondition(center.notice?.recovered == true)
        precondition(reported("SS22-TEST-FOREGROUND", "open") && reported("SS22-TEST-FOREGROUND", "recovered"))
        center.dismiss()
        do {
            _ = try await perform("/api/treasury/alerts")
            preconditionFailure("Synthetic offline request must throw")
        } catch { }
        let queued = try JSONSerialization.jsonObject(with: UserDefaults.standard.data(forKey: pendingKey)!) as! [[String: Any]]
        let queuedReference = queued.last!["reference"] as! String
        precondition(center.notice?.title == "Treasurer Report reminders could not refresh.")
        _ = try await perform("/api/minutes")
        precondition(reported(queuedReference, "open"), "Queued incidents are flushed without a live request")
        precondition(center.notice?.recovered == false, "Flushing a report is not recovery of the failed path")
        ReliabilityFixture.networkHealthy = true
        _ = try await perform("/api/treasury/alerts")
        precondition(reported(queuedReference, "recovered") && center.notice?.recovered == true)
        precondition(ReliabilityFixture.reports.allSatisfy { ($0["path"] as? String)?.contains("?") == false }, "Audit paths remain redacted")
        center.dismiss()
        // A storage outage may prevent the error log itself being accepted.
        // Passive activity must not claim a user document action failed, and
        // local queueing must never be described as a confirmed server record.
        ReliabilityFixture.incidentStatus = 503; ReliabilityFixture.heartbeatStatus = 500
        _ = try await perform("/api/activity/heartbeat", method: "POST", presentation: .foreground)
        precondition(ReliabilityFixture.heartbeatCalls == 1, "Activity POST is never replayed")
        precondition(center.notice?.background == true && center.notice?.title == "Activity tracking could not refresh.")
        precondition(center.notice?.message.contains("saved on this Mac") == true && center.notice?.message.contains("incident was recorded") == false)
        let activityQueued = try JSONSerialization.jsonObject(with: UserDefaults.standard.data(forKey: pendingKey)!) as! [[String: Any]]
        let activityReference = activityQueued.last!["reference"] as! String
        precondition(activityQueued.last!["path"] as? String == "/api/activity/heartbeat" && activityQueued.last!["state"] as? String == "open" && activityQueued.last!["status"] as? Int == 500)
        precondition(!reported(activityReference, "open"), "An incident refusal is not confirmed delivery")
        ReliabilityFixture.incidentStatus = 200
        _ = try await perform("/api/minutes")
        precondition(reported(activityReference, "open") && center.notice?.message.contains("incident was recorded") == true)
        precondition(center.notice?.recovered == false, "Delivering queued telemetry does not prove the activity endpoint recovered")
        ReliabilityFixture.heartbeatStatus = 200
        _ = try await perform("/api/activity/heartbeat", method: "POST", presentation: .foreground)
        precondition(center.notice?.background == true && center.notice?.recovered == true && reported(activityReference, "recovered"))
        precondition(ReliabilityCenter.presentation(for: "/api/activity/interaction?private=not-reported", requested: .foreground) == .background)
        center.dismiss()
        // Account A's queued audit and visible error cannot be recovered or
        // attributed by a later successful read under Account B.
        let accountA = "SYNTHETIC-QA-TOKEN", accountB = "SYNTHETIC-OTHER-TOKEN"
        let origin = URL(string: "https://stone-square-sign.onrender.com")!
        let contextA = ReliableTransport.contextFingerprint(url: origin, token: accountA)!
        let contextB = ReliableTransport.contextFingerprint(url: origin, token: accountB)!
        precondition(contextA != contextB && contextA.count == 64)
        center.resetSession(context: contextA)
        ReliabilityFixture.networkHealthy = false
        do { _ = try await perform("/api/treasury/alerts"); preconditionFailure("Expected offline fixture") } catch { }
        var accountPending = try JSONSerialization.jsonObject(with: UserDefaults.standard.data(forKey: pendingKey)!) as! [[String: Any]]
        let formerReference = accountPending.last!["reference"] as! String
        precondition(accountPending.last!["context"] as? String == contextA)
        precondition(!String(data: UserDefaults.standard.data(forKey: pendingKey)!, encoding: .utf8)!.contains(accountA), "Pending audit stores a fingerprint, never a credential")
        center.resetSession(context: contextB)
        precondition(center.notice == nil, "Authentication changes clear old private notice state")
        ReliabilityFixture.networkHealthy = true
        _ = try await perform("/api/treasury/alerts", token: accountB)
        precondition(!reported(formerReference, "open") && !reported(formerReference, "recovered"), "Account B must never send or recover Account A's incident")
        accountPending = try JSONSerialization.jsonObject(with: UserDefaults.standard.data(forKey: pendingKey)!) as! [[String: Any]]
        accountPending.append(["reference":"SS22-LEGACY-UNKNOWN", "path":"/api/building/alerts", "method":"GET", "status":0, "state":"open", "category":"network_error"])
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: accountPending), forKey: pendingKey)
        _ = try await perform("/api/minutes", token: accountB)
        precondition(!reported("SS22-LEGACY-UNKNOWN", "open"), "Unknown legacy context cannot be assigned to the new login")
        let retainedPending = try JSONSerialization.jsonObject(with: UserDefaults.standard.data(forKey: pendingKey)!) as! [[String: Any]]
        precondition(retainedPending.count == 2, "Unattributable and former-account audits are retained")
        ReliabilityFixture.buildingStatus = 502; ReliabilityFixture.buildingReference = "SS22-ACCOUNT-B"
        _ = try await perform("/api/building/alerts", token: accountB)
        let accountBNotice = center.notice!.id
        ReliabilityFixture.buildingStatus = 200
        _ = try await perform("/api/building/alerts", token: accountA)
        precondition(center.notice?.id == accountBNotice && center.notice?.recovered == false, "Stale prior-session reads cannot change the active account's notice")
        let originalAudit = ReliabilityFixture.reports.first { $0["reference"] as? String == formerReference }
        precondition(originalAudit?["fixtureAuthorization"] as? String == "Bearer " + accountA, "A retained audit may flush only under its original context")
        precondition(!reported(formerReference, "recovered"), "A context reset cannot manufacture recovery")
        _ = try await perform("/api/building/alerts", token: accountB)
        precondition(center.notice?.recovered == true && reported("SS22-ACCOUNT-B", "recovered"))
        precondition(!reported(formerReference, "recovered") && !reported("SS22-LEGACY-UNKNOWN", "open"))
        // More than 20 newer failures must never delete quarantined legacy or
        // former-account audit metadata that cannot yet be delivered safely.
        var quarantine: [[String: Any]] = []
        for index in 0..<40 {
            var item: [String: Any] = ["reference":"SS22-QUARANTINE-" + String(index), "path":"/api/building/alerts", "method":"GET", "status":0, "state":"open", "category":"network_error"]
            if index >= 20 { item["context"] = contextA }
            quarantine.append(item)
        }
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: quarantine), forKey: pendingKey)
        for index in 0..<35 {
            ReliableTransport.enqueueRetentionFixture(reference: "SS22-RECENT-" + String(index), context: contextB)
        }
        ReliableTransport.enqueueRetentionFixture(reference: "SS22-QUARANTINE-0", context: contextB)
        let retainedOverflow = try JSONSerialization.jsonObject(with: UserDefaults.standard.data(forKey: pendingKey)!) as! [[String: Any]]
        precondition(retainedOverflow.count == 76, "New failures cannot silently cap or overwrite quarantined audits")
        for index in 0..<40 {
            precondition(retainedOverflow.contains { item in
                item["reference"] as? String == "SS22-QUARANTINE-" + String(index)
                    && (index < 20 ? item["context"] == nil : item["context"] as? String == contextA)
            }, "Every legacy and former-account audit must remain retained")
        }
        print("PASS: compiled native reminder lifecycle, passive activity, truthful queued/delivered status, path recovery, foreground priority, complete audits, account isolation and retention beyond 20 queued incidents")
    }
}
`);
  const build = spawnSync('swiftc', ['-target', 'arm64-apple-macosx14.0', '-swift-version', '5', '-parse-as-library', source, '-o', binary], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  process.stdout.write(run.stdout);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
