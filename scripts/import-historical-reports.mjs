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
const root = '/Users/williamdixon-saunders/LodgeHQ/vault/stone';
const minutesDir = path.join(root, 'Meeting_Minutes');
const treasuryDirs = [path.join(root, 'Treasurer_Finance'), path.join(root, 'Treasurer & Finance')];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const mime = ext => ({ '.pdf':'application/pdf', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[ext]);

const dateFromName = name => {
  const iso = name.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const padded = name.match(/(?:^|\D)0(\d{2})(\d{2})(20\d{2})(?:\D|$)/);
  if (padded) return `${padded[3]}-${padded[1]}-${padded[2]}`;
  const digits = name.match(/(?:^|\D)(0?[1-9]|1[0-2])(0?[1-9]|[12]\d|3[01])(20\d{2})(?:\D|$)/);
  if (digits) return `${digits[3]}-${digits[1].padStart(2,'0')}-${digits[2].padStart(2,'0')}`;
  const words = name.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})/i);
  if (!words) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  return `${words[3]}-${String(months.indexOf(words[1].toLowerCase())+1).padStart(2,'0')}-${words[2].padStart(2,'0')}`;
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
const treasuryDecision = name => /^STONE SQUARE LODGE financial report|^Stone Square Lodge Financial Report|^2026-09-01_Treasurers_Report_Jun-Jul-Aug_2026_AS_SUBMITTED/i.test(name)
  ? null : 'not identified as a Stone Square Lodge treasurer report';
const considered=[];
for(const name of (await fs.readdir(minutesDir)).sort())considered.push({kind:'minutes',file:path.join(minutesDir,name),reason:minuteDecision(name)});
for(const directory of treasuryDirs)for(const name of (await fs.readdir(directory)).sort())considered.push({kind:'treasury',file:path.join(directory,name),reason:treasuryDecision(name)});
considered.sort((a,b)=>a.file.localeCompare(b.file));

const selected=[];const exclusions=[];const duplicateGroups=[];const byHash=new Map();
for(const item of considered){
  const relativePath=path.relative(root,item.file);
  if(item.reason){exclusions.push({relativePath,reason:item.reason});continue;}
  const original=await fs.readFile(item.file);const originalSha256=hash(original);const key=`${item.kind}:${originalSha256}`;
  if(byHash.has(key)){const chosen=byHash.get(key);duplicateGroups.push({kind:item.kind,originalSha256,chosen:chosen.relativePath,duplicate:relativePath});exclusions.push({relativePath,reason:`byte-for-byte duplicate of ${chosen.relativePath}`});continue;}
  const name=path.basename(item.file),recordDate=dateFromName(name);const record={kind:item.kind,relativePath,recordDate,title:titleFor(item.kind,recordDate,name),originalSha256};
  byHash.set(key,record);selected.push(record);
}
const manifestBody={version:1,source:'Stone Square Brothers archive',selected,duplicateGroups,exclusions};
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

const { connect, initSchema, dbRun, close } = await import('../db.js');
await connect(); await initSchema();
let imported = 0; let skipped = 0;
try {
  for (const candidate of selected) {
    const file=path.join(root,candidate.relativePath),original=await fs.readFile(file),originalHash=hash(original);
    if(originalHash!==candidate.originalSha256)throw new Error(`Archive file changed after review: ${candidate.relativePath}`);
    const rendered = await renderPdf(file); await PDFDocument.load(rendered);
    const name = path.basename(file),recordDate = candidate.recordDate;
    const key = `${candidate.kind}:${originalHash}`;
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0,32);
    const result = await dbRun(`INSERT INTO historical_reports
      (id,kind,title,record_date,original_name,original_mime,original_bytes,rendered_pdf_bytes,
       original_sha256,rendered_sha256,source_label,evidence_status,imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (kind,original_sha256) DO NOTHING`,
      [id,candidate.kind,candidate.title,recordDate,name,mime(path.extname(name).toLowerCase()),original,rendered,originalHash,hash(rendered),'Stone Square Brothers archive','historical_archive',new Date().toISOString()]);
    if (result.changes) imported++; else skipped++;
  }
  console.log(JSON.stringify({manifestSha256:manifest.manifestSha256,selected:selected.length,imported,skipped}));
} finally { await close(); }
