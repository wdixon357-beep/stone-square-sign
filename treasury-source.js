import path from 'node:path';
import { createRequire } from 'node:module';
import { PDFParse } from 'pdf-parse';
import { createWorker } from 'tesseract.js';
const require = createRequire(import.meta.url);
const { langPath } = require('@tesseract.js-data/eng');
let readingImage = false;

async function recognize(images) {
  if (readingImage) throw Object.assign(new Error('Another image is being read. Please try again shortly.'), { statusCode: 429 });
  readingImage = true;
  let worker, timer;
  try {
    const operation = async () => {
      worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none', logger: () => {} });
      const text = [];
      for (const image of images) text.push((await worker.recognize(image)).data.text);
      return text.join('\n');
    };
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Reading the image took too long. Try a clearer image or fewer pages.'), { statusCode: 408 })), 90000); })]);
  } finally { clearTimeout(timer); await worker?.terminate(); readingImage = false; }
}

export async function readTreasurySources(files = [], typed = '') {
  const pieces = [], notes = [], names = [];
  if (String(typed).trim()) { pieces.push(String(typed).trim()); names.push('Typed banking notes'); }
  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    names.push(path.basename(file.originalname));
    if (ext === '.txt') { pieces.push(file.buffer.toString('utf8')); continue; }
    if (['.png', '.jpg', '.jpeg'].includes(ext)) {
      const png = file.buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = file.buffer[0] === 255 && file.buffer[1] === 216;
      if (!png && !jpeg) throw Object.assign(new Error('The selected image is not a readable PNG or JPEG.'), { statusCode: 400 });
      pieces.push(await recognize([file.buffer])); notes.push(`${path.basename(file.originalname)} was read from an image. Check every amount against the source.`); continue;
    }
    if (ext !== '.pdf' || file.buffer.subarray(0, 5).toString() !== '%PDF-') throw Object.assign(new Error('Choose a PDF, PNG, JPG or TXT file.'), { statusCode: 400 });
    const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
    try {
      const result = await parser.getText();
      if (result.total > 20) throw Object.assign(new Error('Upload no more than 20 PDF pages at a time.'), { statusCode: 400 });
      for (const page of result.pages) {
        if (page.text.trim().length >= 30) pieces.push(page.text);
        else {
          const image = await parser.getScreenshot({ partial: [page.num], desiredWidth: 1800, imageDataUrl: false });
          pieces.push(await recognize(image.pages.map(p => p.data)));
          notes.push(`${path.basename(file.originalname)}, page ${page.num}, was read from a scan. Check its figures.`);
        }
      }
    } finally { await parser.destroy(); }
  }
  const text = pieces.join('\n\n').trim();
  if (text.length < 25) throw Object.assign(new Error('No usable banking information was found. Add typed notes or a clearer file.'), { statusCode: 400 });
  if (text.length > 180000) throw Object.assign(new Error('This source is too long. Use a single reporting period.'), { statusCode: 400 });
  return { text, names, notes };
}
