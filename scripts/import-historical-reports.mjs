import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import dotenv from 'dotenv';

dotenv.config();
const productionConfirmed = process.argv.includes('--confirm-production');
if (process.argv.includes('--dry-run') && productionConfirmed) throw new Error('Choose either --dry-run or --confirm-production.');
const option = name => { const index=process.argv.indexOf(name); return index < 0 ? null : process.argv[index+1]; };
const manifestFile = option('--manifest') || option('--write-manifest');
const execute = promisify(execFile);
const sourceRoots = {
  brothersLibrary: '/Users/williamdixon-saunders/Library/CloudStorage/GoogleDrive-dixonsaunders.ads@gmail.com/My Drive/Lodge And Masonic/Stone Square Library',
  lodgeHQ: '/Users/williamdixon-saunders/LodgeHQ/vault/stone',
  mailTreasury2020: '/Users/williamdixon-saunders/Library/Mail/V10/F4938858-8F4B-4A58-AC3D-B766C2506034/Masonic Communications.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/6/6/3/Attachments',
  mailMinutes: '/Users/williamdixon-saunders/Library/Mail/V10/F4938858-8F4B-4A58-AC3D-B766C2506034',
  mailGrandSecretary: '/Users/williamdixon-saunders/Library/Mail/V10/418531F6-B10F-4AE9-9DE5-030F22489C23',
  mailImport: '/Users/williamdixon-saunders/Library/Mail/V10/F0ADE092-14F3-4630-A564-931197AFA646',
  datedArchive: '/Users/williamdixon-saunders/Library/Mobile Documents/com~apple~CloudDocs/_To Review/Dated Docs Archive 2015-2024',
  financialDesktop: '/Users/williamdixon-saunders/Library/CloudStorage/GoogleDrive-dixonsaunders.ads@gmail.com/My Drive/Financial/Mac Desktop',
  verifiedSentTreasury: '/Users/williamdixon-saunders/LodgeHQ/vault/stone/Treasurer & Finance/Verified Sent Reports',
};
const exactTreasuryMailFiles = [
  '366631/2/STONE SQUARE LODGE financial report 11192020.docx',
  '366628/2/STONE SQUARE LODGE financial report 12032020.docx',
  '366622/2/STONE SQUARE LODGE financial report 12172020.docx',
  '366614/2/STONE SQUARE LODGE financial report 01072021.docx',
  '366607/2/STONE SQUARE LODGE financial report 01212021.docx',
  '366569/2/STONE SQUARE LODGE financial report 03182021.docx',
  '366564/2/STONE SQUARE LODGE financial report 04012021.docx',
  '366553/2/STONE SQUARE LODGE Updated Financial Report 04152021.docx',
  '366536/2/STONE SQUARE LODGE financial report 05202021.docx'
];
const exactTreasurySentFiles = [
  ['Stone_Square_22_Treasurers_Report_June_2026.pdf','2026-06-30','Treasurer Report, June 2026'],
  ['Stone_Square_22_Treasurers_Report_July_2026.pdf','2026-07-31','Treasurer Report, July 2026'],
  ['Stone_Square_22_Treasurers_Report_August_2026.pdf','2026-08-31','Treasurer Report, August 2026'],
];
const exactMinutesFiles = [
  ['datedArchive','2021/02_04_2021.docx'],
  ['datedArchive','2021/06_17_2021.docx'],
  ['mailTreasury2020','366483/2/Stone Square Lodge Meeting Minutes September 2, 2021-Amended.docx'],
  ['mailTreasury2020','366391/2/Stone Square Lodge Meeting Minutes October 21, 2021.docx'],
  ['datedArchive','2022/05_19_2022.docx'],
  ['datedArchive','2023/09_07_2023.pdf'],
  ['datedArchive','2023/12_21_2023.pdf'],
  ['datedArchive','2024/09_19_2024.docx','Source retains a stale May 16 header; verified as September 19 minutes.'],
  ['datedArchive','2024/10_03_2024.pdf'],
  ['mailGrandSecretary','Grand Secretary Maurice Mobley.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/2/6/3/Attachments/362328/2/Stone Square Lodge Meeting Minutes December 5, 2024.pdf'],
  ['mailGrandSecretary','Grand Secretary Maurice Mobley.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/2/6/3/Attachments/362320/2/Stone Square Lodge Meeting Minutes January 16 2025.pdf'],
  ['financialDesktop','Stone Square Lodge Meeting Minutes 03:20:2025 PDF.pdf'],
  ['mailGrandSecretary','Grand Secretary Maurice Mobley.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/2/6/3/Attachments/362283/2/Stone Square Lodge Meeting Minutes April 17 2025.pdf'],
  ['mailMinutes','Meeting Minutes.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/7/6/3/Attachments/367187/2/ Stone Square Lodge Meeting Minutes Jan. 15, 2026.pdf'],
  ['mailImport','Import.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/4/7/3/Attachments/374214/2/Stone Square Lodge Meeting Minutes February 5, 2026.pdf'],
  ['mailMinutes','Meeting Minutes.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/7/6/3/Attachments/367181/2/ Stone Square Lodge Meeting Minutes Feb. 19, 2026.docx'],
  ['mailMinutes','Meeting Minutes.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/7/6/3/Attachments/367177/2/ Stone Square Lodge Meeting Minutes April 02, 2026.docx'],
  ['mailMinutes','Meeting Minutes.mbox/04AB1D6C-2965-40BD-BFED-660937FCC4CC/Data/7/6/3/Attachments/367168/2/ Stone Square Lodge Meeting Minutes June 04, 2026.docx']
];
const sourcePath = candidate => path.join(sourceRoots[candidate.sourceKey], candidate.relativePath);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const mime = ext => ({ '.pdf':'application/pdf', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[ext]);

const dateFromName = name => {
  const iso = name.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const padded = name.match(/(?:^|\D)0(\d{2})(\d{2})(20\d{2})(?:\D|$)/);
  if (padded) return `${padded[3]}-${padded[1]}-${padded[2]}`;
  const digits = name.match(/(?:^|\D)(0?[1-9]|1[0-2])(0?[1-9]|[12]\d|3[01])(20\d{2})(?:\D|$)/);
  if (digits) return `${digits[3]}-${digits[1].padStart(2,'0')}-${digits[2].padStart(2,'0')}`;
  const separated = name.match(/(?:^|\D)(0?[1-9]|1[0-2])[.:_-](0?[1-9]|[12]\d|3[01])[.:_-](20\d{2})(?:\D|$)/);
  if (separated) return `${separated[3]}-${separated[1].padStart(2,'0')}-${separated[2].padStart(2,'0')}`;
  const words = name.match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(20\d{2})/i);
  if (!words) return null;
  const month = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12}[words[1].slice(0,3).toLowerCase()];
  return `${words[3]}-${String(month).padStart(2,'0')}-${words[2].padStart(2,'0')}`;
};
const titleFor = (kind, date, name) => {
  if (name.startsWith('2026-09-01_')) return 'Treasurer Report, June through August 2026';
  if (date) {
    const display = new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long',day:'numeric',year:'numeric'}).format(new Date(`${date}T00:00:00Z`));
    return `${kind === 'minutes' ? 'Meeting Minutes' : 'Treasurer Report'}, ${display}`;
  }
  return name.replace(/\.(pdf|docx|xlsx)$/i,'').replaceAll('_',' ');
};
const renderPdf = async file => {
  if (path.extname(file).toLowerCase() === '.pdf') return fs.readFile(file);
  const output = await fs.mkdtemp(path.join(os.tmpdir(),'ss22-archive-'));
  try {
    await execute('/opt/homebrew/bin/soffice',['--headless','--convert-to','pdf','--outdir',output,file],{timeout:120000});
    const files = await fs.readdir(output); const pdf = files.find(item => item.toLowerCase().endsWith('.pdf'));
    if (!pdf) throw new Error(`LibreOffice did not render ${path.basename(file)}.`);
    return await fs.readFile(path.join(output,pdf));
  } finally { await fs.rm(output,{recursive:true,force:true}); }
};

const minuteDecision = name => {
  if (!/\.(docx|pdf)$/i.test(name)) return 'unsupported file type';
  if (/^\d{2} - /.test(name)) return 'future blank meeting template';
  if (/District/i.test(name)) return 'First District record, not Stone Square Lodge minutes';
  if (/Committee/i.test(name)) return 'committee record, not Lodge meeting minutes';
  if (/DRAFT|Possible Duplicate|_2\.docx$/i.test(name)) return 'draft or alternate copy';
  if (['Stone Square Lodge Meeting Minutes October 6 2022.docx','Stone Square Lodge Meeting Minutes September 15 2022.docx'].includes(name)) return 'alternate filename copy';
  return /^Stone Square Lodge (?:Meeting|Occasional|Round ?Table|\(Zoom\))|^Stone_Square_22_Minutes_2026-06-18\.docx$/i.test(name) ? null : 'not identified as Stone Square Lodge meeting minutes';
};
const treasuryDecision = name => {
  if (/^2026-09-01_Treasurers_Report_Jun-Jul-Aug_2026_AS_SUBMITTED/i.test(name)) {
    return 'superseded by the three verified monthly PDFs sent September 3, 2026';
  }
  return /^STONE SQUARE LODGE financial report|^Stone Square Lodge Financial Report/i.test(name)
    ? null : 'not identified as a Stone Square Lodge treasurer report';
};
const considered=[];
const addDirectory = async (sourceKey, relativeDir, kind, decision = () => null) => {
  const directory = path.join(sourceRoots[sourceKey], relativeDir);
  for (const name of (await fs.readdir(directory)).sort()) considered.push({sourceKey,kind,relativePath:path.join(relativeDir,name),reason:decision(name)});
};
// Verified exact supplements take priority over fallback copies in the Brothers library.
for (const [sourceKey,relativePath,sourceNote] of exactMinutesFiles) considered.push({sourceKey,kind:'minutes',relativePath,sourceNote,reason:null});
for (const relativePath of exactTreasuryMailFiles) considered.push({sourceKey:'mailTreasury2020',kind:'treasury',relativePath,reason:null});
for (const [relativePath,recordDate,title] of exactTreasurySentFiles) considered.push({
  sourceKey:'verifiedSentTreasury',kind:'treasury',relativePath,recordDate,title,
  sourceNote:'Verified sent email 374399; presented September 3, 2026',reason:null,
});
// The existing Brothers-facing library is the canonical historical collection, with audited exclusions.
await addDirectory('brothersLibrary','Meeting Minutes','minutes',name => {
  if (!/\.pdf$/i.test(name)) return 'unsupported file type';
  const invalid = {
    '2018-09-19 Stone Square No. 22 Minutes.pdf':'duplicates the September 6 minutes content',
    '2021-04-02 Stone Square No. 22 Minutes.pdf':'contains February 4 minutes',
    '2021-12-21 Stone Square No. 22 Minutes.pdf':'contains January 21 minutes',
    '2024-03-04 Stone Square No. 22 Minutes.pdf':'contains April 4 minutes already represented',
    '2025-09-09 Stone Square No. 22 Minutes.pdf':'belongs to Mount Zion Chapter No. 7',
    '2026-04-16 Stone Square No. 22 Minutes.pdf':'meeting notes without a verified final'
  };
  return invalid[name] || null;
});
await addDirectory('brothersLibrary','Treasurer & Finance (Officers Only)','treasury',name => {
  if (!/\.pdf$/i.test(name)) return 'unsupported file type';
  if (/Banquet Report/i.test(name)) return 'event report, not a regular treasurer report';
  return null;
});
await addDirectory('lodgeHQ','Meeting_Minutes','minutes',minuteDecision);
await addDirectory('lodgeHQ','Treasurer_Finance','treasury',treasuryDecision);
await addDirectory('lodgeHQ','Treasurer & Finance','treasury',treasuryDecision);

const selected=[];const exclusions=[];const duplicateGroups=[];const byHash=new Map();const byRecord=new Map();
for(const item of considered){
  const descriptor=`${item.sourceKey}:${item.relativePath}`;
  if(item.reason){exclusions.push({sourceKey:item.sourceKey,relativePath:item.relativePath,reason:item.reason});continue;}
  const file=sourcePath(item),original=await fs.readFile(file),originalSha256=hash(original),name=path.basename(file),recordDate=item.recordDate || dateFromName(name);
  if (!recordDate) { exclusions.push({sourceKey:item.sourceKey,relativePath:item.relativePath,reason:'meeting date could not be verified'}); continue; }
  const month=Number(recordDate.slice(5,7));
  if (item.kind === 'minutes' && (month===7 || month===8)) { exclusions.push({sourceKey:item.sourceKey,relativePath:item.relativePath,reason:'July and August are outside the Lodge meeting season'}); continue; }
  const hashKey=`${item.kind}:${originalSha256}`;
  if(byHash.has(hashKey)){const chosen=byHash.get(hashKey);duplicateGroups.push({kind:item.kind,originalSha256,chosen:`${chosen.sourceKey}:${chosen.relativePath}`,duplicate:descriptor});exclusions.push({sourceKey:item.sourceKey,relativePath:item.relativePath,reason:`byte-for-byte duplicate of ${chosen.sourceKey}:${chosen.relativePath}`});continue;}
  const recordKey=`${item.kind}:${recordDate}`;
  if(byRecord.has(recordKey)){const chosen=byRecord.get(recordKey);duplicateGroups.push({kind:item.kind,recordDate,chosen:`${chosen.sourceKey}:${chosen.relativePath}`,duplicate:descriptor});exclusions.push({sourceKey:item.sourceKey,relativePath:item.relativePath,reason:`alternate copy for ${recordDate}; using ${chosen.sourceKey}:${chosen.relativePath}`});continue;}
  const record={sourceKey:item.sourceKey,kind:item.kind,relativePath:item.relativePath,recordDate,title:item.title || titleFor(item.kind,recordDate,name),originalSha256,...(item.sourceNote?{sourceNote:item.sourceNote}:{})};
  byHash.set(hashKey,record);byRecord.set(recordKey,record);selected.push(record);
}
selected.sort((a,b)=>a.kind.localeCompare(b.kind)||a.recordDate.localeCompare(b.recordDate));
const manifestBody={version:3,source:'Stone Square Brothers archive plus verified historical supplements',season:'Meeting minutes: September through June; treasurer reports may cover recess months',selected,duplicateGroups,exclusions};
const manifest={...manifestBody,manifestSha256:hash(Buffer.from(JSON.stringify(manifestBody)))};

if (!productionConfirmed) {
  if(manifestFile){await fs.mkdir(path.dirname(path.resolve(manifestFile)),{recursive:true});await fs.writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');}
  console.log(JSON.stringify({...manifest,dryRun:true,destination:'none'},null,2));
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error('--confirm-production requires an explicit DATABASE_URL.');
if (!manifestFile) throw new Error('--confirm-production requires the reviewed manifest path with --manifest.');
const reviewed=JSON.parse(await fs.readFile(manifestFile,'utf8'));
if(reviewed.manifestSha256!==manifest.manifestSha256||JSON.stringify(reviewed)!==JSON.stringify(manifest))throw new Error('The reviewed manifest does not match the current archive. Run the dry run and review it again.');

const { connect, initSchema, dbRun, dbGet, withTransaction, close } = await import('../db.js');
await connect(); await initSchema();
let imported = 0; let skipped = 0;
try {
  await withTransaction(async () => {
    for (const candidate of selected) {
      const file=sourcePath(candidate),original=await fs.readFile(file),originalHash=hash(original);
      if(originalHash!==candidate.originalSha256)throw new Error(`Archive file changed after review: ${candidate.relativePath}`);
      const rendered = await renderPdf(file); await PDFDocument.load(rendered);
      const name = path.basename(file),recordDate = candidate.recordDate;
      const existingDate = await dbGet(`SELECT id FROM historical_reports WHERE kind = ? AND record_date = ? LIMIT 1`,[candidate.kind,recordDate]);
      if (existingDate) { skipped++; continue; }
      const key = `${candidate.kind}:${originalHash}`;
      const id = crypto.createHash('sha256').update(key).digest('hex').slice(0,32);
      const result = await dbRun(`INSERT INTO historical_reports
        (id,kind,title,record_date,original_name,original_mime,original_bytes,rendered_pdf_bytes,
         original_sha256,rendered_sha256,source_label,evidence_status,imported_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (kind,original_sha256) DO NOTHING`,
        [id,candidate.kind,candidate.title,recordDate,name,mime(path.extname(name).toLowerCase()),original,rendered,originalHash,hash(rendered),candidate.sourceNote || 'Stone Square Brothers archive','historical_archive',new Date().toISOString()]);
      if (result.changes) imported++; else skipped++;
    }
  });
  console.log(JSON.stringify({manifestSha256:manifest.manifestSha256,selected:selected.length,imported,skipped}));
} finally { await close(); }
