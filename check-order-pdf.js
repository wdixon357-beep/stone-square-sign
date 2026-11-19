import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const navy = rgb(.043, .145, .247);
const gold = rgb(.79, .635, .23);
const ink = rgb(.12, .16, .21);
const gray = rgb(.38, .42, .47);
const offices = {
  secretary: 'Secretary',
  assistant_secretary: 'Assistant Secretary',
  treasurer: 'Treasurer',
  assistant_treasurer: 'Assistant Treasurer',
};
const statuses = {
  awaiting_secretaries: 'Awaiting both Secretary certifications',
  ready_for_treasurer: 'Ready for the Treasurer',
  payment_recorded: 'Check issued and recorded',
  filed: 'Filed in Lodge records',
  voided: 'Voided',
};
const eastern = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
});
const calendar = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const date = value => calendar.format(new Date(value + 'T12:00:00Z'));

let supportedCharacters;
export async function assertCheckOrderPdfText(values) {
  if (!supportedCharacters) {
    supportedCharacters = PDFDocument.create()
      .then(pdf => pdf.embedFont(StandardFonts.Helvetica))
      .then(font => new Set(font.getCharacterSet()));
  }
  const supported = await supportedCharacters;
  if (values.some(value => Array.from(value || '').some(char => !/^[\t\n ]$/.test(char) && !supported.has(char.codePointAt(0))))) {
    throw Object.assign(new Error('Some characters cannot be printed on a check order. Use plain text in the check details and PDF filename.'), { statusCode: 400 });
  }
}

const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function wholeWords(number) {
  if (number < 20) return ones[number];
  if (number < 100) return tens[Math.floor(number / 10)] + (number % 10 ? '-' + ones[number % 10] : '');
  const [scale, label] = [[1_000_000, 'million'], [1_000, 'thousand'], [100, 'hundred']].find(([value]) => number >= value);
  return wholeWords(Math.floor(number / scale)) + ' ' + label + (number % scale ? ' ' + wholeWords(number % scale) : '');
}

function writtenAmount(amount) {
  const [dollars, cents] = amount.split('.');
  const value = wholeWords(Number(dollars));
  return value[0].toUpperCase() + value.slice(1) + (dollars === '1' ? ' dollar and ' : ' dollars and ') + cents + '/100';
}

function wrap(value, font, width, size) {
  return String(value).split('\n').flatMap(paragraph => {
    const lines = [];
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = current ? current + ' ' + word : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        current = next;
        continue;
      }
      if (current) lines.push(current);
      current = '';
      for (const char of word) {
        if (font.widthOfTextAtSize(current + char, size) > width) {
          lines.push(current);
          current = '';
        }
        current += char;
      }
    }
    if (current || !lines.length) lines.push(current);
    return lines;
  });
}

export async function buildCheckOrderPdf(order, ownerSignature, officers) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Stone Square Lodge No. 22 Check Order ' + order.id);
  pdf.setAuthor('Stone Square Lodge No. 22');
  pdf.setCreationDate(new Date(order.requestedAt));
  pdf.setModificationDate(new Date(order.updatedAt));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const seal = await pdf.embedPng(await readFile(new URL('./assets/lodge-seal.png', import.meta.url)));
  let page;
  let y;

  function addPage() {
    page = pdf.addPage([612, 792]);
    page.drawRectangle({ x: 42, y: 700, width: 456, height: 52, color: navy });
    page.drawText('STONE SQUARE LODGE NO. 22', { x: 55, y: 731, font: bold, size: 14, color: rgb(1, 1, 1) });
    page.drawText('CHECK ORDER', { x: 55, y: 713, font: bold, size: 10, color: gold });
    page.drawImage(seal, { x: 512, y: 698, width: 58, height: 58 });
    page.drawText(statuses[order.status], { x: 42, y: 677, font: bold, size: 11, color: navy });
    page.drawText('Confidential Lodge financial record  |  Page ' + pdf.getPageCount(),
      { x: 42, y: 34, font: regular, size: 8, color: gray });
    page.drawText('Order ' + order.id, { x: 42, y: 22, font: regular, size: 8, color: gray });
    y = 650;
  }

  function room(height) {
    if (!page || y - height < 52) addPage();
  }

  function paragraph(value, { font = regular, size = 10, color = ink, x = 42, width = 528 } = {}) {
    for (const line of wrap(value, font, width, size)) {
      room(size + 4);
      page.drawText(line, { x, y, font, size, color });
      y -= size + 4;
    }
  }

  function heading(value) {
    room(48);
    y -= 7;
    paragraph(value, { font: bold, size: 11, color: navy });
    page.drawLine({ start: { x: 42, y: y + 6 }, end: { x: 570, y: y + 6 }, color: gold, thickness: 1 });
    y -= 7;
  }

  function detail(label, value) {
    room(31);
    paragraph(label, { font: bold, size: 9, color: navy });
    paragraph(value);
    y -= 5;
  }

  function detailPair(first, second) {
    const values = [first, second].map(([label, value]) => ({ label, lines: wrap(value, regular, 250, 10) }));
    const height = 18 + 14 * Math.max(...values.map(value => value.lines.length));
    room(height);
    values.forEach(({ label, lines }, column) => {
      const x = 42 + 267 * column;
      page.drawText(label, { x, y, font: bold, size: 9, color: navy });
      lines.forEach((line, lineIndex) => page.drawText(line, { x, y: y - 13 - 14 * lineIndex, font: regular, size: 10, color: ink }));
    });
    y -= height;
  }

  async function signatureRow(people) {
    const columns = people.map(person => ({
      ...person,
      nameLines: wrap(person.name, bold, 247, 9),
    }));
    const nameHeight = Math.max(...columns.map(person => person.nameLines.length)) * 11;
    room(54 + nameHeight);
    for (const [index, person] of columns.entries()) {
      const x = 42 + index * 267;
      page.drawText(person.office, { x, y, font: bold, size: 9, color: navy });
      if (person.signature) {
        const image = await pdf.embedPng(new Uint8Array(person.signature));
        const size = image.scaleToFit(190, 23);
        page.drawImage(image, { x, y: y - 28, ...size });
      } else {
        page.drawText(person.pending, { x, y: y - 21, font: regular, size: 9, color: gray });
      }
      page.drawLine({ start: { x, y: y - 31 }, end: { x: x + 247, y: y - 31 }, thickness: .5, color: gray });
      person.nameLines.forEach((line, lineIndex) => {
        page.drawText(line, { x, y: y - 44 - lineIndex * 11, font: bold, size: 9, color: ink });
      });
      if (person.signedAt) {
        page.drawText(eastern.format(new Date(person.signedAt)), { x, y: y - 44 - nameHeight, font: regular, size: 9, color: gray });
      }
    }
    y -= 55 + nameHeight;
  }

  addPage();
  detail('PAY TO THE ORDER OF', order.payee);
  detailPair(['REQUEST DATE', eastern.format(new Date(order.requestedAt))],
    ['AMOUNT', currency.format(order.amount) + '  |  ' + writtenAmount(order.amount)]);
  detail('REASON FOR PAYMENT', order.reason);
  if (order.category) {
    detailPair(['LODGE AUTHORIZATION REFERENCE', order.authorizationReference], ['BUDGET OR ACCOUNT CATEGORY', order.category]);
  } else {
    detail('LODGE AUTHORIZATION REFERENCE', order.authorizationReference);
  }
  if (order.supportingReference || order.supportingDocumentName) {
    detail('SUPPORTING RECORD', [order.supportingReference, order.supportingDocumentName].filter(Boolean).join('\n'));
  }

  heading('Order and certification');
  paragraph('The Worshipful Master requests the stated payment under the Lodge authorization recorded above. Both Secretaries certify the order before it is ready for the Treasurer.');
  y -= 7;
  await signatureRow([{
    office: 'Worshipful Master', name: order.requestedBy, signature: ownerSignature, signedAt: order.requestedAt,
  }]);
  await signatureRow(order.secretaries.map(person => ({
    office: offices[person.role], name: person.name, signedAt: person.signedAt,
    signature: officers.find(item => item.role === person.role)?.signature_bytes,
    pending: order.status === 'voided' ? 'Voided' : 'Certification pending',
  })));

  heading('Treasurer payment record');
  if (order.checkNumber) {
    detail('CHECK ISSUED', 'No. ' + order.checkNumber + '   |   ' + date(order.issuedOn) + '   |   ' + currency.format(order.amount));
    const signer = officers.find(person => ['treasurer', 'assistant_treasurer'].includes(person.role) && person.signed_at);
    await signatureRow([{
      office: offices[signer.role], name: signer.name, signature: signer.signature_bytes, signedAt: signer.signed_at,
    }]);
  } else {
    paragraph(order.status === 'voided' ? 'Order voided before a check was recorded.' : 'No check has been recorded.');
  }

  if (order.filedAt) {
    heading('Lodge records');
    detailPair(['LEDGER REFERENCE', order.ledgerReference],
      ['CHECK DELIVERY', order.deliveredOn ? date(order.deliveredOn) : 'Delivery date has not been recorded.']);
    const filed = order.filedBy + '   |   ' + eastern.format(new Date(order.filedAt));
    if (order.filingNotes) {
      detailPair(['FILED', filed], ['FILING NOTES', order.filingNotes]);
    } else {
      detail('FILED', filed);
    }
  }
  if (order.voidReason) {
    heading('Reason for voiding');
    paragraph(order.voidReason);
  }
  return pdf.save({ useObjectStreams: false });
}
