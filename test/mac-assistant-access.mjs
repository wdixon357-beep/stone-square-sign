import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/AssistantAccess.swift', import.meta.url), 'utf8');
const viewSource = fs.readFileSync(new URL('../macos/Sources/StoneSquareSign/Views.swift', import.meta.url), 'utf8');
assert.match(source, /mode == "standing" \|\| mode == "approval"/);
assert.match(source, /assistant\?\.enabled == true && request\.status == "pending" && \(request\.mode \?\? capabilities\.first\(where: \{ \$0\.id == request\.actionId \}\)\?\.mode\) == "approval"/);
const reviewNavigation = viewSource.slice(viewSource.indexOf('private func openAssistantReview'), viewSource.indexOf('private var standardHeader'));
assert.doesNotMatch(reviewNavigation, /attest\(|sign\(|finalize\(|workflow\(|method: "POST"/);
assert.match(viewSource, /@StateObject private var dispensationBuilderDraft/);
assert.match(viewSource, /@StateObject private var proposalReviewDraft/);
assert.match(reviewNavigation, /case "createDispensation"/);
assert.match(reviewNavigation, /case "proposalReview"/);
assert.match(reviewNavigation, /!minutesWorkspace\.dirty/);
assert.match(reviewNavigation, /!treasuryWorkspace\.dirty/);
assert.match(reviewNavigation, /!correspondenceWorkspace\.hasChanges/);
assert.match(reviewNavigation, /model\.assistantAccountContext == context/);
if (process.platform !== 'darwin') {
  console.log('PASS: native assistant boundaries; compiled state checks require macOS.');
  process.exit(0);
}
const assistant = { id: 'SYNTHETIC-ASSISTANT', name: 'Muse', enabled: true, expiresAt: '2026-11-07T00:00:00Z', permissions: ['minutes.read'], createdAt: null, updatedAt: null };
const instructedAssistant = { ...assistant, commandExecution: true, signatureExecution: true, expiresAt: new Date(Date.now() + 350 * 86400000).toISOString() };
const capabilities = [
  { id: 'minutes.read', label: 'Read minutes', group: 'Meetings', mode: 'standing', description: 'Read authorized records', effects: [] },
  { id: 'draft.change', label: 'Change draft', group: 'Meetings', mode: 'approval', description: 'One exact change', effects: ['Records a revision'] },
  { id: 'minutes.attest', label: 'Master attestation', group: 'Meetings', mode: 'personal', description: 'Owner action', effects: ['Signs and files the record'] },
  { id: 'future.unknown', label: 'Unknown future action', group: 'Meetings', mode: 'future', description: 'Fail closed', effects: [] }
];
const request = { id: 'REQ/ONE', actionId: 'draft.change', title: 'Synthetic change', method: 'PUT', path: '/api/minutes/SYNTHETIC', body: { revision: 4 }, status: 'pending', fingerprint: 'SYNTHETIC-FINGERPRINT', effects: ['Records a revision'], navigation: { section: 'minutes', recordId: 'SYNTHETIC' }, receipt: null };
const personal = { ...request, id: 'PERSONAL', actionId: 'minutes.attest', mode: 'personal', status: 'personal' };
const payload = { assistant, capabilities, requests: [request, personal], attestations: [{ id: 'ATTEST', kind: 'minutes', recordId: 'SYNTHETIC', title: 'Synthetic minutes', status: 'awaiting_master_attestation', section: 'minutes', actionLabel: 'Review and attest', attestationText: 'Synthetic exact statement', effects: ['Signs and files'], revision: 'opaque-hash', requestId: personal.id, ready: true }], activity: [] };
const raw = x => `#"${JSON.stringify(x)}"#`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-assistant-native-'));
try {
  const swiftFile = path.join(scratch, 'assistant-tests.swift');
  const binary = path.join(scratch, 'assistant-tests');
  fs.writeFileSync(swiftFile, `${source.slice(0, source.indexOf('// MARK: - Native views'))}
struct User { let id: Int; let role: String }
@MainActor final class AppModel {
    var user: User? = User(id: 1, role: "owner")
    var assistantAccountContext = "synthetic-account-one"
    var calls: [(String, String, Data?)] = []
    var handler: ((String, String, Data?) async throws -> Data)?
    func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        calls.append((path, method, body))
        let bytes = try await handler!(path, method, body)
        return try JSONDecoder().decode(T.self, from: bytes)
    }
}
@main struct AssistantNativeTests {
    @MainActor static func main() async throws {
        let model = AppModel(); let workspace = AssistantWorkspace()
        let workspaceBytes = Data(${raw(payload)}.utf8)
        model.handler = { _, _, _ in workspaceBytes }
        await workspace.load(model)
        precondition(workspace.loaded && workspace.assistant?.id == "SYNTHETIC-ASSISTANT")
        precondition(model.calls.count == 1 && model.calls[0].1 == "GET")
        precondition(workspace.issuedToken == nil)
        precondition(!workspace.accessCommandExecution && !workspace.accessSignatureExecution, "Legacy settings do not enable instructed execution")
        precondition(assistantStatusLabel("authorized") == "Authorized through Muse, awaiting execution")
        let fixedNow = Date(timeIntervalSince1970: 0)
        precondition(assistantRemainingAccessDays("1970-12-31T00:00:00.000Z", now: fixedNow) == 364)
        precondition(assistantRemainingAccessDays("1970-12-31T00:00:00Z", now: fixedNow) == 364)
        precondition(assistantRemainingAccessDays(nil, now: fixedNow) == 7)
        precondition(assistantRemainingAccessDays("1970-01-01T00:00:00Z", now: fixedNow) == 7)
        precondition(workspace.capabilities.filter(\\.canGrant).count == 2)
        precondition(workspace.attestations[0].revision == .string("opaque-hash"))
        let regular = workspace.requests[0], personal = workspace.requests[1]
        precondition(workspace.canApprove(regular) && !workspace.canApprove(personal))
        await workspace.decide(personal, decision: "approve", note: "", model: model)
        precondition(model.calls.count == 1, "Personal actions must never submit approval")
        await workspace.save(model, name: "Muse", permissions: [], days: 366, enabled: true)
        precondition(model.calls.count == 1)
        model.handler = { _, _, _ in Data(${raw({ assistant })}.utf8) }
        await workspace.save(model, name: "Muse", permissions: ["minutes.read", "minutes.attest", "future.unknown"], days: 7, enabled: true)
        let saved = try JSONSerialization.jsonObject(with: model.calls.last!.2!) as! [String: Any]
        precondition(saved["permissions"] as! [String] == ["minutes.read"], "Personal or unknown actions cannot be granted")
        precondition(saved["expiresInDays"] as! Int == 7)
        await workspace.save(model, name: "Muse", permissions: ["minutes.read"], days: 365, enabled: true)
        let annual = try JSONSerialization.jsonObject(with: model.calls.last!.2!) as! [String: Any]
        precondition(annual["expiresInDays"] as! Int == 365 && workspace.accessDays == 365)
        precondition(annual["permissions"] as! [String] == ["minutes.read"])
        workspace.accessCommandExecution = true; workspace.accessSignatureExecution = true
        precondition(workspace.accessDirty, "Instruction settings participate in unsaved-change detection")
        model.handler = { _, _, _ in Data(${raw({ assistant: instructedAssistant })}.utf8) }
        await workspace.save(model, name: "Muse", permissions: ["minutes.read"], days: 350, enabled: true)
        let instructed = try JSONSerialization.jsonObject(with: model.calls.last!.2!) as! [String: Any]
        precondition(instructed["commandExecution"] as? Bool == true && instructed["signatureExecution"] as? Bool == true)
        precondition(workspace.accessCommandExecution && workspace.accessSignatureExecution && !workspace.accessDirty)
        model.handler = { _, _, _ in Data(${raw({ ...payload, assistant: instructedAssistant })}.utf8) }
        await workspace.load(model)
        precondition(workspace.accessDays == 350 && workspace.accessCommandExecution && workspace.accessSignatureExecution, "Refresh preserves remaining long-lived access and saved delegation")
        let authorized = try JSONDecoder().decode(AssistantRequest.self, from: Data(${raw({...request,status:'authorized',authorization:{source:'owner_delegation',actorType:'assistant'}})}.utf8))
        precondition(!workspace.canApprove(authorized) && authorized.authorization != nil)
        model.handler = { _, _, _ in Data(${raw({request:{...request,status:'declined'}})}.utf8) }
        await workspace.decide(authorized, decision: "decline", note: "Cancel this instruction", model: model)
        precondition(workspace.requests[0].status == "declined", "The owner can cancel an instructed change before execution")
        model.handler = { _, _, _ in Data(${raw({ request: { ...request, status: 'approved' } })}.utf8) }
        await workspace.decide(regular, decision: "approve", note: "Exact synthetic review", model: model)
        let decision = try JSONSerialization.jsonObject(with: model.calls.last!.2!) as! [String: Any]
        precondition(model.calls.last!.0 == "/api/assistant/requests/REQ%2FONE/decision")
        precondition(decision["fingerprint"] as? String == "SYNTHETIC-FINGERPRINT")
        precondition(workspace.requests[0].status == "approved")
        model.handler = { _, _, _ in Data(${raw({ request: { ...personal, status: 'declined' } })}.utf8) }
        await workspace.decide(personal, decision: "decline", note: "Not required", model: model)
        precondition(workspace.requests[1].status == "declined", "Personal review can be declined without delegated execution")
        let reviewedItem = workspace.attestations[0]
        model.handler = { _, _, _ in Data(${raw({attestations:payload.attestations})}.utf8) }
        let navigation = await workspace.review(reviewedItem, model: model)
        precondition(navigation?.recordId == "SYNTHETIC" && model.calls.last!.0 == "/api/assistant/attestations", "Open review must fetch the current personal queue first")
        model.handler = { _, _, _ in Data(${raw({attestations:[{...payload.attestations[0],revision:'changed-revision',attestationText:'Changed current statement'}]})}.utf8) }
        let changedReview = await workspace.review(reviewedItem, model: model)
        precondition(changedReview == nil && workspace.attestations[0].revision == .string("changed-revision"), "Changed queue wording/revision must be reviewed again")
        model.handler = { _, _, _ in workspaceBytes }
        await workspace.load(model)
        model.handler = { path, _, _ in path.hasPrefix("/api/assistant/requests/") ? Data(${raw({request:personal})}.utf8) : Data(${raw({attestations:payload.attestations})}.utf8) }
        let personalNavigation = await workspace.reviewPersonalRequest(personal, model: model)
        precondition(personalNavigation?.recordId == "SYNTHETIC" && model.calls.last!.0 == "/api/assistant/attestations", "Personal requests must resolve their current attestation before navigation")
        workspace.accessName = "Unsaved Muse"; workspace.accessPermissions = ["draft.change"]; workspace.accessDays = 12
        workspace.accessCommandExecution = true; workspace.accessSignatureExecution = true
        precondition(workspace.accessDirty)
        let beforeDirtyToken = model.calls.count
        await workspace.createToken(model)
        precondition(model.calls.count == beforeDirtyToken && workspace.issuedToken == nil, "Unsaved grants must not issue a token under old policy")
        model.handler = { _, _, _ in workspaceBytes }
        await workspace.load(model)
        precondition(workspace.accessName == "Unsaved Muse" && workspace.accessPermissions == ["draft.change"] && workspace.accessDays == 12 && workspace.accessDirty, "Refresh/navigation must preserve the access draft")
        precondition(workspace.accessCommandExecution && workspace.accessSignatureExecution, "Refresh cannot replace unsaved instruction settings")
        await workspace.load(model, discardAccessDraft: true)
        precondition(!workspace.accessDirty && workspace.accessName == "Muse" && workspace.accessPermissions == ["minutes.read"], "Only an explicit discard replaces access edits")
        precondition(!workspace.accessCommandExecution && !workspace.accessSignatureExecution, "Discard restores both saved instruction settings")
        model.handler = { _, _, _ in Data(${raw({ assistant, token: 'SYNTHETIC-ONE-TIME-TOKEN' })}.utf8) }
        await workspace.createToken(model)
        precondition(workspace.issuedToken?.value == "SYNTHETIC-ONE-TIME-TOKEN")
        precondition(model.calls.last!.0 == "/api/assistant/access/token" && model.calls.last!.1 == "POST")
        var held: CheckedContinuation<Data, Error>?
        model.handler = { _, _, _ in try await withCheckedThrowingContinuation { held = $0 } }
        let lateToken = Task { await workspace.createToken(model) }
        while held == nil { await Task.yield() }
        workspace.leave()
        held!.resume(returning: Data(${raw({ assistant, token: 'SYNTHETIC-LEFT-TOKEN' })}.utf8)); await lateToken.value
        precondition(workspace.issuedToken == nil && !workspace.busy, "Leaving access must not reveal a late-created token")
        held = nil
        let lateAccountToken = Task { await workspace.createToken(model) }
        while held == nil { await Task.yield() }
        model.assistantAccountContext = "synthetic-account-two"; workspace.configure(model)
        held!.resume(returning: Data(${raw({ assistant, token: 'SYNTHETIC-STALE-TOKEN' })}.utf8))
        await lateAccountToken.value
        precondition(workspace.issuedToken == nil && workspace.assistant == nil && !workspace.busy)
        held = nil
        let lateLoad = Task { await workspace.load(model) }
        while held == nil { await Task.yield() }
        model.assistantAccountContext = "synthetic-account-three"; workspace.configure(model)
        held!.resume(returning: workspaceBytes); await lateLoad.value
        precondition(!workspace.loaded && workspace.capabilities.isEmpty)
        model.handler = { _, _, _ in Data("{\\"ok\\":true}".utf8) }
        await workspace.revoke(model)
        precondition(model.calls.last!.1 == "DELETE" && workspace.assistant == nil)
        let count = model.calls.count
        model.user = User(id: 2, role: "secretary"); model.assistantAccountContext = "synthetic-non-owner"
        await workspace.load(model); await workspace.createToken(model)
        precondition(model.calls.count == count && workspace.issuedToken == nil)
        print("PASS: native assistant decoding, grants, current-queue review, preserved access edits, saved-policy token lifecycle, exact approval, personal-action denial and late-result isolation")
    }
}
`);
  const compile = spawnSync('swiftc', ['-parse-as-library', swiftFile, '-o', binary], { encoding: 'utf8' });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  console.log(run.stdout.trim());
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
