import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, rgb } from 'pdf-lib';
import UPNGModule from '@pdf-lib/upng';
import { replaceSignatureImage } from '../signature-corrections.js';

const UPNG = UPNGModule.default || UPNGModule;
const n = value => PDFName.of(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function image(width, height, color, opaque = false) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba.set([...color, opaque ? 255 : ((x + 2 * y) % 5 === 0 ? 128 : (x % 4 === y % 4 ? 255 : 0))], offset);
  }
  return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0));
}
const old = image(80, 20, [25, 40, 60]);
const replacement = image(60, 40, [0, 60, 230]);
const secretary = image(80, 20, [20, 90, 20]);
const seal = image(30, 30, [200, 150, 20]);
async function make({ twice = false, sameObjectTwice = false, orphan = false, opaque = false, nested = false, cryptographic = false, directCryptographic = false, unsupported = false } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const source = opaque ? image(80, 20, [25, 40, 60], true) : old;
  const wm = await doc.embedPng(source);
  const second = await doc.embedPng(secretary);
  const badge = await doc.embedPng(seal);
  page.drawRectangle({ x: 20, y: 170, width: 570, height: 80, color: rgb(0.95, 0.9, 0.8) });
  page.drawText('Event: Lodge community dinner, 7:00 PM. These drawn details must survive.', { x: 24, y: 730, size: 11 });
  page.drawText('Motion carried. Secretary signed. Do not replace this text.', { x: 24, y: 700, size: 11 });
  if (!orphan && !nested) page.drawImage(wm, { x: 40, y: 200, width: 160, height: 40 });
  if (orphan) {
    await wm.embed();
    page.node.setXObject(n('UnusedWM'), wm.ref);
    page.node.addContentStream(doc.context.register(doc.context.flateStream(Buffer.from('(Printed /UnusedWM Do) Tj\n% /UnusedWM Do\n'))));
  }
  if (nested) {
    await wm.embed();
    const form = doc.context.flateStream(Buffer.from(`/OldWM Do\n`), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { XObject: { OldWM: wm.ref } },
    });
    const ref = doc.context.register(form);
    page.node.setXObject(n('Nested'), ref);
    const content = doc.context.register(doc.context.flateStream(Buffer.from('q\n160 0 0 40 40 200 cm\n/Nested Do\nQ\n')));
    page.node.addContentStream(content);
  }
  if (twice) page.drawImage(await doc.embedPng(source), { x: 40, y: 100, width: 160, height: 40 });
  if (sameObjectTwice) page.drawImage(wm, { x: 40, y: 100, width: 160, height: 40 });
  page.drawImage(second, { x: 300, y: 200, width: 160, height: 40 });
  page.drawImage(badge, { x: 500, y: 700, width: 50, height: 50 });
  page.drawLine({ start: { x: 35, y: 195 }, end: { x: 220, y: 195 } });
  const field = doc.getForm().createTextField('MeetingDate'); field.setText('October 15, 2026');
  field.addToPage(page, { x: 30, y: 600, width: 200, height: 25 });
  doc.addPage([400, 500]).drawText('The second page must also remain unchanged.', { x: 20, y: 400, size: 11 });
  if (cryptographic) doc.context.register(doc.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30], Contents: 'placeholder' }));
  if (directCryptographic) doc.catalog.set(n('NestedSignature'), doc.context.obj({ FT: 'Sig', V: { Type: 'Sig', ByteRange: [0, 10, 20, 30], Contents: 'placeholder' } }));
  if (unsupported) { await wm.embed(); doc.context.lookup(wm.ref).dict.set(n('DecodeParms'), doc.context.obj({ Predictor: 15 })); }
  return { bytes: Buffer.from(await doc.save()), source };
}
async function snapshot(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return { doc, objects: new Map(doc.context.enumerateIndirectObjects().map(([ref, obj]) => [ref.toString(), hash(Buffer.from(obj.toString(), 'latin1'))])) };
}
const fix = (bytes, source = old) => replaceSignatureImage({ pdfBytes: bytes, oldSignaturePng: source, replacementSignaturePng: replacement });
const expectCode = code => error => error.code === code;

const before = await make();
const result = await fix(before.bytes);
assert.equal(result.replacementCount, 1);
assert.equal(result.beforeSha256, hash(before.bytes));
assert.equal(result.afterSha256, hash(result.pdfBytes));
assert.equal(result.oldSignatureSha256, hash(old));
assert.equal(result.replacementSignatureSha256, hash(replacement));
assert.equal(result.pageNumber, 1);
assert.deepEqual(result.placement, { x: 0.3125, y: 0, width: 0.375, height: 1, mode: 'contain' });
const original = await snapshot(before.bytes), corrected = await snapshot(result.pdfBytes);
assert.equal(corrected.doc.getPageCount(), 2);
assert.deepEqual(corrected.doc.getPages().map(page => page.getSize()), original.doc.getPages().map(page => page.getSize()));
assert.equal(corrected.doc.getForm().getTextField('MeetingDate').getText(), 'October 15, 2026');
for (const [ref, digest] of original.objects) if (ref !== result.imageReference) {
  assert.equal(corrected.objects.get(ref), digest, `Object ${ref} is untouched, including drawn event details, secretary signature, seal, and widget appearance.`);
}
const object = corrected.doc.context.enumerateIndirectObjects().find(([ref]) => ref.toString() === result.imageReference)[1];
assert.equal(object.dict.lookup(n('Subtype')), n('Form'));
assert.deepEqual(object.dict.lookup(n('BBox')).asArray().map(num => num.asNumber()), [0, 0, 1, 1]);
assert.match(Buffer.from(decodePDFRawStream(object).decode()).toString(), /0\.375 0 0 1 0\.3125 0 cm/);
const replacementImage = object.dict.lookup(n('Resources')).lookup(n('XObject')).lookup(n('WMReplacement'));
assert.ok(replacementImage instanceof PDFRawStream);
assert.equal(replacementImage.dict.lookup(n('Width')).asNumber(), 60);
assert.equal(replacementImage.dict.lookup(n('Height')).asNumber(), 40);
const replacementDecoded = new Uint8Array(UPNG.toRGBA8(UPNG.decode(replacement))[0]);
const imageRgb = Buffer.from(decodePDFRawStream(replacementImage).decode());
const mask = replacementImage.dict.lookup(n('SMask'));
const imageAlpha = Buffer.from(decodePDFRawStream(mask).decode());
for (let p = 0; p < imageAlpha.length; p += 1) {
  assert.deepEqual(imageRgb.subarray(p * 3, p * 3 + 3), Buffer.from(replacementDecoded.subarray(p * 4, p * 4 + 3)));
  assert.equal(imageAlpha[p], replacementDecoded[p * 4 + 3]);
}
await assert.rejects(fix(before.bytes, image(80, 20, [99, 1, 2])), expectCode('SIGNATURE_IMAGE_NOT_FOUND'));
await assert.rejects(fix(before.bytes, image(80, 20, [25, 40, 60], true)), expectCode('SIGNATURE_IMAGE_NOT_FOUND'));
await assert.rejects(fix((await make({ twice: true })).bytes), expectCode('SIGNATURE_IMAGE_AMBIGUOUS'));
await assert.rejects(fix((await make({ sameObjectTwice: true })).bytes), expectCode('SIGNATURE_IMAGE_AMBIGUOUS'));
await assert.rejects(fix((await make({ orphan: true })).bytes), expectCode('SIGNATURE_IMAGE_NOT_VISIBLE'));
await assert.rejects(fix((await make({ cryptographic: true })).bytes), expectCode('CRYPTOGRAPHIC_SIGNATURE_PRESENT'));
await assert.rejects(fix((await make({ directCryptographic: true })).bytes), expectCode('CRYPTOGRAPHIC_SIGNATURE_PRESENT'));
await assert.rejects(fix((await make({ unsupported: true })).bytes), expectCode('UNSUPPORTED_SIGNATURE_PDF'));
await assert.rejects(fix(Buffer.from('not a PDF')), expectCode('INVALID_SIGNATURE_PDF'));
await assert.rejects(fix(before.bytes, Buffer.from('not a PNG')), expectCode('INVALID_SIGNATURE_PNG'));
await assert.rejects(replaceSignatureImage({ pdfBytes: before.bytes, oldSignaturePng: old, replacementSignaturePng: old }), expectCode('SIGNATURE_UNCHANGED'));
await assert.rejects(fix(result.pdfBytes), expectCode('SIGNATURE_IMAGE_NOT_FOUND'));
const opaque = await make({ opaque: true });
assert.equal((await fix(opaque.bytes, opaque.source)).replacementCount, 1, 'Opaque PNG stamps are also supported.');
assert.equal((await fix((await make({ nested: true })).bytes)).replacementCount, 1, 'A signature inside a drawn form remains correctable.');
console.log('Signature correction checks passed: exact RGB/alpha identity, aspect-fit image replacement, unchanged pages/text/other signatures/seal/widgets, and fail-closed ambiguity/digital-signature guards.');
