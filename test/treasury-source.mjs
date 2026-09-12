import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { readTreasurySources } from '../treasury-source.js';
const pdf=await PDFDocument.create(),page=pdf.addPage([612,792]),font=await pdf.embedFont(StandardFonts.Helvetica);
const source='Period: August 2026\nChecking\nBeginning balance: $1,000.00\nEnding balance: $1,200.00\nDeposit: $200.00';
source.split('\n').forEach((line,i)=>page.drawText(line,{x:45,y:730-i*30,size:16,font}));
const bytes=Buffer.from(await pdf.save());
let result=await readTreasurySources([{originalname:'statement.pdf',buffer:bytes}], '');assert.match(result.text,/1,000.00/);assert.match(result.text,/1,200.00/);
const parser=new PDFParse({data:bytes});const image=(await parser.getScreenshot({desiredWidth:1500,imageDataUrl:false})).pages[0].data;await parser.destroy();
// Language data and OCR execute locally. No banking text is sent to a model service.
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('OCR must not make a network request');};
try { result=await readTreasurySources([{originalname:'bank-screenshot.png',buffer:Buffer.from(image)}]);assert.match(result.text,/1,000.00/);assert.match(result.text,/1,200.00/);assert.equal(result.notes.length,1); }
finally { globalThis.fetch=originalFetch; }
const scan=await PDFDocument.create(),p=scan.addPage([612,792]),img=await scan.embedPng(image);p.drawImage(img,{x:0,y:0,width:612,height:792});
result=await readTreasurySources([{originalname:'scanned-statement.pdf',buffer:Buffer.from(await scan.save())}]);assert.match(result.text,/1,200.00/);assert.match(result.notes.join(' '),/scan/);
await assert.rejects(()=>readTreasurySources([{originalname:'broken.png',buffer:Buffer.from('not an image')}]),/not a readable/);
console.log('Treasurer PDF, screenshot and scanned PDF extraction tests passed.');
