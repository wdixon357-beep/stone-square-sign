import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { initSchema } from '../db.js';

const root=mkdtempSync(path.join(tmpdir(),'ss22-migration-'));const sourceDir=path.join(root,'source');const targetDir=path.join(root,'target');
const original=Buffer.from('preserved historical source bytes');const rendered=Buffer.from('%PDF-1.4 preserved historical preview bytes');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
try{
 const source=await PGlite.create({dataDir:sourceDir});await initSchema((sql,params=[])=>source.query(sql,params));
 await source.query(`INSERT INTO historical_reports
  (id,kind,title,record_date,original_name,original_mime,original_bytes,rendered_pdf_bytes,original_sha256,rendered_sha256,source_label,evidence_status,imported_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,['history-1','minutes','Historical minutes','2024-01-01','source.docx','application/docx',original,rendered,sha(original),sha(rendered),'Archive','historical_archive',new Date().toISOString()]);await source.close();
 const result=spawnSync(process.execPath,['migrate.mjs','--from',sourceDir,'--to',`pglite:${targetDir}`],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/historical_reports\.history-1\.original_bytes/);assert.match(result.stdout,/historical_reports\.history-1\.rendered_pdf_bytes/);
 const target=await PGlite.create({dataDir:targetDir});const {rows}=await target.query('SELECT original_bytes,rendered_pdf_bytes FROM historical_reports WHERE id=$1',['history-1']);await target.close();
 assert.equal(sha(rows[0].original_bytes),sha(original));assert.equal(sha(rows[0].rendered_pdf_bytes),sha(rendered));
 console.log('PASS: database migration preserves and hash verifies historical source and rendered PDF bytes.');
}finally{rmSync(root,{recursive:true,force:true});}
