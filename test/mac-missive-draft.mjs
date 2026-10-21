import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = readFileSync(path.join(root, 'macos/Sources/StoneSquareSign/Views.swift'), 'utf8');
const view = views.slice(views.indexOf('struct DispensationSubmissionPacketView: View'), views.indexOf('struct PDFPreviewView: View'));
assert.ok(view.includes('if model.user?.role == "owner", let packet'), 'Owner-only content must be gated when the session changes.');
assert.ok(view.includes('guard !busy, model.user?.role == "owner", packet?.missiveDraft?.canRetrySafely == true'));
assert.ok(view.includes('if let url = draft.safeURL'), 'A draft link must pass the model validation.');
assert.ok(view.includes('if draft.canRetrySafely'), 'Retry must be limited to definite refusal or verifying an existing receipt.');
assert.ok(view.includes('Verify existing Missive draft'));
assert.ok(view.includes('packet?.missiveDraft?.canRetry = false'), 'Lost response plus unavailable readback must not allow a duplicate attempt.');
assert.ok(view.includes('model.submissionPacket(documentId: document.id)'), 'Lost responses require packet readback.');
assert.ok(view.includes('You choose when to send it in Missive.'));
assert.ok(view.includes('This earlier completed dispensation has no automatic draft request. No Missive draft has been created for it.'));
assert.ok(view.includes('Signing a dispensation does not send it to the District Deputy.'));
assert.ok(view.includes('Save supporting report PDF') && view.includes('Save dispensation PDF'));
assert.ok(!view.includes('.lineLimit(1)') && !view.includes('.truncationMode('), 'Packet labels and summary must not truncate.');
assert.ok(!view.includes('model.submitToDistrictDeputy') && !view.includes('model.resolveSubmission'));
assert.ok(view.includes('Text("Open Missive draft").fixedSize(horizontal: false, vertical: true)'));
console.log('PASS: native owner-only draft status, safe links, manual sending, retry guards, and wrapping source checks.');

if (process.platform !== 'darwin') {
  console.log('Native DTO executable checks require macOS.');
  process.exit(0);
}
const scratch = mkdtempSync(path.join(tmpdir(), 'sign-missive-model-'));
try {
  const source = path.join(scratch, 'checks.swift');
  const binary = path.join(scratch, 'checks');
  writeFileSync(source, `import Foundation
@main struct Checks {
 static func main() throws {
  let oldPacket = try JSONDecoder().decode(DispensationSubmissionPacket.self, from: Data(#"{"state":"disabled","automaticDeliveryEnabled":false,"report":null,"draft":null,"recipient":null,"message":"Off"}"#.utf8))
  precondition(oldPacket.missiveDraft == nil && oldPacket.canSaveSupportingReport)
  let link = "https://mail.missiveapp.com/#inbox/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  let ready = DispensationMissiveDraft(state: "drafted", subject: "Fixture summary", url: link)
  precondition(ready.safeURL?.absoluteString == link && !ready.canCreateAgain)
  precondition(ready.statusTitle == "Missive draft saved for your review")
  for state in ["not_requested", "pending", "creating", "uncertain", "awaiting_signature", "awaiting_report", "not_configured", "unknown"] {
   let draft = DispensationMissiveDraft(state: state, url: link, canRetry: true)
   precondition(draft.safeURL == nil && !draft.canCreateAgain)
   precondition(!draft.statusTitle.contains("saved for your review"))
  }
  precondition(DispensationMissiveDraft(state: "not_requested").statusTitle == "No Missive draft was requested")
  precondition(DispensationMissiveDraft(state: "failed", canRetry: true).canCreateAgain)
  precondition(!DispensationMissiveDraft(state: "failed", canRetry: false).canCreateAgain)
  let knownId = "11111111-1111-4111-8111-111111111111"
  precondition(DispensationMissiveDraft(state: "uncertain", draftId: knownId, canRetry: true).canVerifyExisting)
  precondition(!DispensationMissiveDraft(state: "uncertain", canRetry: true).canRetrySafely)
  precondition(!DispensationMissiveDraft(state: "failed", draftId: knownId, canRetry: true).canCreateAgain)
  for url in ["http://mail.missiveapp.com/", "javascript:alert(1)", "//mail.missiveapp.com/", "https://mail.missiveapp.com.evil.invalid/", "https://evil.invalid/", "https://username:password@mail.missiveapp.com/", "https://mail.missiveapp.com:444/", "https://missiveapp.com/", "not a URL", ""] {
   precondition(DispensationMissiveDraft(state: "drafted", url: url).safeURL == nil)
  }
  let packet = try JSONDecoder().decode(DispensationSubmissionPacket.self, from: Data(#"{"state":"sent","automaticDeliveryEnabled":false,"report":null,"draft":null,"recipient":null,"missiveDraft":{"state":"uncertain","canRetry":false}}"#.utf8))
  precondition(packet.state == "sent" && packet.statusTitle == "Email submission recorded")
  precondition(packet.missiveDraft?.state == "uncertain" && packet.missiveDraft?.canCreateAgain == false)
  print("PASS: native DTO backward compatibility, verified saved state, independent history and URL validation.")
 }
}
`);
  const build = spawnSync('swiftc', ['-parse-as-library', 'macos/Sources/StoneSquareSign/Models.swift', source, '-o', binary], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exitCode = 1;
  else process.exitCode = spawnSync(binary, [], { cwd: root, stdio: 'inherit' }).status ?? 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
