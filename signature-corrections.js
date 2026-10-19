import crypto from 'node:crypto';
import { inflateSync } from 'node:zlib';
import UPNGModule from '@pdf-lib/upng';
import { PDFDocument, PDFName, PDFNumber, PDFDict, PDFArray, PDFRef, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

const UPNG = UPNGModule.default || UPNGModule;
const name = value => PDFName.of(value);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_PIXELS = 20_000_000;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class SignatureCorrectionError extends Error {
  constructor(code, message) { super(message); this.name = 'SignatureCorrectionError'; this.code = code; }
}
const fail = (code, message) => { throw new SignatureCorrectionError(code, message); };

function pngPixels(value, label) {
  const bytes = Buffer.from(value || []);
  if (bytes.length < 33 || bytes.length > 8_000_000 || !bytes.subarray(0, 8).equals(PNG_MAGIC) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') {
    fail('INVALID_SIGNATURE_PNG', `${label} must be a valid PNG image of at most 8 MB.`);
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS) fail('INVALID_SIGNATURE_PNG', `${label} has unsupported image dimensions.`);
  try {
    const decoded = UPNG.decode(bytes);
    const frames = UPNG.toRGBA8(decoded);
    if (frames.length !== 1) fail('INVALID_SIGNATURE_PNG', `${label} must be a single-frame PNG.`);
    const rgba = Buffer.from(frames[0]);
    if (rgba.length !== width * height * 4) throw new Error('Invalid pixel count');
    const rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height);
    for (let p = 0; p < alpha.length; p += 1) {
      rgba.copy(rgb, p * 3, p * 4, p * 4 + 3); alpha[p] = rgba[p * 4 + 3];
    }
    return { bytes, width, height, rgb, alpha, rgba };
  } catch (error) {
    if (error instanceof SignatureCorrectionError) throw error;
    fail('INVALID_SIGNATURE_PNG', `${label} could not be decoded as a PNG image.`);
  }
}

function flatePixels(stream, expectedLength) {
  if (!(stream instanceof PDFRawStream) || stream.dict.lookup(name('Filter')) !== name('FlateDecode') ||
      stream.dict.has(name('DecodeParms'))) throw new Error('Only ordinary pdf-lib Flate image streams are supported');
  const bytes = inflateSync(stream.contents, { maxOutputLength: expectedLength });
  if (bytes.length !== expectedLength) throw new Error('Unexpected decoded image size');
  return bytes;
}

function imagePixels(stream, context, width, height) {
  const dict = stream.dict;
  if (dict.lookup(name('ColorSpace')) !== name('DeviceRGB') ||
      dict.lookup(name('BitsPerComponent'), PDFNumber).asNumber() !== 8 ||
      dict.has(name('Decode')) || dict.has(name('Mask')) || dict.has(name('ImageMask'))) throw new Error('Unsupported image encoding');
  const rgb = flatePixels(stream, width * height * 3);
  let alpha = Buffer.alloc(width * height, 255);
  if (dict.has(name('SMask'))) {
    const mask = context.lookup(dict.get(name('SMask')));
    if (!(mask instanceof PDFRawStream) || mask.dict.lookup(name('Subtype')) !== name('Image') ||
        mask.dict.lookup(name('ColorSpace')) !== name('DeviceGray') ||
        mask.dict.lookup(name('Width'), PDFNumber).asNumber() !== width ||
        mask.dict.lookup(name('Height'), PDFNumber).asNumber() !== height ||
        mask.dict.lookup(name('BitsPerComponent'), PDFNumber).asNumber() !== 8 ||
        mask.dict.has(name('Mask')) || mask.dict.has(name('SMask'))) throw new Error('Unsupported alpha mask');
    const decode = mask.dict.lookup(name('Decode'));
    if (decode && (!(decode instanceof PDFArray) || decode.size() !== 2 ||
        decode.lookup(0, PDFNumber).asNumber() !== 0 || decode.lookup(1, PDFNumber).asNumber() !== 1)) throw new Error('Unsupported alpha decoding');
    alpha = flatePixels(mask, width * height);
  }
  return { rgb, alpha };
}

// Read only the narrow content syntax needed to identify XObject invocations.
// Strings and comments are skipped so a printed "/Image Do" is never evidence.
function invokedNames(bytes) {
  const input = Buffer.from(bytes).toString('latin1'), names = [];
  const delimiter = char => !char || /[\s()[\]<>\/%]/.test(char);
  let i = 0, previous = null;
  while (i < input.length) {
    if (/\s/.test(input[i])) { i += 1; continue; }
    if (input[i] === '%') { while (i < input.length && !/[\r\n]/.test(input[i])) i += 1; continue; }
    if (input[i] === '(') {
      let depth = 1; i += 1;
      while (i < input.length && depth) {
        if (input[i] === '\\') { i += 2; continue; }
        if (input[i] === '(') depth += 1;
        if (input[i] === ')') depth -= 1;
        i += 1;
      }
      if (depth) fail('UNSUPPORTED_SIGNATURE_PDF', 'A PDF content string is incomplete.');
      previous = null; continue;
    }
    if (input[i] === '<' && input[i + 1] !== '<') {
      const end = input.indexOf('>', i + 1);
      if (end === -1) fail('UNSUPPORTED_SIGNATURE_PDF', 'A PDF hexadecimal string is incomplete.');
      i = end + 1; previous = null; continue;
    }
    if (input[i] === '/') {
      let end = i + 1; while (!delimiter(input[end])) end += 1;
      previous = { name: input.slice(i + 1, end).replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) };
      i = end; continue;
    }
    if (delimiter(input[i])) { i += 1; previous = null; continue; }
    let end = i + 1; while (!delimiter(input[end])) end += 1;
    const token = input.slice(i, end);
    if (token === 'BI') fail('UNSUPPORTED_SIGNATURE_PDF', 'Inline PDF images require manual signature correction review.');
    if (token === 'Do' && previous?.name) names.push(previous.name);
    previous = null; i = end;
  }
  return names;
}

function usageFor(pdf, target) {
  const uses = [], context = pdf.context;
  const read = object => {
    object = context.lookup(object);
    if (!object) return Buffer.alloc(0);
    if (object instanceof PDFArray) return Buffer.concat(object.asArray().map(read).map(bytes => Buffer.concat([bytes, Buffer.from('\n')])));
    if (!(object instanceof PDFRawStream)) fail('UNSUPPORTED_SIGNATURE_PDF', 'A PDF content stream has an unsupported representation.');
    try { return Buffer.from(decodePDFRawStream(object).decode()); }
    catch { fail('UNSUPPORTED_SIGNATURE_PDF', 'A PDF content stream could not be decoded safely.'); }
  };
  const walk = (contents, resources, pageNumber, ancestors) => {
    if (!(resources instanceof PDFDict)) return;
    const xObjects = resources.lookup(name('XObject'));
    if (!(xObjects instanceof PDFDict)) return;
    for (const invoked of invokedNames(read(contents))) {
      const ref = xObjects.get(name(invoked)), object = context.lookup(ref);
      if (!(object instanceof PDFRawStream)) continue;
      if (ref instanceof PDFRef && ref.toString() === target.toString()) uses.push({ pageNumber, resourceName: invoked });
      if (object.dict.lookup(name('Subtype')) === name('Form')) {
        const key = ref?.toString();
        if (ancestors.size > 32 || ancestors.has(key)) fail('UNSUPPORTED_SIGNATURE_PDF', 'Recursive PDF forms require manual signature correction review.');
        walk(object, object.dict.lookup(name('Resources')) || resources, pageNumber, new Set([...ancestors, key]));
      }
    }
  };
  pdf.getPages().forEach((page, index) => walk(page.node.Contents(), page.node.Resources(), index + 1, new Set()));
  return uses;
}

const objectDigest = object => sha256(Buffer.from(object.toString(), 'latin1'));

/**
 * Correct one explicitly identified visual signature. This does not sign a
 * document, authorize delivery, update an attestation, or write any file/record.
 * Only ordinary pdf-lib RGB PNG stamps are accepted; ambiguity always fails.
 */
export async function replaceSignatureImage({ pdfBytes, oldSignaturePng, replacementSignaturePng, alignInkBottom = false }) {
  const original = Buffer.from(pdfBytes || []);
  if (!original.length || original.length > 30_000_000) fail('INVALID_SIGNATURE_PDF', 'The signed PDF must be non-empty and at most 30 MB.');
  const old = pngPixels(oldSignaturePng, 'The existing signature snapshot');
  const replacement = pngPixels(replacementSignaturePng, 'The replacement signature');
  if (old.width === replacement.width && old.height === replacement.height && old.rgba.equals(replacement.rgba)) {
    fail('SIGNATURE_UNCHANGED', 'The replacement signature has the same pixels as the existing signature.');
  }
  let pdf;
  try { pdf = await PDFDocument.load(original, { updateMetadata: false }); }
  catch { fail('INVALID_SIGNATURE_PDF', 'The signed PDF could not be opened safely.'); }
  const objects = pdf.context.enumerateIndirectObjects();
  const visited = new Set();
  const checkCryptographicSignature = candidate => {
    const object = candidate instanceof PDFRef ? pdf.context.lookup(candidate) : candidate;
    if (!object || visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFRawStream) { checkCryptographicSignature(object.dict); return; }
    if (object instanceof PDFDict) {
      if (object.has(name('ByteRange')) || (object.lookup(name('Type')) === name('Sig') && object.has(name('Contents')))) {
        fail('CRYPTOGRAPHIC_SIGNATURE_PRESENT', 'This PDF contains a cryptographic signature and cannot be changed by the visual signature correction helper.');
      }
      for (const [, child] of object.entries()) checkCryptographicSignature(child);
    }
    if (object instanceof PDFArray) for (const child of object.asArray()) checkCryptographicSignature(child);
  };
  for (const [, object] of objects) checkCryptographicSignature(object);
  const maskReferences = new Set(objects.map(([, object]) => object instanceof PDFRawStream ? object.dict.get(name('SMask')) : null)
    .filter(ref => ref instanceof PDFRef).map(ref => ref.toString()));
  const matches = []; let unsupported = false;
  for (const [ref, object] of objects) {
    if (maskReferences.has(ref.toString())) continue;
    if (!(object instanceof PDFRawStream) || object.dict.lookup(name('Subtype')) !== name('Image')) continue;
    // pdf-lib PNG color images are always RGB. Gray streams include old alpha
    // masks retained as harmless unreferenced objects after a correction.
    if (object.dict.lookup(name('ColorSpace')) === name('DeviceGray')) continue;
    const width = object.dict.lookup(name('Width')), height = object.dict.lookup(name('Height'));
    if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber) || width.asNumber() !== old.width || height.asNumber() !== old.height) continue;
    let pixels;
    try { pixels = imagePixels(object, pdf.context, old.width, old.height); }
    catch { unsupported = true; continue; }
    if (pixels.rgb.equals(old.rgb) && pixels.alpha.equals(old.alpha)) matches.push(ref);
  }
  if (!matches.length) fail(unsupported ? 'UNSUPPORTED_SIGNATURE_PDF' : 'SIGNATURE_IMAGE_NOT_FOUND',
    unsupported ? 'The existing signature cannot be verified in this PDF image encoding. No correction was made.' : 'No PDF image exactly matches the existing signature snapshot. No correction was made.');
  if (matches.length !== 1) fail('SIGNATURE_IMAGE_AMBIGUOUS', 'More than one PDF image exactly matches the existing signature. No correction was made.');
  const target = matches[0], uses = usageFor(pdf, target);
  if (uses.length !== 1) fail(uses.length ? 'SIGNATURE_IMAGE_AMBIGUOUS' : 'SIGNATURE_IMAGE_NOT_VISIBLE',
    uses.length ? 'The existing signature image is drawn more than once. No correction was made.' : 'The matching signature image is not drawn on a page. No correction was made.');
  const unchanged = new Map(objects.filter(([ref]) => ref.toString() !== target.toString()).map(([ref, object]) => [ref.toString(), objectDigest(object)]));
  const embedded = await pdf.embedPng(replacement.bytes); await embedded.embed();
  const scale = Math.min(old.width / replacement.width, old.height / replacement.height);
  const width = replacement.width * scale / old.width, height = replacement.height * scale / old.height;
  const inkBottom = image => {
    for (let row = image.height - 1; row >= 0; row--) for (let col = 0; col < image.width; col++) {
      const p = (row * image.width + col) * 4;
      if (image.rgba[p + 3] > 20 && Math.min(image.rgba[p], image.rgba[p + 1], image.rgba[p + 2]) < 230) {
        return (image.height - 1 - row) / image.height;
      }
    }
    fail('INVALID_SIGNATURE_PNG', 'A visible signature is required for signature-line alignment.');
  };
  const x = (1 - width) / 2;
  // Minutes position the original visible ink just above the signature line.
  // Translate only this image form to retain that ink edge with different padding.
  const y = alignInkBottom === true ? inkBottom(old) - inkBottom(replacement) * height : (1 - height) / 2;
  const box = alignInkBottom === true ? [0, Math.min(0, y), 1, Math.max(1, y + height)] : [0, 0, 1, 1];
  const number = value => Number(value.toFixed(10)).toString();
  const form = pdf.context.flateStream(Buffer.from(`q\n${number(width)} 0 0 ${number(height)} ${number(x)} ${number(y)} cm\n/WMReplacement Do\nQ\n`), {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: box,
    Resources: { XObject: { WMReplacement: embedded.ref } },
  });
  pdf.context.assign(target, form);
  const corrected = Buffer.from(await pdf.save({ updateFieldAppearances: false }));
  const verified = await PDFDocument.load(corrected, { updateMetadata: false });
  const actual = new Map(verified.context.enumerateIndirectObjects().map(([ref, object]) => [ref.toString(), objectDigest(object)]));
  for (const [ref, digest] of unchanged) {
    if (actual.get(ref) !== digest) fail('PDF_PRESERVATION_FAILED', 'A PDF object outside the signature changed. No correction should be stored.');
  }
  if (verified.getPageCount() !== pdf.getPageCount()) fail('PDF_PRESERVATION_FAILED', 'The corrected PDF page count changed. No correction should be stored.');
  return { pdfBytes: corrected, beforeSha256: sha256(original), afterSha256: sha256(corrected),
    oldSignatureSha256: sha256(old.bytes), replacementSignatureSha256: sha256(replacement.bytes),
    replacementCount: 1, imageReference: target.toString(), pageNumber: uses[0].pageNumber,
    oldImageSize: { width: old.width, height: old.height },
    replacementImageSize: { width: replacement.width, height: replacement.height },
    placement: { x, y, width, height, mode: alignInkBottom === true ? 'align-ink-bottom' : 'contain' } };
}
