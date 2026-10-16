import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if (process.platform !== 'darwin') { console.log('Mac submission tests require macOS.'); process.exit(0); }
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views=readFileSync(path.join(root,'macos/Sources/StoneSquareSign/Views.swift'),'utf8');
const packetView=views.slice(views.indexOf('struct DispensationSubmissionPacketView: View'),views.indexOf('struct PDFPreviewView: View'));
const deliveryStatus=views.slice(views.indexOf('@ViewBuilder private var deliveryStatus:'),views.indexOf('@ViewBuilder private var compactActions:'));
const correctionNotice='Signature corrected. Earlier email history refers to the previous PDF.';
assert.ok(deliveryStatus.includes(correctionNotice),'Native document row must explain the corrected signature.');
assert.ok(deliveryStatus.indexOf(correctionNotice)<deliveryStatus.indexOf('if let sentAt = document.submittedAt'),'Correction notice must precede the earlier email submission record.');
assert.ok(deliveryStatus.includes('model.user?.role == "owner", let correctedAt = document.signatureCorrectedAt'),'Correction notice must use owner-only correction metadata.');
assert.ok(deliveryStatus.includes('Earlier PDF email submission recorded'),'The previous PDF email record must remain available with an accurate label.');
assert.ok(deliveryStatus.includes('.fixedSize(horizontal: false, vertical: true)')&&!deliveryStatus.includes('.lineLimit(1)'),'Correction and email history text must wrap.');
for(const forbidden of ['model.submitToDistrictDeputy','model.resolveSubmission','Retry email delivery','Attach report and send automatically','dashboard automatically emails']) {
 assert.ok(!packetView.includes(forbidden),`Native packet must not expose delivery control: ${forbidden}`);
}
for(const required of ['Automatic email sending is off','Save dispensation PDF','Save supporting report PDF','Save supporting report','Saving a report does not send an email.']) {
 assert.ok(packetView.includes(required),`Native manual review must retain: ${required}`);
}
console.log('PASS: native packet exposes manual review, archive and PDF saving with no email or retry controls');
const scratch=mkdtempSync(path.join(tmpdir(),'sign-submission-test-'));
try {
 const binary=path.join(scratch,'submission-test');
 const build=spawnSync('swiftc',['-parse-as-library','macos/Sources/StoneSquareSign/Models.swift','macos/Sources/StoneSquareSign/APIClient.swift','test/mac-submission.swift','-o',binary],{cwd:root,stdio:'inherit'});
 if(build.status!==0) process.exitCode=1;
 else process.exitCode=spawnSync(binary,[],{cwd:root,stdio:'inherit'}).status ?? 1;
} finally {rmSync(scratch,{recursive:true,force:true});}
