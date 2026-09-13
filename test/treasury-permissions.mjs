import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { PDFParse } from 'pdf-parse';

// Deliberately isolated PostgreSQL-compatible database and synthetic users only.
process.env.DATABASE_URL='';process.env.PGLITE_DIR='';process.env.NODE_ENV='test';
const {connect,close,initSchema,dbRun,dbGet}=await import('../db.js');
const {initTreasurySchema,mountTreasuryRoutes,treasuryAccess}=await import('../treasury-routes.js');
const {resolvePermissions}=await import('../access-control.js');
const {completeTreasuryFixture}=await import('./treasury.mjs');
let listener,checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS '+name);};
await connect();
try{
  await initSchema();await initTreasurySchema();
  const time=new Date().toISOString();
  async function user(name,role,permissions=null){const {lastID}=await dbRun('INSERT INTO users(email,password_hash,name,role,created_at,permissions_json) VALUES(?,?,?,?,?,?)',[name.toLowerCase()+'@example.org','synthetic-unused-hash',name,role,time,permissions===null?null:JSON.stringify(permissions)]);return lastID;}
  const owner=await user('Owner','owner'),preparer=await user('Preparer','treasury_preparer'),viewer=await user('Viewer','viewer',['treasury.view']),legacy=await user('Legacy','member'),disabled=await user('Disabled','member',[]);
  for(const id of [legacy,disabled])await dbRun('INSERT INTO treasury_upload_access(user_id,granted_by,granted_at) VALUES(?,?,?)',[id,owner,time]);
  await initTreasurySchema();
  check('Existing upload grant migrates when permissions were never selected',(await treasuryAccess(await dbGet('SELECT * FROM users WHERE id=?',[legacy])))==='upload');
  check('Explicit disabled permissions survive legacy grant migration',(await treasuryAccess(await dbGet('SELECT * FROM users WHERE id=?',[disabled])))===null);
  const legacyBefore=(await dbGet('SELECT permissions_json FROM users WHERE id=?',[legacy])).permissions_json;
  await initTreasurySchema();
  check('Legacy grant migration is idempotent',(await dbGet('SELECT permissions_json FROM users WHERE id=?',[legacy])).permissions_json===legacyBefore);
  const signature=Buffer.from((await readFile(new URL('./signature.b64',import.meta.url),'utf8')).trim(),'base64');
  const signed={...structuredClone(completeTreasuryFixture),remarks:'Immutable signed financial explanation.',sourceNames:['private-name.txt'],unmappedLines:['Source material excluded from reader list.'],extractionNotes:['Private extraction notes.']};
  const changed={...structuredClone(signed),remarks:'UNSIGNED MUTABLE WORKING CHANGE',accounts:signed.accounts.map((a,i)=>i? a:{...a,statementBalance:'99999.99'})};
  const id='synthetic-signed-report';
  await dbRun('INSERT INTO treasury_reports(id,draft_json,source_text,status,created_by_user_id,preparer_name,preparer_role,created_at,updated_at,submitted_json,preparer_attested_at,preparer_user_id,uploader_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,JSON.stringify(changed),'Private original bank material','ready_for_distribution',preparer,'Synthetic Preparer','treasury_preparer',time,time,JSON.stringify(changed),time,preparer,'Synthetic Uploader']);
  await dbRun('INSERT INTO treasury_attestations(id,report_id,phase,user_id,draft_json,signature_bytes,created_at) VALUES(?,?,?,?,?,?,?)',['synthetic-attestation',id,'preparer',preparer,JSON.stringify(signed),signature,time]);
  await dbRun('INSERT INTO treasury_reports(id,draft_json,source_text,status,created_by_user_id,preparer_name,preparer_role,created_at,updated_at,submitted_json,preparer_attested_at,preparer_user_id,uploader_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',['unsigned-status-marker',JSON.stringify(signed),'Private original','distributed',preparer,'Synthetic Preparer','treasury_preparer',time,time,JSON.stringify(signed),time,preparer,'Synthetic Uploader']);
  const app=express();app.use(express.json());
  const requireAuth=async(req,res,next)=>{try{const record=await dbGet('SELECT * FROM users WHERE id=?',[Number(req.headers['x-synthetic-user'])]);if(!record)return res.status(401).json({error:'Synthetic sign-in required.'});req.user={...record,permissions:resolvePermissions(record)};next();}catch(e){next(e);}};
  mountTreasuryRoutes(app,{requireAuth,rateLimit:()=> (_req,_res,next)=>next(),sendEmail:()=>{throw new Error('No email allowed');},baseUrl:()=>'',broadcast:()=>{},generationFor:()=>{throw new Error('No provider call allowed');}});
  app.use((e,_req,res,_next)=>res.status(e.statusCode||500).json({error:e.message}));
  listener=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  const base='http://127.0.0.1:'+listener.address().port;
  const api=(path,account=viewer,options={})=>fetch(base+path,{...options,headers:{'x-synthetic-user':String(account),...options.headers}});
  const records=await (await api('/api/treasury')).json();
  check('A final-looking status without a stored signature is excluded',records.reports.length===1&&records.reports[0].id===id);
  check('Final-reader list uses immutable attestation fields',records.reports[0].draft.remarks===signed.remarks&&records.reports[0].draft.accounts[0].statementBalance===signed.accounts[0].statementBalance);
  check('Final-reader list contains no original source or mutable draft',!JSON.stringify(records).includes('Private')&&!JSON.stringify(records).includes('UNSIGNED')&&records.reports[0].submittedDraft===null);
  for(const account of [viewer,preparer,owner]){
    const response=await api(`/api/treasury/${id}/pdf`,account);assert.equal(response.status,200);
    const parser=new PDFParse({data:new Uint8Array(await response.arrayBuffer())});let text;try{text=(await parser.getText()).text;}finally{await parser.destroy();}
    check('Signed PDF uses immutable attestation for synthetic user '+account,text.includes(signed.remarks)&&!text.includes('UNSIGNED MUTABLE WORKING CHANGE')&&!text.includes('99,999.99')&&text.includes('SIGNED TREASURER REPORT'));
  }
  check('Final-looking report without stored signature has no PDF',(await api('/api/treasury/unsigned-status-marker/pdf')).status===404);
  const preview=await api(`/api/treasury/${id}/preview`,preparer,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:changed})});
  const parser=new PDFParse({data:new Uint8Array(await preview.arrayBuffer())});let text;try{text=(await parser.getText()).text;}finally{await parser.destroy();}
  check('Signed preparer preview also ignores mutable drafts',text.includes(signed.remarks)&&!text.includes('UNSIGNED MUTABLE WORKING CHANGE'));
  const row=await dbGet('SELECT * FROM treasury_reports WHERE id=?',[id]),attestation=await dbGet('SELECT * FROM treasury_attestations WHERE report_id=?',[id]);
  check('Reads never mutate stored draft, submission or signature',row.draft_json===JSON.stringify(changed)&&row.submitted_json===JSON.stringify(changed)&&attestation.draft_json===JSON.stringify(signed)&&Buffer.from(attestation.signature_bytes).equals(signature));
  console.log(`${checks} treasury snapshot and migration checks passed.`);
}finally{if(listener)await new Promise(resolve=>listener.close(resolve));await close();}
