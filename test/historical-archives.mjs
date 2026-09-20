import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { PDFDocument } from 'pdf-lib';
import { connect, initSchema, dbRun, dbGet, close } from '../db.js';
import { mountArchiveRoutes } from '../archive-routes.js';

delete process.env.DATABASE_URL; delete process.env.PGLITE_DIR;
await connect(); await initSchema();
const pdf = await PDFDocument.create(); pdf.addPage([300,400]); const bytes = Buffer.from(await pdf.save());
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
await dbRun(`INSERT INTO users (email,password_hash,name,role,created_at) VALUES (?,?,?,?,?)`,['archive@example.test','x','Archive Officer','officer',new Date().toISOString()]);
await dbRun(`INSERT INTO historical_reports
  (id,kind,title,record_date,original_name,original_mime,original_bytes,rendered_pdf_bytes,original_sha256,rendered_sha256,source_label,evidence_status,imported_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,['archive-minute','minutes','Meeting Minutes, January 1, 2024','2024-01-01','minutes.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',Buffer.from('original'),bytes,crypto.createHash('sha256').update('original').digest('hex'),digest,'Stone Square Brothers archive','historical_archive',new Date().toISOString()]);
await dbRun(`INSERT INTO historical_reports
  (id,kind,title,record_date,original_name,original_mime,original_bytes,rendered_pdf_bytes,original_sha256,rendered_sha256,source_label,evidence_status,imported_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,['archive-treasury','treasury','Treasurer Report, January 1, 2024','2024-01-01','treasury.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',Buffer.from('treasury-original'),bytes,crypto.createHash('sha256').update('treasury-original').digest('hex'),digest,'Stone Square Brothers archive','historical_archive',new Date().toISOString()]);

const app=express();let user={id:1,role:'officer',permissions:['minutes.view','treasury.view']};
mountArchiveRoutes(app,{requireAuth:(req,_res,next)=>{req.user=user;next();}});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
try {
  let response=await fetch(`${base}/api/archives/minutes`);assert.equal(response.status,200);const list=await response.json();assert.equal(list.records.length,1);assert.equal(list.records[0].title,'Meeting Minutes, January 1, 2024');assert.equal('rendered_pdf_bytes' in list.records[0],false);assert.equal('original_bytes' in list.records[0],false);
  response=await fetch(`${base}/api/archives/minutes/archive-minute/pdf`);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^inline/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  response=await fetch(`${base}/api/archives/treasury/archive-minute/pdf`);assert.equal(response.status,404);
  response=await fetch(`${base}/api/archives/treasury/archive-treasury/pdf`);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^inline/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  const audit=await dbGet(`SELECT action,details_json FROM audit_events WHERE action='historical_report_viewed' AND details_json::jsonb ->> 'archiveId'='archive-treasury'`);assert.equal(audit.action,'historical_report_viewed');
  user={id:1,role:'member',roster_id:1,permissions:[]};response=await fetch(`${base}/api/archives/minutes`);assert.equal(response.status,200);
  user={id:1,role:'viewer',permissions:[]};response=await fetch(`${base}/api/archives/minutes`);assert.equal(response.status,403);
  console.log('PASS: historical archives are separated by type, permission protected, metadata only in lists, and served inline inside the Dashboard.');
} finally { await new Promise(resolve=>server.close(resolve));await close(); }
