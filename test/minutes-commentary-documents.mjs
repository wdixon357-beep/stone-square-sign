import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {PDFParse} from 'pdf-parse';
import {normalizeMinutesDraft} from '../minutes.js';
import {documentSections,closingReviewIssues} from '../minutes-format.js';
import {omitClosingPrayerCommentary} from '../minutes-closing-commentary.js';
import {buildMinutesPdf} from '../minutes-pdf.js';
import {buildMinutesDocx} from '../minutes-document.js';
const caveat='The source does not establish that this was a closing prayer.';
const original={organizerVersion:5,meetingDate:'2026-10-15',closingTime:'9:00 PM',closingPrayerGiven:null,sections:[{heading:'Prayer and Closing',body:`- The Chaplain offered prayer for the listed concerns. ${caveat} No closing prayer was offered. The Lodge closed at 9:00 PM.`}],warnings:[caveat],sensitiveReview:[]};
const snapshot=JSON.stringify(original);
const textOf=async draft=>{
 const pdf=await buildMinutesPdf({draft,status:'draft'});const parser=new PDFParse({data:pdf});let pdfText;
 try{pdfText=(await parser.getText()).text;}finally{await parser.destroy();}
 const zip=await JSZip.loadAsync(await buildMinutesDocx({draft,status:'draft'}));
 return {pdfText,xml:await zip.file('word/document.xml').async('string')};
};
for(const closingFormatVersion of [1,2]){
 const captured=normalizeMinutesDraft({...original,closingFormatVersion});
 assert.match(JSON.stringify(captured.sections),/source does not establish/,'Unconditional normalizer must not rewrite signed snapshots');
 const rendered=await textOf(captured);
 for(const text of Object.values(rendered))assert.match(text,/source does not establish/,'Already-attested formats keep their exact original caveat');
 const editable=omitClosingPrayerCommentary(captured);
 assert.equal(editable.closingPrayerGiven,null,'No claim about a closing prayer is invented');
 assert.equal(closingReviewIssues(editable).length,1,'Missing closing-prayer answer remains preparer responsibility');
 assert.doesNotMatch(JSON.stringify(editable.sections),/source does not establish/);
 const preview=await textOf(editable);
 for(const text of Object.values(preview)){
  assert.doesNotMatch(text,/source does not establish/,'Current editable PDF/Word preview omits the requested commentary');
  assert.match(text,/Chaplain offered prayer for the listed concerns/);
  assert.match(text,/No closing prayer was offered/);
  assert.match(text,/9:00 PM/);
 }
 assert.ok(documentSections(editable).some(section=>section.body.includes('No closing prayer was offered')));
}
assert.equal(JSON.stringify(original),snapshot,'Original source and snapshots remain unchanged');
console.log('PASS: editable PDF/Word omit only requested closing commentary; captured version1/version2 rendering, adjacent facts and preparer field checks stay intact.');
