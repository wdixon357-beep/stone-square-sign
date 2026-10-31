import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const source = fs.readFileSync(path.join(root, 'macos/Sources/StoneSquareSign/AssistantSignatureAuthorization.swift'), 'utf8');
const access = fs.readFileSync(path.join(root, 'macos/Sources/StoneSquareSign/AssistantAccess.swift'), 'utf8');
const api = fs.readFileSync(path.join(root, 'macos/Sources/StoneSquareSign/APIClient.swift'), 'utf8');
assert.equal((access.match(/AssistantSignatureQueue\(\)/g) || []).length, 2);
assert.match(source, /Authorize and apply signature/);
assert.match(source, /SHA256\.hash\(data: bytes\)/);
assert.match(source, /reviewed\.matchesReview\(fresh\.request\)/);
assert.match(source, /attemptedRequestsByContext/);
assert.doesNotMatch(source, /UserDefaults|Keychain|NSWorkspace|ownerReviewed|URLSession|webSessionToken/);
assert.match(api, /func signatureAuthorizationPreview\(requestID: String\) async throws -> Data/);
if (process.platform !== 'darwin') { console.log('PASS: native signature source boundaries; compiled checks require macOS.'); process.exit(0); }

function pdf() {
  let text = '%PDF-1.4\n'; const offsets = [0];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', '<< /Length 63 >>\nstream\nBT /F1 16 Tf 40 730 Td (SYNTHETIC SIGNATURE REVIEW ONLY) Tj ET\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  // Derive the stream length rather than relying on the fixture text length.
  const stream = 'BT /F1 16 Tf 40 730 Td (SYNTHETIC SIGNATURE REVIEW ONLY) Tj ET\n';
  objects[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(text); text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
const bytes = pdf();
const item = {id:'SYNTHETIC/REQUEST', actionId:'minutes.attest', recordId:'SYNTHETIC-MINUTES', title:'Synthetic reviewed minutes', kind:'minutes', status:'pending', createdAt:'2026-10-31T20:00:00Z', expiresAt:'2099-11-01T00:00:00.000Z', artifactSHA256:crypto.createHash('sha256').update(bytes).digest('hex'), fingerprint:'SYNTHETIC-FINGERPRINT', statement:'I reviewed this exact synthetic document and authorize application of my saved signature.', effects:['Applies the saved signature.','Files this exact synthetic document.'], signingRole:'Worshipful Master', ready:true, reason:null, authorizationUrl:'https://example.invalid/?signatureRequest=SYNTHETIC', receipt:null};
const receipt = {authorizedBy:{userId:1,name:'Synthetic Owner'}, requestedBy:{assistantId:'SYNTHETIC-MUSE',name:'Muse'}, appliedBy:'system',recordId:item.recordId,actionId:item.actionId,completedAt:'2026-10-31T20:05:00Z',notificationState:'queued',notificationWarnings:[],automaticRetryAllowed:false};
const raw = x => `#"${JSON.stringify(x)}"#`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'signature-native-test-'));
const out = path.join(root, 'output/signature-authorization-build'); fs.mkdirSync(out,{recursive:true,mode:0o700});
try {
  const swift = path.join(scratch, 'tests.swift'), binary = path.join(scratch, 'tests');
  fs.writeFileSync(swift, `${source.slice(0,source.indexOf('// MARK: - Native signature views'))}
struct User { let id:Int; let role:String }
enum SyntheticFailure: Error { case responseLost }
@MainActor final class AppModel {
    var user:User? = User(id:1,role:"owner")
    var assistantAccountContext = UUID().uuidString
    var calls:[(String,String,Data?)] = []
    var previewCalls:[String] = []
    var handler: ((String,String,Data?) async throws -> Data)?
    var previewHandler: ((String) async throws -> Data)?
    func request<T:Decodable>(_ path:String, method:String="GET", body:Data?=nil) async throws -> T {
        calls.append((path,method,body)); return try JSONDecoder().decode(T.self,from:try await handler!(path,method,body))
    }
    func signatureAuthorizationPreview(requestID:String) async throws -> Data {
        previewCalls.append(requestID); return try await previewHandler!(requestID)
    }
}
@main struct SignatureNativeTests {
    @MainActor static func main() async throws {
        let original = Data(${raw(item)}.utf8), pdf = Data(base64Encoded:"${bytes.toString('base64')}")!
        let request = try JSONDecoder().decode(AssistantSignatureRequest.self,from:original)
        func payload(_ item:AssistantSignatureRequest) throws -> Data {
            // Fixtures always begin from the exact original server-shaped JSON.
            original
        }
        func response(_ changes:[String:Any] = [:]) throws -> Data {
            var object = try JSONSerialization.jsonObject(with:original) as! [String:Any]
            for (key,value) in changes { object[key] = value }
            return try JSONSerialization.data(withJSONObject:["request":object])
        }
        func list(_ changes:[String:Any] = [:]) throws -> Data {
            let envelope = try JSONSerialization.jsonObject(with:response(changes)) as! [String:Any]
            return try JSONSerialization.data(withJSONObject:["requests":[envelope["request"]!]])
        }
        func setup() async throws -> (AppModel,AssistantSignatureWorkspace) {
            let model=AppModel(), workspace=AssistantSignatureWorkspace()
            model.handler = { path,method,_ in precondition(method == "GET"); return try path.hasSuffix("signature-requests") ? list() : response() }
            model.previewHandler = { _ in pdf }
            await workspace.load(model); await workspace.inspect(workspace.requests[0],model:model)
            return (model,workspace)
        }
        let (model,workspace)=try await setup()
        precondition(workspace.previewVerified && workspace.preview == pdf && workspace.canConfirm())
        precondition(model.calls.allSatisfy { $0.1 == "GET" }, "Load and open must never sign")
        precondition(model.calls.last!.0 == "/api/assistant/signature-requests/SYNTHETIC%2FREQUEST")
        precondition(model.previewCalls == [request.id])
        precondition(!request.isActionable(at:Date(timeIntervalSince1970:4102444800)), "Expiry is enforced locally")
        let missingEffects=try JSONDecoder().decode(AssistantSignatureRequest.self,from:JSONSerialization.data(withJSONObject:(try JSONSerialization.jsonObject(with:response(["effects":[]])) as! [String:Any])["request"]!))
        precondition(!missingEffects.isActionable(), "The owner must see the action effects before authorization")
        for status in ["completed","processing","declined","expired","stale","uncertain","unknown"] {
            let blocked=try JSONDecoder().decode(AssistantSignatureRequest.self,from:JSONSerialization.data(withJSONObject:(try JSONSerialization.jsonObject(with:response(["status":status])) as! [String:Any])["request"]!))
            precondition(!blocked.isActionable(), "Only pending ready status can sign")
        }
        model.handler={ _,method,_ in precondition(method == "GET"); return try response(["statement":"Changed statement with the same fingerprint"])}
        await workspace.confirm(model)
        precondition(!workspace.canConfirm() && !workspace.previewVerified && model.calls.allSatisfy { $0.1 == "GET" }, "Changed exact wording blocks before POST")
        let (hashModel,hashWorkspace)=try await setup()
        hashModel.previewHandler={_ in Data("not the frozen PDF".utf8)}
        await hashWorkspace.inspect(hashWorkspace.requests[0],model:hashModel)
        precondition(!hashWorkspace.previewVerified && !hashWorkspace.canConfirm())
        let (invalidModel,invalidWorkspace)=try await setup()
        let invalid=Data("SYNTHETIC-NOT-A-PDF".utf8)
        let invalidHash=SHA256.hash(data:invalid).map { String(format:"%02x",$0) }.joined()
        invalidModel.handler={path,_,_ in try path.hasSuffix("signature-requests") ? list(["artifactSHA256":invalidHash]) : response(["artifactSHA256":invalidHash])}
        invalidModel.previewHandler={_ in invalid}
        await invalidWorkspace.inspect(invalidWorkspace.requests[0],model:invalidModel)
        precondition(!invalidWorkspace.canConfirm(), "Matching hash alone cannot establish a valid PDF")
        let (okModel,okWorkspace)=try await setup()
        okModel.handler={_,method,body in
            if method == "GET" { return try response() }
            let object=try JSONSerialization.jsonObject(with:body!) as! [String:Any]
            precondition(Set(object.keys) == ["fingerprint","consent"] && object["fingerprint"] as? String == request.fingerprint && object["consent"] as? Bool == true)
            return Data(${raw({request:{...item,status:'completed',ready:false,receipt}})}.utf8)
        }
        await okWorkspace.confirm(okModel)
        precondition(okWorkspace.selected?.status == "completed" && okWorkspace.selected?.receipt?.appliedBy == "system" && !okWorkspace.canConfirm())
        precondition(okWorkspace.selected?.receipt?.authorizedBy?.userId == 1)
        precondition(okWorkspace.selected?.receipt?.requestedBy?.name == "Muse")
        let afterSuccess=okModel.calls.count; await okWorkspace.confirm(okModel)
        precondition(okModel.calls.count == afterSuccess && okModel.calls.filter { $0.1 == "POST" }.count == 1)
        let (lostModel,lostWorkspace)=try await setup()
        let secondQueue=AssistantSignatureWorkspace()
        await secondQueue.load(lostModel); await secondQueue.inspect(secondQueue.requests[0],model:lostModel)
        lostModel.handler={_,method,_ in if method == "POST" { throw SyntheticFailure.responseLost }; return try response()}
        await lostWorkspace.confirm(lostModel)
        precondition(lostWorkspace.alreadySubmitted && !lostWorkspace.canConfirm() && lostWorkspace.message.contains("unverified"))
        let beforeSecondQueue=lostModel.calls.count; await secondQueue.confirm(lostModel)
        precondition(secondQueue.alreadySubmitted && lostModel.calls.count==beforeSecondQueue,"An already open second queue must share the attempted-request guard")
        await lostWorkspace.refreshOutcome(lostModel); await lostWorkspace.confirm(lostModel)
        precondition(lostModel.calls.filter { $0.1 == "POST" }.count == 1, "Lost outcome cannot automatically retry")
        let reopened=AssistantSignatureWorkspace()
        lostModel.handler={path,_,_ in try path.hasSuffix("signature-requests") ? list() : response()}
        await reopened.load(lostModel); await reopened.inspect(reopened.requests[0],model:lostModel)
        precondition(reopened.alreadySubmitted && !reopened.canConfirm(), "Navigation must preserve the attempted-request guard")
        let (raceModel,raceWorkspace)=try await setup()
        var held:CheckedContinuation<Data,Error>?
        raceModel.handler={_,_,_ in try await withCheckedThrowingContinuation { held=$0 }}
        let pending=Task { await raceWorkspace.confirm(raceModel) }
        while held == nil { await Task.yield() }
        raceModel.assistantAccountContext="SECOND-ACCOUNT"; raceWorkspace.configure(raceModel)
        held!.resume(returning:try response()); await pending.value
        precondition(raceWorkspace.selected == nil && raceWorkspace.preview == nil && raceModel.calls.filter { $0.1 == "POST" }.isEmpty, "A late preflight cannot sign for another account")
        let (lateModel,lateWorkspace)=try await setup(); held=nil
        lateModel.handler={_,method,_ in if method == "POST" { return try await withCheckedThrowingContinuation { held=$0 } }; return try response()}
        let posted=Task { await lateWorkspace.confirm(lateModel) }
        while held == nil { await Task.yield() }
        lateModel.assistantAccountContext="THIRD-ACCOUNT"; lateWorkspace.configure(lateModel)
        held!.resume(returning:Data(${raw({request:{...item,status:'completed',ready:false,receipt}})}.utf8)); await posted.value
        precondition(lateWorkspace.selected == nil && lateWorkspace.message.isEmpty, "A posted result cannot populate another account")
        let (roleModel,roleWorkspace)=try await setup(); let count=roleModel.calls.count
        roleModel.user=User(id:2,role:"secretary"); roleModel.assistantAccountContext="NONOWNER"
        await roleWorkspace.confirm(roleModel); await roleWorkspace.load(roleModel)
        precondition(roleModel.calls.count == count && roleWorkspace.selected == nil)
        let (declineModel,declineWorkspace)=try await setup()
        declineModel.handler={path,method,_ in if method == "GET" { return try response() }; precondition(path.hasSuffix("/decline")); return try response(["status":"declined","ready":false])}
        await declineWorkspace.decline(declineModel)
        precondition(declineWorkspace.selected?.status == "declined" && declineModel.calls.filter { $0.1 == "POST" }.count == 1)
        print("PASS: compiled native signature readiness, exact PDF hash and format, stale consent, one explicit confirmation, receipt actors, replay/lost-response guard, navigation, account epoch, role and decline isolation")
    }
}
`);
  const compiled=spawnSync('swiftc',['-parse-as-library',swift,'-o',binary],{encoding:'utf8'});
  assert.equal(compiled.status,0,`${compiled.stdout}\n${compiled.stderr}`);
  const run=spawnSync(binary,[],{encoding:'utf8'}); assert.equal(run.status,0,`${run.stdout}\n${run.stderr}`);
  console.log(run.stdout.trim());
  fs.writeFileSync(path.join(out,'native-state-tests.json'),JSON.stringify({at:new Date().toISOString(),passed:true,sourceSHA256:crypto.createHash('sha256').update(source).digest('hex'),network:false,installedApp:false,preferences:false,keychain:false,result:run.stdout.trim()},null,2),{mode:0o600});
} finally { fs.rmSync(scratch,{recursive:true,force:true}); }
